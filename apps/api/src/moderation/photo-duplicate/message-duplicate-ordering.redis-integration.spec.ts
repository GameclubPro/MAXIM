import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { Queue, Worker } from 'bullmq';
import { raceWithTimeout } from '../../common/promise-timeout.util';
import { MessageDuplicateProcessor } from '../message-duplicate/message-duplicate.processor';
import {
  MessageDuplicateEnqueueService,
  MessageDuplicateOrderingStore,
  buildMessageDuplicateJobId,
  type MessageDuplicateJob,
} from '../message-duplicate/message-duplicate.queue';
import type { PhotoDuplicateOrderingIdentity } from './photo-duplicate-ordering.store';

const redisUrl = process.env.MAXIM_TEST_REDIS_URL ?? '';
const localRedis = /^redis:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/u.test(redisUrl);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

(localRedis ? describe : describe.skip)('duplicate ordering with actual Redis expiry', () => {
  let store: MessageDuplicateOrderingStore;
  let inspector: Redis;
  let chatId: string;
  let prefix: string;
  let identities: PhotoDuplicateOrderingIdentity[];

  beforeEach(() => {
    store = new MessageDuplicateOrderingStore(new ConfigService({ REDIS_URL: redisUrl }));
    inspector = new Redis(redisUrl);
    chatId = `ordering-test-${randomUUID()}`;
    prefix = `message-duplicate:ordering:v2:${hash(chatId).slice(0, 32)}`;
    identities = [];
  });

  afterEach(async () => {
    const prefixes = new Set([
      prefix,
      ...identities.map(
        ({ chatId: jobChatId }) => `message-duplicate:ordering:v2:${hash(jobChatId).slice(0, 32)}`,
      ),
    ]);
    await inspector.del(
      ...[...prefixes].flatMap((jobPrefix) =>
        ['pending', 'expiry', 'members', 'sequence', 'completed', 'lock', 'next-eligible'].map(
          (suffix) => `${jobPrefix}:${suffix}`,
        ),
      ),
      ...identities.map(
        ({ jobId, chatId: jobChatId }) =>
          `message-duplicate:ordering:v2:${hash(jobChatId).slice(0, 32)}:permit:${hash(jobId)}`,
      ),
    );
    await store.onModuleDestroy();
    await inspector.quit();
  });

  function identity(offset = 0): PhotoDuplicateOrderingIdentity {
    const value = {
      jobId: `message-duplicate__${hash(randomUUID())}`,
      chatId,
      sourceCreatedAt: new Date(Date.now() + offset).toISOString(),
      deadlineAtMs: Date.now() + 600_000,
    };
    identities.push(value);
    return value;
  }

  it('preserves an absorbing false after membership cleanup and permissive replay', async () => {
    const old = identity();
    await store.announce(old, true);
    await store.announce(old, false);
    await inspector.zadd(`${prefix}:expiry`, 1, old.jobId);
    await store.announce(identity(1000), true);
    expect(await inspector.hget(`${prefix}:members`, old.jobId)).toBeNull();
    await expect(store.announce(old, true)).resolves.toMatchObject({
      kind: 'registered',
      actionEligible: false,
    });
    expect(await store.readActionEligibility(old)).toBe(false);
  });

  it('revokes actions without registering a phantom pending head', async () => {
    const suppressed = identity();
    await store.revokeActionEligibility(suppressed);
    expect(await inspector.zcard(`${prefix}:pending`)).toBe(0);
    expect(await inspector.hget(`${prefix}:members`, suppressed.jobId)).toBeNull();
    const real = identity(1000);
    await store.announce(real, true);
    const operation = jest.fn();
    await store.runInOrder(real, true, operation);
    expect(operation).toHaveBeenCalledTimes(1);
    await expect(store.announce(suppressed, true)).resolves.toMatchObject({
      kind: 'registered',
      actionEligible: false,
    });
    expect(await store.readActionEligibility(suppressed)).toBe(false);
  });

  it('preserves original timestamps when revoking an existing completed permit', async () => {
    const job = identity();
    await store.announce(job, true);
    await store.runInOrder(job, true, async () => undefined);
    const key = `${prefix}:permit:${hash(job.jobId)}`;
    const before = await inspector.hmget(key, 'admittedAtMs', 'deadlineAtMs');
    await store.revokeActionEligibility(job);
    expect(await inspector.hmget(key, 'admittedAtMs', 'deadlineAtMs')).toEqual(before);
    expect(await store.readActionEligibility(job)).toBe(false);
    expect(await inspector.zcard(`${prefix}:pending`)).toBe(0);
  });

  it('preserves authority after completed ordering and accepts a later revoke', async () => {
    const job = identity();
    await store.announce(job, true);
    await store.runInOrder(job, true, async () => undefined);
    expect(await inspector.hget(`${prefix}:members`, job.jobId)).toBeNull();
    expect(await store.readActionEligibility(job)).toBe(true);
    await expect(store.announce(job, false)).resolves.toEqual({ kind: 'completed' });
    expect(await store.readActionEligibility(job)).toBe(false);
    await store.announce(job, true);
    expect(await store.readActionEligibility(job)).toBe(false);
  });

  it('never rebuilds positive authority from a retry after Redis permit loss', async () => {
    const job = identity();
    await store.announce(job, true);
    await inspector.del(`${prefix}:permit:${hash(job.jobId)}`);
    const seen: boolean[] = [];
    await store.runInOrder(job, true, async (lease, eligible) => {
      seen.push(eligible, await lease.resolveActionEligibility());
    });
    expect(seen).toEqual([false, false]);
    expect(await store.readActionEligibility(job)).toBe(false);
  });

  it('keeps abandonment terminal even when true is announced again', async () => {
    const job = identity();
    await store.announce(job, true);
    await store.abandon(job);
    await expect(store.announce(job, true)).resolves.toMatchObject({
      kind: 'registered',
      actionEligible: false,
    });
    expect(await store.readActionEligibility(job)).toBe(false);
  });

  it('uses one original deadline and denies after that deadline', async () => {
    const job = identity();
    const initial = await store.announce(job, true);
    const replay = await store.announce(
      { ...job, deadlineAtMs: job.deadlineAtMs! + 600_000 },
      true,
    );
    expect(replay).toEqual(initial);
    await inspector.hset(`${prefix}:permit:${hash(job.jobId)}`, 'deadlineAtMs', 1);
    expect(await store.readActionEligibility(job)).toBe(false);
    await expect(store.announce(job, true, 'retry')).resolves.toEqual({ kind: 'expired' });
  });

  it('settles an immediate replay of expired media without a job or renewed authority', async () => {
    const admittedAtMs = Date.now();
    const eventTimestampMs = admittedAtMs - 600_001;
    const messageId = randomUUID();
    const job = {
      jobId: buildMessageDuplicateJobId(chatId, messageId, eventTimestampMs),
      chatId,
      sourceCreatedAt: new Date(eventTimestampMs).toISOString(),
      deadlineAtMs: eventTimestampMs + 600_000,
    };
    identities.push(job);
    const durable = {
      register: jest
        .fn()
        .mockResolvedValueOnce({ registration: 'initial', admittedAtMs })
        .mockResolvedValue({ registration: 'retry', admittedAtMs }),
    };
    const queue = { add: jest.fn(), getJob: jest.fn().mockResolvedValue(null) };
    const enqueue = new MessageDuplicateEnqueueService(queue as never, store, durable as never);
    const input = {
      webhookEventId: 'expired-fixture',
      chatId,
      messageId,
      eventTimestampMs,
      sourceCreatedAt: job.sourceCreatedAt,
      controlRevision: 1,
      policyRevision: 0,
      settingsDigest: 'a'.repeat(64),
      actionEligible: true,
    };
    await enqueue.enqueue(input);
    await expect(enqueue.enqueue(input)).resolves.toBeUndefined();
    expect(queue.add).not.toHaveBeenCalled();
    expect(await store.readActionEligibility(job)).toBe(false);
    expect(await inspector.hget(`${prefix}:permit:${hash(job.jobId)}`, 'deadlineAtMs')).toBe(
      String(job.deadlineAtMs),
    );
    expect(await inspector.zcard(`${prefix}:pending`)).toBe(0);
  });

  it('defers followers until a paused head and recovers after its completion', async () => {
    const head = identity();
    const follower = identity(1000);
    await store.announce(head, true);
    await store.announce(follower, true);
    const nextEligibleAtMs = Date.now() + 180_000;
    await store.postpone(head, nextEligibleAtMs);
    const operation = jest.fn();
    await expect(store.runInOrder(follower, true, operation)).resolves.toEqual({
      kind: 'defer',
      reason: 'not_head',
      nextEligibleAtMs,
    });
    await expect(store.runInOrder(head, true, operation)).resolves.toEqual({
      kind: 'defer',
      reason: 'scheduled',
      nextEligibleAtMs,
    });
    expect(operation).not.toHaveBeenCalled();
    await inspector.hset(`${prefix}:next-eligible`, head.jobId, 1);
    await store.runInOrder(head, true, operation);
    await store.runInOrder(follower, true, operation);
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('recovers a dead head after its bounded pending expiry', async () => {
    const head = identity();
    const follower = identity(1000);
    await store.announce(head, true);
    await store.announce(follower, true);
    await inspector.zadd(`${prefix}:expiry`, 1, head.jobId);
    const operation = jest.fn();
    await store.runInOrder(follower, true, operation);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('advances inherited follower wakeups while preserving an explicit head pause', async () => {
    const first = identity();
    const second = identity(1000);
    await store.announce(first, true);
    await store.announce(second, true);
    const future = Date.now() + 180_000;
    await store.postpone(second, future, 'ordering');
    const firstResult = await store.runInOrder(first, true, async () => undefined);
    expect(firstResult.kind).toBe('completed');
    if (firstResult.kind !== 'completed') throw new Error('First turn did not complete');
    expect(firstResult.next).toMatchObject({ jobId: second.jobId });
    expect(firstResult.next!.nextEligibleAtMs).toBeLessThanOrEqual(Date.now());
    await store.postpone(second, future, 'head');
    await expect(store.postpone(second, Date.now() + 30_000, 'ordering')).resolves.toBe(future);
    const third = identity(-1000);
    await store.announce(third, true);
    const result = await store.runInOrder(third, true, async () => undefined);
    if (result.kind !== 'completed') throw new Error('Preceding turn did not complete');
    expect(result.next).toEqual({ jobId: second.jobId, nextEligibleAtMs: future });
  });

  it('keeps inherited recovery pacing while the current head lease is occupied', async () => {
    const head = identity();
    await store.announce(head, true);
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = store.runInOrder(head, true, async () => {
      entered();
      await held;
    });
    try {
      await raceWithTimeout({
        operation: started,
        timeoutMs: 10_000,
        onTimeout: () => {
          throw new Error('Head lease did not start within the bounded budget');
        },
      });
      const future = Date.now() + 30_000;
      await expect(store.postpone(head, future, 'ordering')).resolves.toBe(future);
    } finally {
      release();
      await running;
    }
  });

  it.each(['before_postpone', 'before_move'] as const)(
    'repairs an active follower promotion lost %s without a recovery-delay cascade',
    async (raceAt) => {
      const queueName = `test-ordering-active-promotion-${randomUUID()}`;
      const queue = new Queue<MessageDuplicateJob>(queueName, { connection: { url: redisUrl } });
      let enteredRace!: () => void;
      let releaseFollower!: () => void;
      let releaseHead!: () => void;
      let completedHead!: () => void;
      let completedFollower!: () => void;
      const entered = new Promise<void>((resolve) => {
        enteredRace = resolve;
      });
      const followerHeld = new Promise<void>((resolve) => {
        releaseFollower = resolve;
      });
      const headHeld = new Promise<void>((resolve) => {
        releaseHead = resolve;
      });
      const headCompleted = new Promise<void>((resolve) => {
        completedHead = resolve;
      });
      const followerCompleted = new Promise<void>((resolve) => {
        completedFollower = resolve;
      });
      const withinBudget = (operation: Promise<void>) =>
        raceWithTimeout({
          operation,
          timeoutMs: 10_000,
          onTimeout: () => {
            throw new Error('Active follower promotion retained an inherited recovery delay');
          },
        });
      const observed: string[] = [];
      const execution = {
        processMessageDuplicateJob: jest.fn(async (job: MessageDuplicateJob) => {
          observed.push(job.messageId);
          if (job.messageId === 'head') await headHeld;
        }),
      };
      const metrics = { record: jest.fn() };
      const processor = new MessageDuplicateProcessor(
        execution as never,
        store,
        metrics as never,
        queue,
      );
      const originalPostpone = store.postpone.bind(store);
      let intercepted = false;
      let worker: Worker<MessageDuplicateJob> | undefined;
      try {
        const at = Date.now() - 10_000;
        const jobs: MessageDuplicateJob[] = ['head', 'follower'].map((messageId, index) => {
          const eventTimestampMs = at + index;
          const sourceCreatedAt = new Date(eventTimestampMs).toISOString();
          const idempotencyKey = buildMessageDuplicateJobId('-900003', messageId, eventTimestampMs);
          identities.push({
            jobId: idempotencyKey,
            chatId: '-900003',
            sourceCreatedAt,
            deadlineAtMs: eventTimestampMs + 600_000,
          });
          return {
            version: 2,
            webhookEventId: `receipt-${messageId}`,
            chatId: '-900003',
            messageId,
            eventTimestampMs,
            sourceCreatedAt,
            createdAt: new Date().toISOString(),
            deadlineAtMs: eventTimestampMs + 600_000,
            settingsDigest: 'a'.repeat(64),
            controlRevision: 1,
            policyRevision: 0,
            actionEligible: true,
            idempotencyKey,
          };
        });
        jest.spyOn(store, 'postpone').mockImplementation(async (jobIdentity, nextAt, kind) => {
          if (jobIdentity.jobId !== jobs[1]!.idempotencyKey || kind !== 'ordering' || intercepted)
            return originalPostpone(jobIdentity, nextAt, kind);
          intercepted = true;
          const effectiveNextAt =
            raceAt === 'before_move'
              ? await originalPostpone(jobIdentity, nextAt, kind)
              : undefined;
          enteredRace();
          await followerHeld;
          return effectiveNextAt ?? originalPostpone(jobIdentity, nextAt, kind);
        });
        for (const [index, job] of jobs.entries()) {
          await store.announce(identities[index]!, true);
          await queue.add('compare', job, { jobId: job.idempotencyKey, attempts: 5 });
        }
        worker = new Worker<MessageDuplicateJob>(
          queueName,
          (job, token) => processor.process(job, token),
          { connection: { url: redisUrl }, concurrency: 2 },
        );
        worker.on('completed', (job) => {
          if (job.data.messageId === 'head') completedHead();
          else completedFollower();
        });
        await withinBudget(entered);
        const follower = await queue.getJob(jobs[1]!.idempotencyKey);
        expect(await follower!.getState()).toBe('active');
        releaseHead();
        await withinBudget(headCompleted);
        expect(metrics.record).toHaveBeenCalledWith('worker.wakeup_unavailable');
        expect(await follower!.getState()).toBe('active');
        releaseFollower();
        await withinBudget(followerCompleted);
        expect(observed).toEqual(['head', 'follower']);
        expect(execution.processMessageDuplicateJob.mock.calls[1]![0].actionEligible).toBe(true);
        expect(await queue.getJobCounts('delayed', 'active', 'waiting', 'failed')).toMatchObject({
          delayed: 0,
          active: 0,
          waiting: 0,
          failed: 0,
        });
      } finally {
        releaseHead();
        releaseFollower();
        await worker?.close();
        await queue.obliterate({ force: true });
        await queue.close();
      }
    },
  );

  it('drains ten warm jobs without a 30-second cascade and lets a quiet chat progress', async () => {
    const queueName = `test-ordering-throughput-${randomUUID()}`;
    const queue = new Queue<MessageDuplicateJob>(queueName, { connection: { url: redisUrl } });
    const admittedJobs = new Map<string, number>();
    const admission = {
      register: jest.fn(async ({ jobId }: { jobId: string }) => {
        const admittedAtMs = admittedJobs.get(jobId);
        if (admittedAtMs !== undefined) return { registration: 'retry', admittedAtMs };
        const now = Date.now();
        admittedJobs.set(jobId, now);
        return { registration: 'initial', admittedAtMs: now };
      }),
    };
    const enqueue = new MessageDuplicateEnqueueService(queue, store, admission as never);
    let enterHead!: () => void;
    let releaseHead!: () => void;
    let quietCompleted!: () => void;
    let allCompleted!: () => void;
    const entered = new Promise<void>((resolve) => {
      enterHead = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseHead = resolve;
    });
    const quiet = new Promise<void>((resolve) => {
      quietCompleted = resolve;
    });
    const complete = new Promise<void>((resolve) => {
      allCompleted = resolve;
    });
    const observed: string[] = [];
    const execution = {
      processMessageDuplicateJob: jest.fn(async (job: MessageDuplicateJob) => {
        observed.push(job.messageId);
        if (job.messageId === 'hot-0') {
          enterHead();
          await release;
        }
        if (job.messageId === 'quiet') quietCompleted();
      }),
    };
    const processor = new MessageDuplicateProcessor(execution as never, store, undefined, queue);
    const worker = new Worker<MessageDuplicateJob>(
      queueName,
      (job, token) => processor.process(job, token),
      { connection: { url: redisUrl }, concurrency: 2 },
    );
    let completed = 0;
    worker.on('completed', () => {
      completed += 1;
      if (completed === 11) allCompleted();
    });
    const withinBudget = (operation: Promise<void>) =>
      raceWithTimeout({
        operation,
        timeoutMs: 10_000,
        onTimeout: () => {
          throw new Error('Ordering throughput exceeded its bounded budget');
        },
      });
    try {
      const eventTimestampMs = Date.now() - 10_000;
      const inputs = Array.from({ length: 11 }, (_, index) => {
        const jobChatId = index === 10 ? '-900002' : '-900001';
        const messageId = index === 10 ? 'quiet' : `hot-${index}`;
        const at = eventTimestampMs + index;
        identities.push({
          jobId: buildMessageDuplicateJobId(jobChatId, messageId, at),
          chatId: jobChatId,
          sourceCreatedAt: new Date(at).toISOString(),
        });
        return {
          webhookEventId: `receipt-${index}`,
          chatId: jobChatId,
          messageId,
          eventTimestampMs: at,
          sourceCreatedAt: new Date(at).toISOString(),
          controlRevision: 1,
          policyRevision: 0,
          settingsDigest: 'a'.repeat(64),
          actionEligible: true,
        };
      });
      for (const input of inputs) await enqueue.enqueue(input);
      const jobs = await queue.getJobs(['delayed']);
      for (const job of jobs.sort((a, b) => a.data.eventTimestampMs - b.data.eventTimestampMs))
        await job.changeDelay(0);
      await withinBudget(entered);
      await withinBudget(quiet);
      expect(observed).toEqual(['hot-0', 'quiet']);
      releaseHead();
      await withinBudget(complete);
      expect(observed.filter((messageId) => messageId.startsWith('hot-'))).toEqual(
        Array.from({ length: 10 }, (_, index) => `hot-${index}`),
      );
      expect(await queue.getJobCounts('delayed', 'active', 'waiting', 'failed')).toMatchObject({
        delayed: 0,
        active: 0,
        waiting: 0,
        failed: 0,
      });
    } finally {
      releaseHead();
      await worker.close();
      await queue.obliterate({ force: true });
      await queue.close();
    }
  });
});
