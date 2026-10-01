import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { RedisCounterService } from '../src/moderation/redis-counter.service';
import {
  MessageRetentionRuntime,
  type MessageRetentionJob,
} from '../src/message-retention/message-retention-runtime.service';
import {
  MESSAGE_RETENTION_QUEUE,
  MESSAGE_RETENTION_QUEUE_LIMIT,
  MESSAGE_RETENTION_SLOT_IDS,
} from '../src/message-retention/message-retention.policy';

const redisUrl = process.env.MAXIM_TEST_REDIS_URL;
if (redisUrl) {
  const url = new URL(redisUrl);
  if (
    url.protocol !== 'redis:' ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.search ||
    url.hash
  )
    throw new Error('Retention queue tests require an explicit local Redis URL without options');
}

describe('retention scheduler with real isolated Redis and BullMQ', { skip: !redisUrl }, () => {
  const prefix = `retention-test-${randomUUID()}`;
  const runtimes: MessageRetentionRuntime[] = [];
  const connections: Redis[] = [];
  let queue: Queue<MessageRetentionJob>;
  let cleanup: Redis;
  before(async () => {
    cleanup = new Redis(redisUrl!, { maxRetriesPerRequest: 1, connectTimeout: 3000 });
    queue = new Queue<MessageRetentionJob>(MESSAGE_RETENTION_QUEUE, {
      connection: {
        host: cleanup.options.host,
        port: cleanup.options.port,
        db: cleanup.options.db,
        username: cleanup.options.username,
        password: cleanup.options.password,
        tls: cleanup.options.tls,
        maxRetriesPerRequest: 1,
      },
      prefix,
    });
    await queue.waitUntilReady();
    await queue.setGlobalConcurrency(1);
  });
  after(async () => {
    for (const runtime of runtimes) await runtime.onModuleDestroy();
    await queue.obliterate({ force: true });
    await queue.close();
    // FLAG: Never flush a Redis database. Remove only this test's random namespace.
    let cursor = '0';
    do {
      const [next, keys] = await cleanup.scan(cursor, 'MATCH', `${prefix}:*`, 'COUNT', 100);
      cursor = next;
      if (keys.length) await cleanup.unlink(...keys);
    } while (cursor !== '0');
    for (const connection of connections) await connection.quit();
    await cleanup.quit();
  });
  function producer(
    policies: Array<{ chatId: string; nextRunAt: Date; revision: number }>,
    loseLease = false,
  ) {
    const connection = new Redis(redisUrl!, {
      keyPrefix: `${prefix}:locks:`,
      maxRetriesPerRequest: 1,
      connectTimeout: 3000,
    });
    connections.push(connection);
    const locks = Object.assign(
      Object.create(RedisCounterService.prototype) as RedisCounterService,
      { redis: connection },
    );
    if (loseLease)
      Object.assign(locks, {
        acquireLock: async () => randomUUID(),
        renewLock: async () => true,
        releaseLock: async () => undefined,
      });
    const prisma = {
      messageRetentionPolicy: {
        findMany: async (input: {
          take: number;
          where: { nextRunAt: { lte: Date }; AND: Array<{ chatId?: { notIn?: string[] } }> };
        }) => {
          const queued = new Set(input.where.AND.flatMap((filter) => filter.chatId?.notIn ?? []));
          return policies
            .filter(
              (policy) =>
                policy.nextRunAt <= input.where.nextRunAt.lte && !queued.has(policy.chatId),
            )
            .slice(0, input.take)
            .map((policy) => ({ ...policy }));
        },
        updateMany: async (input: {
          where: { chatId: string; nextRunAt: Date; revision: number };
          data: { nextRunAt: Date };
        }) => {
          const policy = policies.find(
            (row) =>
              row.chatId === input.where.chatId &&
              row.revision === input.where.revision &&
              row.nextRunAt.getTime() === input.where.nextRunAt.getTime(),
          );
          if (policy) policy.nextRunAt = input.data.nextRunAt;
          return { count: policy ? 1 : 0 };
        },
      },
    };
    const runtime = new MessageRetentionRuntime(
      prisma as never,
      {
        mode: 'on',
        workSchedulingFilter: () => ({}),
        discoverLegacyReceipts: async () => undefined,
        purge: async () => undefined,
      } as never,
      {
        attemptRetentionIntent: async () => {
          throw new Error('Queue admission must never execute a MAX mutation');
        },
      } as never,
      { decide: async () => ({ action: 'run' }) } as never,
      locks,
      queue,
    );
    runtimes.push(runtime);
    return runtime;
  }
  const policies = () =>
    Array.from({ length: 200 }, (_, i) => ({
      chatId: String(-1 - i),
      nextRunAt: new Date(0),
      revision: 1,
    }));
  const ready = (runtime: MessageRetentionRuntime) =>
    Object.assign(runtime, { nextAdmissionAt: 0, nextMaintenanceAt: Date.now() + 60_000 });
  const jobs = () => queue.getJobs(['wait', 'active', 'delayed', 'prioritized'], 0, 199);

  it('serializes two real producers, keeps fixed slots, and re-admits due SQL work after losing queue data', async () => {
    const rows = policies();
    const first = producer(rows);
    const second = producer(rows);
    await Promise.all([first.tick(), second.tick()]);
    const admitted = await jobs();
    assert.equal(admitted.length, MESSAGE_RETENTION_QUEUE_LIMIT);
    assert.equal(new Set(admitted.map((job) => job.data.chatId)).size, admitted.length);
    assert(admitted.every((job) => MESSAGE_RETENTION_SLOT_IDS.includes(job.id!)));
    const original = new Set(admitted.map((job) => job.data.chatId));
    await queue.obliterate({ force: true });
    await queue.setGlobalConcurrency(1);
    ready(first);
    await first.tick();
    const recovered = await jobs();
    assert.equal(recovered.length, MESSAGE_RETENTION_QUEUE_LIMIT);
    assert(recovered.every((job) => !original.has(job.data.chatId)));
    assert.equal(new Set(recovered.map((job) => job.id)).size, MESSAGE_RETENTION_QUEUE_LIMIT);
    await queue.obliterate({ force: true });
    await queue.setGlobalConcurrency(1);
  });
  it('caps the queue even when two producers both believe their scheduler lease is valid', async () => {
    const rows = policies();
    const first = producer(rows, true);
    const second = producer(rows, true);
    await Promise.all([first.tick(), second.tick()]);
    const admitted = await jobs();
    assert(admitted.length > 0 && admitted.length <= MESSAGE_RETENTION_QUEUE_LIMIT);
    assert.equal(new Set(admitted.map((job) => job.data.chatId)).size, admitted.length);
    assert(admitted.every((job) => MESSAGE_RETENTION_SLOT_IDS.includes(job.id!)));
    await queue.obliterate({ force: true });
    await queue.setGlobalConcurrency(1);
  });
  it(
    'enforces one active BullMQ consumer globally across two workers',
    { timeout: 15_000 },
    async () => {
      const runtime = producer(policies());
      await runtime.tick();
      let active = 0;
      let maximum = 0;
      let completed = 0;
      let done!: () => void;
      let failed!: (error: Error) => void;
      const completion = new Promise<void>((resolve, reject) => {
        done = resolve;
        failed = reject;
      });
      const deadline = setTimeout(
        () => failed(new Error('BullMQ consumer test timed out')),
        10_000,
      );
      const workers = Array.from({ length: 2 }, () => {
        const connection = new Redis(redisUrl!, {
          maxRetriesPerRequest: null,
          connectTimeout: 3000,
        });
        connections.push(connection);
        const worker = new Worker(
          MESSAGE_RETENTION_QUEUE,
          async () => {
            active++;
            maximum = Math.max(maximum, active);
            await new Promise((resolve) => setTimeout(resolve, 5));
            active--;
            completed++;
            if (completed === 20) done();
          },
          {
            connection: {
              host: connection.options.host,
              port: connection.options.port,
              db: connection.options.db,
              username: connection.options.username,
              password: connection.options.password,
              tls: connection.options.tls,
              maxRetriesPerRequest: null,
            },
            prefix,
            concurrency: 8,
          },
        );
        worker.on('error', failed);
        return worker;
      });
      try {
        await completion;
        assert.equal(maximum, 1);
      } finally {
        clearTimeout(deadline);
        await Promise.all(workers.map((worker) => worker.close()));
      }
    },
  );
});
