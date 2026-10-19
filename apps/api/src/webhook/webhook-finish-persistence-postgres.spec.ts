import { randomUUID } from 'node:crypto';
import { Queue, QueueEvents, Worker, type Job } from 'bullmq';
import { Prisma, type WebhookEvent } from '../prisma/prisma-client';
import { WebhookFinishPersistenceError } from '../moderation/webhook-canonical-execution.service';
import type { WebhookCanonicalExecutionContext } from '../moderation/webhook-canonical-execution.service';
import { WebhookParser } from './webhook.parser';
import {
  LEGACY_WEBHOOK_QUEUE,
  type AnyWebhookQueueName,
  type ProcessWebhookJob,
} from './webhook-queues';
import { drainRuntimeWorkers } from '../runtime/runtime-worker-shutdown';
import {
  createMultibotHarness,
  type MultibotHarness,
} from './webhook-multibot-fullpath.spec-support';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const redisUrl = process.env.MAXIM_TEST_REDIS_URL?.trim() ?? '';
const describeStores = databaseUrl && redisUrl ? describe : describe.skip;
jest.setTimeout(60_000);

type FinishCheckpoint = {
  markExecutionHandlerFinished(context: WebhookCanonicalExecutionContext): Promise<void>;
};

type ExistingJobReconciliation = {
  handleExistingJob(
    event: WebhookEvent,
    job: Job<ProcessWebhookJob>,
    options?: { activationClaimed?: boolean; queueName?: AnyWebhookQueueName },
  ): Promise<string>;
};

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describeStores('native positive webhook finish persistence', () => {
  let h: MultibotHarness | undefined;
  afterEach(async () => {
    await h?.dispose();
    h = undefined;
  });

  it.each(['checkpoint', 'settlement'] as const)(
    'accepts crossed delayed-job reconciliation before positive finish %s without replay',
    async (phase) => {
      const s = (h = await createMultibotHarness({ databaseUrl, redisUrl, bots: 2, mode: 'on' }));
      await s.pause();
      const [chatId, independentChatId] = await s.seedCatalog(2);
      const id = await s.ingest({
        chatId: chatId!,
        messageId: randomUUID(),
        text: 'Fixture with a message exceeding the configured length limit',
        botId: s.bots[0]!.id,
      });
      await s.ingress.preparePersistedWebhookEvent(id);
      const original = await s.prisma.webhookEvent.update({
        where: { id },
        data: { status: 'QUEUED', queueName: LEGACY_WEBHOOK_QUEUE, queuedAt: new Date() },
      });
      expect(original.nextEnqueueAt).toBeNull();
      const delayedRead = signal();
      const resumeOutbox = signal();
      const atFinish = signal();
      const resumeFinish = signal();
      const queueName = `finish-enqueue-race-${randomUUID()}`;
      const redisAddress = new URL(redisUrl);
      const connection = { host: redisAddress.hostname, port: Number(redisAddress.port) };
      const queue = new Queue<ProcessWebhookJob>(queueName, { connection });
      const events = new QueueEvents(queueName, { connection });
      const worker = new Worker<ProcessWebhookJob>(
        queueName,
        (job) => s.moderation.processWebhookEvent(job.data.webhookEventId),
        { connection, concurrency: 1, autorun: false },
      );
      await Promise.all([queue.waitUntilReady(), events.waitUntilReady(), worker.waitUntilReady()]);
      const job = await queue.add('process', { webhookEventId: id }, { jobId: id, delay: 60_000 });
      const realState = job.getState.bind(job);
      const state = jest.spyOn(job, 'getState').mockImplementation(async () => {
        const observed = await realState();
        expect(observed).toBe('delayed');
        delayedRead.resolve();
        await resumeOutbox.promise;
        return observed;
      });
      const helper = s.canonical as unknown as FinishCheckpoint;
      const mark = helper.markExecutionHandlerFinished.bind(s.canonical);
      const checkpoint = jest
        .spyOn(helper, 'markExecutionHandlerFinished')
        .mockImplementation(async (context) => {
          if (context.webhookEvent.id !== id) return mark(context);
          expect(context.webhookEvent.nextEnqueueAt).toBeNull();
          if (phase === 'settlement') await mark(context);
          atFinish.resolve();
          await resumeFinish.promise;
          if (phase === 'checkpoint') await mark(context);
        });
      const handler = jest.spyOn(s.moderation, 'handleUpdate');
      const fail = jest.spyOn(s.canonical, 'failExecution');
      let running: Promise<void> | undefined;
      let reconciliation: Promise<string> | undefined;
      try {
        // FLAG: Read the real delayed Redis state, then let that exact job enter business
        // before the existing outbox SQL writer resumes with its stale scheduling snapshot.
        reconciliation = (s.outbox as unknown as ExistingJobReconciliation).handleExistingJob(
          original,
          job,
          { queueName: LEGACY_WEBHOOK_QUEUE },
        );
        await delayedRead.promise;
        await job.promote();
        running = worker.run();
        await atFinish.promise;
        expect(await realState()).toBe('active');
        const started = await s.prisma.webhookExecutionClaim.findFirstOrThrow({
          where: { webhookEventId: id, kind: 'EXECUTION' },
        });
        expect(started.businessStartedAt).toBeInstanceOf(Date);
        expect(started.commandResult).toEqual(
          phase === 'settlement' ? expect.objectContaining({ kind: 'EXECUTION_FINISHED' }) : null,
        );
        resumeOutbox.resolve();
        expect(await reconciliation).toBe('outstanding');
        const scheduled = await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id } });
        expect(scheduled).toMatchObject({
          status: 'QUEUED',
          normalizedPayload: original.normalizedPayload,
          executionDeadlineAt: original.executionDeadlineAt,
          processedAt: original.processedAt,
          errorMessage: original.errorMessage,
        });
        expect(scheduled.nextEnqueueAt!.getTime()).toBeGreaterThan(Date.now());
        const independentId = await s.ingest({
          chatId: independentChatId!,
          messageId: randomUUID(),
          text: 'Independent',
          botId: s.bots[0]!.id,
        });
        await s.ingress.preparePersistedWebhookEvent(independentId);
        await s.moderation.processWebhookEvent(independentId);
        expect(
          await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: independentId } }),
        ).toMatchObject({ status: 'PROCESSED' });
        resumeFinish.resolve();
        await job.waitUntilFinished(events, 10_000);
        expect(await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id } })).toMatchObject({
          status: 'PROCESSED',
          processedAt: expect.any(Date),
          nextEnqueueAt: null,
          queueName: null,
          executionDeadlineAt: original.executionDeadlineAt,
        });
        expect(
          await s.prisma.webhookExecutionClaim.findUniqueOrThrow({ where: { id: started.id } }),
        ).toMatchObject({ status: 'COMPLETED', commandResult: { kind: 'EXECUTION_FINISHED' } });
        const nextId = await s.ingest({
          chatId: chatId!,
          messageId: randomUUID(),
          text: 'Following',
          botId: s.bots[0]!.id,
        });
        await s.ingress.preparePersistedWebhookEvent(nextId);
        await s.moderation.processWebhookEvent(nextId);
        await s.moderation.processWebhookEvent(id);
        expect(
          await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: nextId } }),
        ).toMatchObject({ status: 'PROCESSED' });
        expect(
          handler.mock.calls.filter(([update]) => update.message?.chatId === chatId),
        ).toHaveLength(2);
        expect(
          checkpoint.mock.calls.filter(([context]) => context.webhookEvent.id === id),
        ).toHaveLength(1);
        expect(fail).not.toHaveBeenCalled();
        expect(s.effects.filter((effect) => effect.method === 'delete')).toHaveLength(1);
      } finally {
        resumeOutbox.resolve();
        resumeFinish.resolve();
        await reconciliation;
        await worker.close();
        await running;
        state.mockRestore();
        checkpoint.mockRestore();
        handler.mockRestore();
        fail.mockRestore();
        await events.close();
        await queue.obliterate({ force: true });
        await queue.close();
      }
    },
  );

  it('drains the real BullMQ worker while retaining a returned handler across its first native checkpoint lock timeout', async () => {
    const s = (h = await createMultibotHarness({ databaseUrl, redisUrl, bots: 2, mode: 'on' }));
    await s.pause();
    const [chatId, independentChatId] = await s.seedCatalog(2);
    const ownerId = await s.ingest({
      chatId: chatId!,
      messageId: randomUUID(),
      text: 'Fixture finish with a message exceeding the configured length limit',
      botId: s.bots[0]!.id,
    });
    const independentId = await s.ingest({
      chatId: independentChatId!,
      messageId: randomUUID(),
      text: 'Independent',
      botId: s.bots[0]!.id,
    });
    await s.ingress.preparePersistedWebhookEvent(ownerId);
    await s.ingress.preparePersistedWebhookEvent(independentId);
    const originalReceipt = await s.prisma.webhookEvent.findUniqueOrThrow({
      where: { id: ownerId },
    });
    const originalClaim = await s.prisma.webhookExecutionClaim.findFirstOrThrow({
      where: { webhookEventId: ownerId, kind: 'EXECUTION' },
    });
    const locked = signal();
    const release = signal();
    let blocker: Promise<unknown> | undefined;
    const realHandler = s.moderation.handleUpdate.bind(s.moderation);
    const handler = jest.spyOn(s.moderation, 'handleUpdate').mockImplementation(async (...args) => {
      await realHandler(...args);
      if (args[0].message?.chatId !== chatId) return;
      blocker = s.prisma.$transaction(async (tx) => {
        await tx.$queryRaw(
          Prisma.sql`SELECT id FROM webhook_execution_claims WHERE id = ${originalClaim.id} FOR UPDATE`,
        );
        locked.resolve();
        await release.promise;
      });
      await locked.promise;
    });
    const helper = s.canonical as unknown as FinishCheckpoint;
    const queueName = `finish-persistence-${randomUUID()}`;
    const redisAddress = new URL(redisUrl);
    const connection = { host: redisAddress.hostname, port: Number(redisAddress.port) };
    const queue = new Queue<{ webhookEventId: string }>(queueName, { connection });
    const events = new QueueEvents(queueName, { connection });
    const worker = new Worker<{ webhookEventId: string }>(
      queueName,
      (job) => s.moderation.processWebhookEvent(job.data.webhookEventId),
      { connection, concurrency: 1 },
    );
    await Promise.all([queue.waitUntilReady(), events.waitUntilReady(), worker.waitUntilReady()]);
    let shutdown: ReturnType<typeof drainRuntimeWorkers> | undefined;
    let drained = false;
    const mark = helper.markExecutionHandlerFinished.bind(s.canonical);
    const failures: unknown[] = [];
    let attempts = 0;
    let checkpointBackendPid = 0;
    const checkpoint = jest
      .spyOn(helper, 'markExecutionHandlerFinished')
      .mockImplementation(async (context) => {
        if (context.webhookEvent.id !== ownerId) return mark(context);
        attempts += 1;
        const transaction = s.prisma.$transaction.bind(s.prisma);
        const adapter = jest.spyOn(s.prisma, '$transaction').mockImplementation(((
          callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
          options?: { maxWait?: number; timeout?: number },
        ) =>
          transaction(async (tx) => {
            // FLAG: The first failure is a native PostgreSQL lock timeout, not a mocked rejection.
            await tx.$executeRaw(Prisma.sql`SET LOCAL lock_timeout = '1s'`);
            const [backend] = await tx.$queryRaw<Array<{ pid: number }>>(
              Prisma.sql`SELECT pg_backend_pid() AS pid`,
            );
            checkpointBackendPid = backend!.pid;
            return callback(tx);
          }, options)) as typeof s.prisma.$transaction);
        try {
          const pending = mark(context);
          void pending.catch(() => undefined);
          if (attempts === 1) {
            let observedWait = false;
            for (let probe = 0; probe < 50; probe += 1) {
              const [observation] = await s.prisma.$queryRaw<
                Array<{ waiting: boolean }>
              >(Prisma.sql`
                SELECT EXISTS (SELECT 1 FROM pg_stat_activity
                  WHERE datname = current_database() AND pid = ${checkpointBackendPid}
                    AND wait_event_type = 'Lock' AND query LIKE '%webhook_execution_claims%') AS waiting
              `);
              if (observation?.waiting) {
                observedWait = true;
                break;
              }
              await new Promise<void>((done) => setTimeout(done, 10));
            }
            expect(observedWait).toBe(true);
            await s.moderation.processWebhookEvent(independentId);
            expect(
              await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: independentId } }),
            ).toMatchObject({ status: 'PROCESSED' });
            shutdown = drainRuntimeWorkers([worker]).then((result) => {
              drained = true;
              return result;
            });
            await new Promise<void>((done) => setImmediate(done));
            expect(drained).toBe(false);
          }
          await pending;
        } catch (error) {
          failures.push(error);
          throw error;
        } finally {
          adapter.mockRestore();
          if (attempts === 1) {
            release.resolve();
            await blocker;
          }
        }
      });
    const fail = jest.spyOn(s.canonical, 'failExecution');
    try {
      const job = await queue.add(
        'process',
        { webhookEventId: ownerId },
        { jobId: ownerId, attempts: 1 },
      );
      await job.waitUntilFinished(events, 10_000);
      expect(await shutdown).toMatchObject({
        forced: false,
        closeFailureCount: 0,
        pauseFailureCount: 0,
        workerCount: 1,
      });
      expect(failures).toHaveLength(1);
      expect(JSON.stringify(failures[0])).toContain('55P03');
      expect(attempts).toBe(2);
      expect(fail).not.toHaveBeenCalled();
      const owner = await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: ownerId } });
      const claim = await s.prisma.webhookExecutionClaim.findUniqueOrThrow({
        where: { id: originalClaim.id },
      });
      expect(owner).toMatchObject({
        status: 'PROCESSED',
        executionDeadlineAt: originalReceipt.executionDeadlineAt,
      });
      expect(claim).toMatchObject({
        status: 'COMPLETED',
        preparedAt: originalClaim.preparedAt,
        leaseToken: null,
        leaseExpiresAt: null,
        commandResult: { kind: 'EXECUTION_FINISHED' },
      });
      expect(
        await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: independentId } }),
      ).toMatchObject({ status: 'PROCESSED' });
      const nextId = await s.ingest({
        chatId: chatId!,
        messageId: randomUUID(),
        text: 'Following',
        botId: s.bots[0]!.id,
      });
      await s.ingress.preparePersistedWebhookEvent(nextId);
      await s.moderation.processWebhookEvent(nextId);
      await s.moderation.processWebhookEvent(ownerId);
      expect(
        await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: nextId } }),
      ).toMatchObject({ status: 'PROCESSED' });
      expect(
        handler.mock.calls.filter(
          ([update]) =>
            update.message?.messageId ===
            (originalReceipt.normalizedPayload as { message?: { messageId: string } }).message
              ?.messageId,
        ),
      ).toHaveLength(1);
      expect(s.effects.filter((effect) => effect.method === 'delete')).toHaveLength(1);
    } finally {
      release.resolve();
      await blocker;
      checkpoint.mockRestore();
      handler.mockRestore();
      fail.mockRestore();
      await worker.close();
      await events.close();
      await queue.obliterate({ force: true });
      await queue.close();
    }
  });

  it.each(['message', 'prepared removal'] as const)(
    'reconciles a real committed %s checkpoint after an injected lost acknowledgement',
    async (kind) => {
      const s = (h = await createMultibotHarness({ databaseUrl, redisUrl, bots: 2, mode: 'on' }));
      await s.pause();
      const [chatId] = await s.seedCatalog(1);
      let id: string;
      if (kind === 'message') {
        id = await s.ingest({
          chatId: chatId!,
          messageId: randomUUID(),
          text: 'A long fixture message which must be deleted exactly once',
          botId: s.bots[0]!.id,
        });
      } else {
        const update = new WebhookParser().parse({
          update_id: randomUUID(),
          update_type: 'user_removed',
          chat_id: chatId!,
          user: { user_id: 'fixture-user', first_name: 'Fixture' },
          timestamp: Date.now(),
        });
        update.botId = s.bots[0]!.id;
        id = (await s.ingress.storeReceipt(update, null)).webhookEventId!;
        s.receiptIds.push(id);
      }
      await s.ingress.preparePersistedWebhookEvent(id);
      const originalReceipt = await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id } });
      const originalClaim = await s.prisma.webhookExecutionClaim.findFirstOrThrow({
        where: { webhookEventId: id, kind: 'EXECUTION' },
      });
      const helper = s.canonical as unknown as FinishCheckpoint;
      const mark = helper.markExecutionHandlerFinished.bind(s.canonical);
      let checkpointJson: unknown;
      let attempts = 0;
      const checkpoint = jest
        .spyOn(helper, 'markExecutionHandlerFinished')
        .mockImplementation(async (context) => {
          await mark(context);
          attempts += 1;
          if (attempts !== 1) return;
          checkpointJson = (
            await s.prisma.webhookExecutionClaim.findUniqueOrThrow({
              where: { id: originalClaim.id },
            })
          ).commandResult;
          // FLAG: SQL has genuinely committed. Only its acknowledgement is lost by this fixture.
          // This is not a claim that a network interruption has been reproduced.
          throw new Prisma.PrismaClientKnownRequestError(
            'Fixture lost committed checkpoint acknowledgement',
            { code: 'P1017', clientVersion: 'fixture' },
          );
        });
      const handler = jest.spyOn(s.moderation, 'handleUpdate');
      const fail = jest.spyOn(s.canonical, 'failExecution');
      try {
        await s.moderation.processWebhookEvent(id);
        const claim = await s.prisma.webhookExecutionClaim.findUniqueOrThrow({
          where: { id: originalClaim.id },
        });
        const journal = checkpointJson as { finishedAt: string };
        expect(attempts).toBe(2);
        expect(claim.commandResult).toEqual(checkpointJson);
        expect(claim.completedAt).toEqual(new Date(journal.finishedAt));
        expect(claim).toMatchObject({
          status: 'COMPLETED',
          preparedAt: originalClaim.preparedAt,
          leaseToken: null,
          leaseExpiresAt: null,
        });
        expect(await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id } })).toMatchObject({
          status: 'PROCESSED',
          processedAt: new Date(journal.finishedAt),
          executionDeadlineAt: originalReceipt.executionDeadlineAt,
        });
        expect(handler).toHaveBeenCalledTimes(kind === 'message' ? 1 : 0);
        expect(s.effects.filter((effect) => effect.method === 'delete')).toHaveLength(
          kind === 'message' ? 1 : 0,
        );
        expect(fail).not.toHaveBeenCalled();
        await s.moderation.processWebhookEvent(id);
        expect(handler).toHaveBeenCalledTimes(kind === 'message' ? 1 : 0);
      } finally {
        checkpoint.mockRestore();
        handler.mockRestore();
        fail.mockRestore();
      }
    },
  );

  it.each([
    'payload',
    'quarantined receipt',
    'foreign lease',
    'foreign journal',
    'source deadline',
    'processed receipt',
  ] as const)(
    'rolls back checkpoint and preserves the fence when %s changes after handler return',
    async (change) => {
      const s = (h = await createMultibotHarness({ databaseUrl, redisUrl, bots: 2, mode: 'on' }));
      await s.pause();
      const [chatId] = await s.seedCatalog(1, { maxMessageLengthEnabled: false });
      const id = await s.ingest({
        chatId: chatId!,
        messageId: randomUUID(),
        text: 'Fixture',
        botId: s.bots[0]!.id,
      });
      await s.ingress.preparePersistedWebhookEvent(id);
      const originalClaim = await s.prisma.webhookExecutionClaim.findFirstOrThrow({
        where: { webhookEventId: id, kind: 'EXECUTION' },
      });
      const handler = jest.spyOn(s.moderation, 'handleUpdate');
      const helper = s.canonical as unknown as FinishCheckpoint;
      const mark = helper.markExecutionHandlerFinished.bind(s.canonical);
      const checkpoint = jest
        .spyOn(helper, 'markExecutionHandlerFinished')
        .mockImplementation(async (context) => {
          if (change === 'payload')
            await s.prisma.webhookEvent.update({
              where: { id },
              data: { normalizedPayload: { changed: true } },
            });
          if (change === 'quarantined receipt')
            await s.prisma.webhookEvent.update({ where: { id }, data: { status: 'QUARANTINED' } });
          if (change === 'source deadline')
            await s.prisma.webhookEvent.update({
              where: { id },
              data: {
                executionDeadlineAt: new Date(
                  context.webhookEvent.executionDeadlineAt!.getTime() + 1,
                ),
              },
            });
          if (change === 'processed receipt')
            await s.prisma.webhookEvent.update({
              where: { id },
              data: { processedAt: new Date() },
            });
          if (change === 'foreign lease')
            await s.prisma.webhookExecutionClaim.update({
              where: { id: originalClaim.id },
              data: { leaseToken: 'foreign-token' },
            });
          if (change === 'foreign journal')
            await s.prisma.webhookExecutionClaim.update({
              where: { id: originalClaim.id },
              data: { commandResult: { kind: 'FOREIGN_EVIDENCE', keep: true } },
            });
          return mark(context);
        });
      const fail = jest.spyOn(s.canonical, 'failExecution');
      try {
        await expect(s.moderation.processWebhookEvent(id)).rejects.toMatchObject({
          outcome: 'authority_changed',
          phase: 'checkpoint',
        });
        const claim = await s.prisma.webhookExecutionClaim.findUniqueOrThrow({
          where: { id: originalClaim.id },
        });
        expect(claim.status).toBe('READY');
        expect(claim.businessStartedAt).toBeInstanceOf(Date);
        expect(claim.commandResult).toEqual(
          change === 'foreign journal'
            ? { kind: 'FOREIGN_EVIDENCE', keep: true }
            : originalClaim.commandResult,
        );
        expect(claim.leaseToken).toEqual(
          change === 'foreign lease' ? 'foreign-token' : expect.any(String),
        );
        expect((await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id } })).status).not.toBe(
          'PROCESSED',
        );
        expect(checkpoint).toHaveBeenCalledTimes(1);
        expect(handler).toHaveBeenCalledTimes(1);
        expect(fail).not.toHaveBeenCalled();
        expect(s.effects).toEqual([]);
      } finally {
        checkpoint.mockRestore();
        handler.mockRestore();
        fail.mockRestore();
      }
    },
  );

  it.each(['attempts exhausted', 'original lease budget exhausted', 'service closing'] as const)(
    'retains unresolved evidence after native lock failure: %s',
    async (limit) => {
      const s = (h = await createMultibotHarness({ databaseUrl, redisUrl, bots: 2, mode: 'on' }));
      await s.pause();
      const [chatId] = await s.seedCatalog(1, { maxMessageLengthEnabled: false });
      const id = await s.ingest({
        chatId: chatId!,
        messageId: randomUUID(),
        text: 'Fixture',
        botId: s.bots[0]!.id,
      });
      await s.ingress.preparePersistedWebhookEvent(id);
      const receipt = await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id } });
      const claim = await s.prisma.webhookExecutionClaim.findFirstOrThrow({
        where: { webhookEventId: id, kind: 'EXECUTION' },
      });
      const locked = signal();
      const release = signal();
      let blocker: Promise<unknown> | undefined;
      let originalLease: { leaseToken: string | null; leaseExpiresAt: Date | null } | undefined;
      const realHandler = s.moderation.handleUpdate.bind(s.moderation);
      const handler = jest
        .spyOn(s.moderation, 'handleUpdate')
        .mockImplementation(async (...args) => {
          await realHandler(...args);
          originalLease = await s.prisma.webhookExecutionClaim.findUniqueOrThrow({
            where: { id: claim.id },
            select: { leaseToken: true, leaseExpiresAt: true },
          });
          blocker = s.prisma.$transaction(async (tx) => {
            await tx.$queryRaw(
              Prisma.sql`SELECT id FROM webhook_execution_claims WHERE id = ${claim.id} FOR UPDATE`,
            );
            locked.resolve();
            await release.promise;
          });
          await locked.promise;
        });
      const helper = s.canonical as unknown as FinishCheckpoint;
      const mark = helper.markExecutionHandlerFinished.bind(s.canonical);
      let clock: jest.SpyInstance | undefined;
      let attempts = 0;
      const checkpoint = jest
        .spyOn(helper, 'markExecutionHandlerFinished')
        .mockImplementation(async (context) => {
          attempts += 1;
          const transaction = s.prisma.$transaction.bind(s.prisma);
          const adapter = jest.spyOn(s.prisma, '$transaction').mockImplementation(((
            callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
            options?: { maxWait?: number; timeout?: number },
          ) =>
            transaction(async (tx) => {
              await tx.$executeRaw(Prisma.sql`SET LOCAL lock_timeout = '100ms'`);
              return callback(tx);
            }, options)) as typeof s.prisma.$transaction);
          try {
            await mark(context);
          } finally {
            adapter.mockRestore();
            if (limit === 'original lease budget exhausted')
              clock = jest
                .spyOn(Date, 'now')
                .mockReturnValue(originalLease!.leaseExpiresAt!.getTime() + 1);
            if (limit === 'service closing') s.canonical.onModuleDestroy();
          }
        });
      const fail = jest.spyOn(s.canonical, 'failExecution');
      try {
        await expect(s.moderation.processWebhookEvent(id)).rejects.toBeInstanceOf(
          WebhookFinishPersistenceError,
        );
        clock?.mockRestore();
        clock = undefined;
        release.resolve();
        await blocker;
        expect(attempts).toBe(limit === 'attempts exhausted' ? 2 : 1);
        expect(handler).toHaveBeenCalledTimes(1);
        expect(fail).not.toHaveBeenCalled();
        expect(
          await s.prisma.webhookExecutionClaim.findUniqueOrThrow({ where: { id: claim.id } }),
        ).toMatchObject({
          status: 'READY',
          completedAt: null,
          commandResult: claim.commandResult,
          ...originalLease,
        });
        expect(await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id } })).toMatchObject({
          status: receipt.status,
          executionDeadlineAt: receipt.executionDeadlineAt,
        });
        expect(s.effects).toEqual([]);
      } finally {
        clock?.mockRestore();
        release.resolve();
        await blocker;
        checkpoint.mockRestore();
        handler.mockRestore();
        fail.mockRestore();
      }
    },
  );

  it('preserves the native rejection of cancellation without sealed durable evidence', async () => {
    const s = (h = await createMultibotHarness({ databaseUrl, redisUrl, bots: 1, mode: 'on' }));
    await s.pause();
    const [chatId] = await s.seedCatalog(1, { maxMessageLengthEnabled: false });
    const id = await s.ingest({
      chatId: chatId!,
      messageId: randomUUID(),
      text: 'Fixture',
      botId: s.bots[0]!.id,
    });
    await s.ingress.preparePersistedWebhookEvent(id);
    const original = await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id } });
    // FLAG: This exercises the installed cancellation guard, without creating an operation,
    // bypassing its trigger, or claiming coverage of an authorized sealed cancellation.
    await expect(
      s.prisma.webhookEvent.update({ where: { id }, data: { status: 'CANCELLED' } }),
    ).rejects.toThrow();
    expect(await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id } })).toEqual(original);
    expect(s.effects).toEqual([]);
  });

  it('preserves JSON-null original command authority through the SQL checkpoint CAS', async () => {
    const s = (h = await createMultibotHarness({ databaseUrl, redisUrl, bots: 1, mode: 'on' }));
    await s.pause();
    const [chatId] = await s.seedCatalog(1, { maxMessageLengthEnabled: false });
    const id = await s.ingest({
      chatId: chatId!,
      messageId: randomUUID(),
      text: 'Fixture',
      botId: s.bots[0]!.id,
    });
    await s.ingress.preparePersistedWebhookEvent(id);
    const claim = await s.prisma.webhookExecutionClaim.findFirstOrThrow({
      where: { webhookEventId: id, kind: 'EXECUTION' },
    });
    await s.prisma.webhookExecutionClaim.update({
      where: { id: claim.id },
      data: { commandResult: Prisma.JsonNull },
    });
    await s.moderation.processWebhookEvent(id);
    expect(
      await s.prisma.webhookExecutionClaim.findUniqueOrThrow({ where: { id: claim.id } }),
    ).toMatchObject({ status: 'COMPLETED', commandResult: { kind: 'EXECUTION_FINISHED' } });
    expect(s.effects).toEqual([]);
  });

  it('mints no positive finish checkpoint for a thrown handler and keeps independent progress', async () => {
    const s = (h = await createMultibotHarness({ databaseUrl, redisUrl, bots: 1, mode: 'on' }));
    await s.pause();
    const [chatId, independentChatId] = await s.seedCatalog(2, { maxMessageLengthEnabled: false });
    const id = await s.ingest({
      chatId: chatId!,
      messageId: randomUUID(),
      text: 'Fixture',
      botId: s.bots[0]!.id,
    });
    await s.ingress.preparePersistedWebhookEvent(id);
    const claim = await s.prisma.webhookExecutionClaim.findFirstOrThrow({
      where: { webhookEventId: id, kind: 'EXECUTION' },
    });
    const helper = s.canonical as unknown as FinishCheckpoint;
    const mark = jest.spyOn(helper, 'markExecutionHandlerFinished');
    const error = new Error('Fixture handler failure before positive return');
    const realHandler = s.moderation.handleUpdate.bind(s.moderation);
    const handler = jest.spyOn(s.moderation, 'handleUpdate').mockImplementation(async (...args) => {
      if (args[0].message?.chatId === chatId) throw error;
      return realHandler(...args);
    });
    const fail = jest.spyOn(s.canonical, 'failExecution');
    try {
      await expect(s.moderation.processWebhookEvent(id)).rejects.toBe(error);
      expect(mark).not.toHaveBeenCalled();
      expect(fail).toHaveBeenCalledTimes(1);
      expect(
        await s.prisma.webhookExecutionClaim.findUniqueOrThrow({ where: { id: claim.id } }),
      ).toMatchObject({
        status: 'READY',
        businessStartedAt: expect.any(Date),
        commandResult: claim.commandResult,
      });
      const independent = await s.ingest({
        chatId: independentChatId!,
        messageId: randomUUID(),
        text: 'Independent',
        botId: s.bots[0]!.id,
      });
      await s.ingress.preparePersistedWebhookEvent(independent);
      await s.moderation.processWebhookEvent(independent);
      await s.moderation.processWebhookEvent(id);
      expect(
        handler.mock.calls.filter(([update]) => update.message?.chatId === chatId),
      ).toHaveLength(1);
      expect(
        await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: independent } }),
      ).toMatchObject({ status: 'PROCESSED' });
      expect(s.effects).toEqual([]);
    } finally {
      mark.mockRestore();
      handler.mockRestore();
      fail.mockRestore();
    }
  });

  it('retains the existing first-finalization behavior after the captured lease expiry', async () => {
    const s = (h = await createMultibotHarness({ databaseUrl, redisUrl, bots: 1, mode: 'on' }));
    await s.pause();
    const [chatId] = await s.seedCatalog(1, { maxMessageLengthEnabled: false });
    const id = await s.ingest({
      chatId: chatId!,
      messageId: randomUUID(),
      text: 'Fixture',
      botId: s.bots[0]!.id,
    });
    await s.ingress.preparePersistedWebhookEvent(id);
    const claim = await s.prisma.webhookExecutionClaim.findFirstOrThrow({
      where: { webhookEventId: id, kind: 'EXECUTION' },
    });
    let clock: jest.SpyInstance | undefined;
    const realHandler = s.moderation.handleUpdate.bind(s.moderation);
    const handler = jest.spyOn(s.moderation, 'handleUpdate').mockImplementation(async (...args) => {
      await realHandler(...args);
      const started = await s.prisma.webhookExecutionClaim.findUniqueOrThrow({
        where: { id: claim.id },
      });
      // FLAG: Advance only the local budget clock after actual work. This is not a real
      // five-minute handler or a lease renewal; the first SQL attempt must retain its contract.
      clock = jest.spyOn(Date, 'now').mockReturnValue(started.leaseExpiresAt!.getTime() + 1);
    });
    const checkpoint = jest.spyOn(
      s.canonical as unknown as FinishCheckpoint,
      'markExecutionHandlerFinished',
    );
    const fail = jest.spyOn(s.canonical, 'failExecution');
    try {
      await s.moderation.processWebhookEvent(id);
      clock?.mockRestore();
      clock = undefined;
      expect(checkpoint).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(fail).not.toHaveBeenCalled();
      expect(await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id } })).toMatchObject({
        status: 'PROCESSED',
      });
      expect(
        await s.prisma.webhookExecutionClaim.findUniqueOrThrow({ where: { id: claim.id } }),
      ).toMatchObject({ status: 'COMPLETED', commandResult: { kind: 'EXECUTION_FINISHED' } });
      expect(s.effects).toEqual([]);
    } finally {
      clock?.mockRestore();
      handler.mockRestore();
      checkpoint.mockRestore();
      fail.mockRestore();
    }
  });
});
