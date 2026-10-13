import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import Redis from 'ioredis';
import {
  createPrismaClient,
  Prisma,
  type PrismaClient,
  type WebhookEvent,
} from '../prisma/prisma-client';
import { WebhookCanonicalExecutionService } from '../moderation/webhook-canonical-execution.service';
import { QueueMetricsService } from '../system/queue-metrics.service';
import { WebhookOutboxService } from './webhook-outbox.service';
import {
  WebhookDependencyQuarantineService,
  WEBHOOK_QUARANTINE_BATCH_SIZE,
} from './webhook-dependency-quarantine.service';
import { buildWebhookSemanticEventKey } from './webhook-semantic-event-key';
import { buildWebhookReceiptSemanticKey } from './webhook-receipt-semantic-key';
import { WebhookParser } from './webhook.parser';
import { WEBHOOK_QUEUE_CRITICAL } from './webhook-queues';
import { WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX } from './webhook-timeout-quarantine';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const redisUrl = process.env.MAXIM_TEST_REDIS_URL?.trim() ?? '';
const native = databaseUrl && redisUrl ? describe : describe.skip;
const publisherBotId = 'publisher-quarantine-fixture';

// FLAG: Real PostgreSQL, BullMQ handoff, canonical start/completion and lag queries.
// The awaited business handler is a local spy: this suite never calls the MAX network.
native('durable dependency quarantine and independent final execution', () => {
  jest.setTimeout(45_000);
  let prisma: PrismaClient;
  let redis: Redis;
  let queue: Queue;
  let worker: Worker | undefined;
  let quarantine: WebhookDependencyQuarantineService;
  let canonical: WebhookCanonicalExecutionService;
  const ids: string[] = [];
  const claims: string[] = [];

  beforeAll(async () => {
    for (const [value, pg] of [
      [databaseUrl, true],
      [redisUrl, false],
    ] as const) {
      const url = new URL(value);
      if (
        !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
        (pg && !url.pathname.includes('race_test'))
      )
        throw new Error('Disposable local stores required');
    }
    prisma = createPrismaClient(databaseUrl, { max: 8 });
    const [identity] = await prisma.$queryRaw<Array<{ version: string; timezone: string }>>`
      SELECT version(), current_setting('TimeZone') AS timezone`;
    expect(identity?.version).toMatch(/^PostgreSQL 16\./u);
    expect(identity?.timezone).toBe('UTC');
    redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
    expect(await redis.info('server')).toMatch(/^redis_version:7\./mu);
    queue = new Queue(`quarantine-${randomUUID()}`, {
      connection: redis as unknown as ConnectionOptions,
    });
    await queue.waitUntilReady();
  });

  beforeEach(() => {
    quarantine = new WebhookDependencyQuarantineService(
      prisma as never,
      new ConfigService({ MAX_PUBLISHER_BOT_ID: publisherBotId }),
    );
    // Exercise the future writer in the compatibility release's mandatory native lane.
    Object.assign(quarantine, { writesEnabled: true });
    canonical = new WebhookCanonicalExecutionService(prisma as never);
  });

  afterEach(async () => {
    await worker?.close();
    worker = undefined;
    await queue.obliterate({ force: true }); // exclusively this randomized local fixture queue
    await prisma.webhookDependencyQuarantine.deleteMany({ where: { receiptId: { in: ids } } });
    await prisma.webhookExecutionClaim.deleteMany({ where: { id: { in: claims.splice(0) } } });
    await prisma.webhookEvent.deleteMany({ where: { id: { in: ids.splice(0) } } });
  });

  afterAll(async () => {
    await queue.close();
    await redis.quit();
    await prisma.$disconnect();
  });

  async function receipt(
    chatId = `-${Date.now()}${Math.floor(Math.random() * 10_000)}`,
    options: {
      poison?: boolean;
      createdAt?: Date;
      messageId?: string;
      botId?: string;
      claim?: boolean;
    } = {},
  ) {
    const id = randomUUID();
    const createdAt = options.createdAt ?? new Date();
    const messageId = options.messageId ?? randomUUID();
    const payload = new WebhookParser().parse(
      {
        update_type: 'message_created',
        timestamp: createdAt.getTime(),
        message: {
          sender: { user_id: 'human-fixture', name: 'Fixture', is_bot: false },
          recipient: { chat_id: chatId, chat_type: 'chat' },
          timestamp: createdAt.getTime(),
          body: { mid: messageId, text: 'local fixture' },
        },
      },
      { botId: options.botId ?? 'major-quarantine-fixture' },
    );
    const event = await prisma.webhookEvent.create({
      data: {
        id,
        dedupKey: id,
        botId: payload.botId,
        createdAt,
        semanticKey: buildWebhookSemanticEventKey(payload),
        executionDeadlineAt: new Date(createdAt.getTime() + 600_000),
        status: options.poison ? 'FAILED' : 'RECEIVED',
        errorMessage: options.poison
          ? `${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX}:fixture; unknown PUT result`
          : null,
        rawPayload: JSON.parse(JSON.stringify(payload)),
        normalizedPayload: JSON.parse(JSON.stringify(payload)),
      },
    });
    ids.push(id);
    if (options.claim !== false) {
      const claim = await prisma.webhookExecutionClaim.create({
        data: {
          kind: 'EXECUTION',
          semanticKey: event.semanticKey!,
          webhookEventId: id,
          executionBotId: payload.botId,
          enforced: true,
          status: 'READY',
          preparedAt: createdAt,
          businessStartedAt: options.poison ? createdAt : null,
        },
      });
      claims.push(claim.id);
    }
    return event;
  }

  function chat(event: WebhookEvent) {
    return (event.normalizedPayload as { message: { chatId: string } }).message.chatId;
  }

  async function makeDue() {
    await prisma.webhookDependencyQuarantine.updateMany({
      where: { receiptId: { in: ids }, state: 'WAITING' },
      data: { nextCheckAt: new Date(0) },
    });
  }

  async function completePredecessor(event: WebhookEvent) {
    const completedAt = new Date();
    await prisma.$transaction(async (tx) => {
      await tx.webhookExecutionClaim.updateMany({
        where: { webhookEventId: event.id, kind: 'EXECUTION' },
        data: { status: 'COMPLETED', completedAt, leaseToken: null, leaseExpiresAt: null },
      });
      await tx.webhookEvent.update({
        where: { id: event.id },
        data: {
          status: 'PROCESSED',
          processedAt: completedAt,
          errorMessage: null,
          timeoutQuarantineExpiresAt: null,
          nextEnqueueAt: null,
        },
      });
    });
  }

  function outbox() {
    const config = new ConfigService({ ENQUEUE_BATCH_SIZE: 64, ENQUEUE_CONCURRENCY: 8 });
    const preparation = {
      webhookPreparationSchedulingState: () => 'available',
      nextPreparationCompletion: () => null,
      // Existing READY fixtures need no external bot discovery or new preparation.
      preparePersistedWebhookEvent: async (id: string) => {
        const row = await prisma.webhookEvent.findUniqueOrThrow({ where: { id } });
        return {
          canonical: true,
          prepared: true,
          normalizedPayload: row.normalizedPayload,
          executionBotId: row.botId,
          enforced: true,
        };
      },
    };
    return new WebhookOutboxService(
      prisma as never,
      config,
      { get: () => queue } as never,
      { resolveQueueName: async () => WEBHOOK_QUEUE_CRITICAL } as never,
      preparation as never,
      queue as never,
      queue as never,
      queue as never,
      { getEffectiveSnapshot: async () => ({ mode: 'normal' }) } as never,
      undefined,
      quarantine,
    );
  }

  it('parks and releases a Publisher observation without borrowing moderation execution authority', async () => {
    const poison = await receipt(undefined, { poison: true });
    const originalClaim = await prisma.webhookExecutionClaim.findUniqueOrThrow({
      where: { kind_semanticKey: { kind: 'EXECUTION', semanticKey: poison.semanticKey! } },
    });
    const observation = await receipt(chat(poison), { botId: publisherBotId, claim: false });
    const semanticKey = buildWebhookReceiptSemanticKey(
      observation.normalizedPayload as never,
      publisherBotId,
    );
    await prisma.webhookEvent.update({
      where: { id: observation.id },
      data: { semanticKey },
    });

    expect(await quarantine.parkSuccessors(poison.id, [observation.id])).toBe(1);
    expect(
      await prisma.webhookEvent.findUniqueOrThrow({ where: { id: observation.id } }),
    ).toMatchObject({ status: 'QUARANTINED', semanticKey, processedAt: null, enqueueAttempts: 0 });
    expect(
      await prisma.webhookExecutionClaim.findUnique({ where: { id: originalClaim.id } }),
    ).toEqual(originalClaim);
    expect(
      await prisma.webhookExecutionClaim.findMany({ where: { webhookEventId: observation.id } }),
    ).toEqual([]);
    await makeDue();
    expect(await quarantine.reconcileDue()).toMatchObject({ released: 0 });

    await completePredecessor(poison);
    await makeDue();
    expect(await quarantine.reconcileDue()).toMatchObject({ released: 1 });
    expect(
      await prisma.webhookEvent.findUniqueOrThrow({ where: { id: observation.id } }),
    ).toMatchObject({ status: 'RECEIVED', semanticKey, processedAt: null, enqueueAttempts: 0 });
    expect(
      await prisma.webhookExecutionClaim.findMany({ where: { webhookEventId: observation.id } }),
    ).toEqual([]);
  });

  it.each(['shared-key', 'foreign-namespace', 'receiver-drift', 'execution-claim', 'replay-fence'])(
    'refuses Publisher observation with %s evidence',
    async (variant) => {
      const poison = await receipt(undefined, { poison: true });
      const observation = await receipt(chat(poison), { botId: publisherBotId, claim: false });
      const semanticKey = buildWebhookReceiptSemanticKey(
        observation.normalizedPayload as never,
        publisherBotId,
      )!;
      const updated = await prisma.webhookEvent.update({
        where: { id: observation.id },
        data: {
          semanticKey:
            variant === 'shared-key'
              ? observation.semanticKey
              : variant === 'foreign-namespace'
                ? semanticKey.replace(publisherBotId, 'foreign')
                : semanticKey,
          ...(variant === 'receiver-drift' ? { botId: 'foreign' } : {}),
          ...(variant === 'replay-fence' ? { errorMessage: 'ambiguous fixture mutation' } : {}),
        },
      });
      if (variant === 'execution-claim') {
        const claim = await prisma.webhookExecutionClaim.create({
          data: {
            kind: 'EXECUTION',
            semanticKey,
            webhookEventId: observation.id,
            executionBotId: publisherBotId,
            enforced: true,
            status: 'READY',
          },
        });
        claims.push(claim.id);
      }
      expect(await quarantine.parkSuccessors(poison.id, [observation.id])).toBe(0);
      expect(await prisma.webhookEvent.findUnique({ where: { id: observation.id } })).toEqual(
        updated,
      );
      expect(
        await prisma.webhookDependencyQuarantine.findMany({ where: { receiptId: observation.id } }),
      ).toEqual([]);
    },
  );

  it('parks a poison chat and completes independent work through BullMQ without replay or retry churn', async () => {
    const poison = await receipt(undefined, { poison: true });
    const originalClaim = await prisma.webhookExecutionClaim.findUnique({
      where: { kind_semanticKey: { kind: 'EXECUTION', semanticKey: poison.semanticKey! } },
    });
    const waiting = await receipt(chat(poison));
    const mirror = await receipt(chat(poison), {
      messageId: (waiting.normalizedPayload as { message: { messageId: string } }).message
        .messageId,
      botId: 'second-moderator',
      claim: false,
    });
    const independent = await receipt();
    const handled = jest.fn(async (_id: string) => undefined);
    const processed = new Promise<void>((resolve, reject) => {
      worker = new Worker(
        queue.name,
        async (job) => {
          const context = await canonical.prepareExecution(
            job.data.webhookEventId,
            'major-quarantine-fixture',
          );
          if (context) {
            await handled(context.webhookEvent.id);
            await canonical.completeExecution(context);
            if (context.webhookEvent.id === independent.id) resolve();
          }
        },
        { connection: redis as unknown as ConnectionOptions, concurrency: 4 },
      );
      worker.on('failed', (_job, error) => reject(error));
      worker.on('error', reject);
    });
    const scheduler = outbox();
    const internal = scheduler as unknown as {
      enqueueCandidates(rows: unknown[], concurrency?: number): Promise<unknown>;
      drainEnqueueUnits(): Promise<void>;
    };
    const candidates = [poison, waiting, mirror, independent].map((row) => ({
      ...row,
      priority: 1,
    }));
    await internal.enqueueCandidates(candidates, 8);
    await processed;
    await internal.drainEnqueueUnits();
    expect(handled.mock.calls).toEqual([[independent.id]]);
    expect(
      (await prisma.webhookEvent.findUniqueOrThrow({ where: { id: independent.id } })).status,
    ).toBe('PROCESSED');
    for (const event of [waiting, mirror]) {
      expect(await prisma.webhookEvent.findUnique({ where: { id: event.id } })).toEqual({
        ...event,
        status: 'QUARANTINED',
      });
      expect(await canonical.prepareExecution(event.id, event.botId)).toBeNull();
    }
    expect(await canonical.prepareExecution(poison.id, poison.botId)).toBeNull();
    expect(await prisma.webhookEvent.findUnique({ where: { id: poison.id } })).toEqual(poison);
    expect(
      await prisma.webhookExecutionClaim.findUnique({ where: { id: originalClaim!.id } }),
    ).toEqual(originalClaim);
    const attempts = (await prisma.webhookEvent.findUniqueOrThrow({ where: { id: waiting.id } }))
      .enqueueAttempts;
    await makeDue();
    await quarantine.reconcileDue();
    await quarantine.reconcileDue();
    expect(
      (await prisma.webhookEvent.findUniqueOrThrow({ where: { id: waiting.id } })).enqueueAttempts,
    ).toBe(attempts);
    const metrics = new QueueMetricsService(
      prisma as never,
      {} as never,
      { get: () => undefined } as never,
      {} as never,
    );
    expect(await metrics.getLagSnapshot({ maxAgeMs: 0 })).toMatchObject({
      effectiveLagSec: 0,
      operationalLagSec: 0,
      quarantinedCountLowerBound: 2,
      quarantineSampleLimitReached: false,
    });
    expect(await queue.getJobCounts('waiting', 'active', 'delayed')).toMatchObject({
      waiting: 0,
      delayed: 0,
    });
  });

  it.each(['timeout-marker', 'unclassified-started-failure'])(
    'isolates pristine copies around an earlier order anchor and later %s owner',
    async (failureKind) => {
      const messageId = randomUUID();
      const mirror = await receipt(undefined, { messageId, claim: false, botId: 'first-bot' });
      const between = await receipt(chat(mirror));
      let owner = await receipt(chat(mirror), { messageId, poison: true, botId: 'owner-bot' });
      if (failureKind === 'unclassified-started-failure')
        owner = await prisma.webhookEvent.update({
          where: { id: owner.id },
          data: { errorMessage: 'local fixture persistence failure' },
        });
      const lateMirror = await receipt(chat(mirror), {
        messageId,
        claim: false,
        botId: 'third-bot',
      });
      const independent = await receipt();
      const original = await prisma.webhookExecutionClaim.findUniqueOrThrow({
        where: { kind_semanticKey: { kind: 'EXECUTION', semanticKey: owner.semanticKey! } },
      });
      const scheduler = outbox() as unknown as {
        enqueueCandidates(rows: unknown[], concurrency?: number): Promise<unknown>;
        drainEnqueueUnits(): Promise<void>;
      };
      await scheduler.enqueueCandidates(
        [mirror, between, owner, lateMirror, independent].map((row) => ({ ...row, priority: 1 })),
        8,
      );
      await scheduler.drainEnqueueUnits();
      const chatOrderHeld = failureKind === 'timeout-marker';
      const parkedCopies = chatOrderHeld ? [mirror, between, lateMirror] : [mirror, lateMirror];
      for (const event of parkedCopies) {
        expect(
          (await prisma.webhookEvent.findUniqueOrThrow({ where: { id: event.id } })).status,
        ).toBe('QUARANTINED');
        expect(
          await prisma.webhookDependencyQuarantine.findFirst({ where: { receiptId: event.id } }),
        ).toMatchObject({ blockerId: owner.id, anchorId: mirror.id });
      }
      expect(
        (await prisma.webhookEvent.findUniqueOrThrow({ where: { id: independent.id } })).status,
      ).toBe('QUEUED');
      const fresh = await receipt(chat(mirror));
      await scheduler.enqueueCandidates(
        [between, fresh].map((row) => ({ ...row, priority: 1 })),
        8,
      );
      await scheduler.drainEnqueueUnits();
      if (chatOrderHeld) {
        expect(
          (await prisma.webhookEvent.findUniqueOrThrow({ where: { id: fresh.id } })).status,
        ).toBe('QUARANTINED');
        expect(await canonical.prepareExecution(fresh.id, fresh.botId)).toBeNull();
      } else {
        expect(
          await prisma.webhookDependencyQuarantine.findFirst({ where: { receiptId: between.id } }),
        ).toBeNull();
        const followingExecution = await canonical.prepareExecution(between.id, between.botId);
        expect(followingExecution).not.toBeNull();
        await canonical.completeExecution(followingExecution!);
        await scheduler.enqueueCandidates([{ ...fresh, priority: 1 }], 8);
        await scheduler.drainEnqueueUnits();
        const freshExecution = await canonical.prepareExecution(fresh.id, fresh.botId);
        expect(freshExecution).not.toBeNull();
        await canonical.completeExecution(freshExecution!);
      }
      expect(await prisma.webhookEvent.findUnique({ where: { id: owner.id } })).toEqual(owner);
      expect(await prisma.webhookExecutionClaim.findUnique({ where: { id: original.id } })).toEqual(
        original,
      );
      await completePredecessor(owner);
      await makeDue();
      expect((await quarantine.reconcileDue()).released).toBe(chatOrderHeld ? 4 : 2);
      expect(await canonical.prepareExecution(mirror.id, mirror.botId)).toBeNull();
      expect(
        (await prisma.webhookEvent.findUniqueOrThrow({ where: { id: mirror.id } })).status,
      ).toBe('DUPLICATE');
      if (chatOrderHeld) {
        const execution = await canonical.prepareExecution(between.id, between.botId);
        expect(execution).not.toBeNull();
        await canonical.completeExecution(execution!);
      }
      expect(await canonical.prepareExecution(lateMirror.id, lateMirror.botId)).toBeNull();
    },
  );

  it.each(['unstarted', 'completed', 'unenforced'] as const)(
    'refuses generic FAILED ownership without exact unfinished start proof: %s',
    async (invalidProof) => {
      const messageId = randomUUID();
      const mirror = await receipt(undefined, { messageId, claim: false });
      const owner = await receipt(chat(mirror), { messageId, poison: true });
      await prisma.webhookEvent.update({
        where: { id: owner.id },
        data: { errorMessage: 'unclassified fixture' },
      });
      await prisma.webhookExecutionClaim.updateMany({
        where: { webhookEventId: owner.id },
        data:
          invalidProof === 'unstarted'
            ? { businessStartedAt: null }
            : invalidProof === 'completed'
              ? { status: 'COMPLETED', completedAt: new Date() }
              : { enforced: false },
      });
      expect((await quarantine.findQuarantinedMirrorOwners([mirror.id])).size).toBe(0);
      expect(await quarantine.parkSuccessors(owner.id, [mirror.id], mirror.id)).toBe(0);
      expect(await prisma.webhookEvent.findUnique({ where: { id: mirror.id } })).toEqual(mirror);
    },
  );

  it.each(['activated', 'independent-claim'] as const)(
    'preserves an uncertain source copy with %s evidence',
    async (evidence) => {
      const messageId = randomUUID();
      const mirror = await receipt(undefined, { messageId, claim: false });
      const owner = await receipt(chat(mirror), { messageId, poison: true });
      if (evidence === 'activated')
        await prisma.webhookEvent.update({
          where: { id: mirror.id },
          data: {
            enqueueAttempts: 1,
            queuedAt: new Date(),
            queueName: WEBHOOK_QUEUE_CRITICAL,
          },
        });
      else {
        const independent = await prisma.webhookExecutionClaim.create({
          data: {
            kind: 'LEGACY_UNKNOWN',
            semanticKey: mirror.semanticKey!,
            webhookEventId: mirror.id,
            businessStartedAt: new Date(),
          },
        });
        claims.push(independent.id);
      }
      const before = await prisma.webhookEvent.findUnique({ where: { id: mirror.id } });
      expect(await quarantine.parkSuccessors(owner.id, [mirror.id], mirror.id)).toBe(0);
      expect(await prisma.webhookEvent.findUnique({ where: { id: mirror.id } })).toEqual(before);
    },
  );

  it('releases only after positive predecessor completion and executes the successor once after restart', async () => {
    const poison = await receipt(undefined, { poison: true });
    const waiting = await receipt(chat(poison));
    expect(await quarantine.parkSuccessors(poison.id, [waiting.id])).toBe(1);
    await makeDue();
    expect(await quarantine.reconcileDue()).toMatchObject({ released: 0 });
    await completePredecessor(poison);
    await makeDue();
    const restarted = new WebhookDependencyQuarantineService(
      prisma as never,
      new ConfigService({ MAX_PUBLISHER_BOT_ID: publisherBotId }),
    );
    expect(await restarted.reconcileDue()).toMatchObject({ released: 1 });
    const restored = await prisma.webhookEvent.findUniqueOrThrow({ where: { id: waiting.id } });
    expect(restored.executionDeadlineAt).toEqual(waiting.executionDeadlineAt);
    expect(restored.normalizedPayload).toEqual(waiting.normalizedPayload);
    const execution = await canonical.prepareExecution(waiting.id, waiting.botId);
    expect(execution).not.toBeNull();
    await canonical.completeExecution(execution!);
    expect(await canonical.prepareExecution(waiting.id, waiting.botId)).toBeNull();
    expect(await restarted.reconcileDue()).toEqual({ inspected: 0, released: 0, expired: 0 });
  });

  it('never converts expiry, terminal failure or a bare processed receipt into completion proof', async () => {
    const poison = await receipt(undefined, { poison: true });
    const waiting = await receipt(chat(poison));
    await quarantine.parkSuccessors(poison.id, [waiting.id]);
    await prisma.webhookEvent.update({
      where: { id: poison.id },
      data: {
        status: 'PROCESSED',
        processedAt: new Date(),
        errorMessage: null,
      },
    });
    await makeDue();
    expect(await quarantine.reconcileDue()).toMatchObject({ released: 0 });
    await prisma.webhookEvent.update({
      where: { id: waiting.id },
      data: { executionDeadlineAt: new Date(0) },
    });
    await makeDue();
    expect(await quarantine.reconcileDue()).toMatchObject({ expired: 1, released: 0 });
    await completePredecessor(poison);
    expect(await quarantine.reconcileDue()).toEqual({ inspected: 0, released: 0, expired: 0 });
    expect(await canonical.prepareExecution(waiting.id, waiting.botId)).toBeNull();
    expect(
      (
        await prisma.webhookDependencyQuarantine.findFirstOrThrow({
          where: { receiptId: waiting.id },
        })
      ).state,
    ).toBe('EXPIRED');
  });

  it.each(['started', 'leased', 'completed', 'unknown'] as const)(
    'refuses a %s successor and preserves its evidence',
    async (state) => {
      const poison = await receipt(undefined, { poison: true });
      const waiting = await receipt(chat(poison));
      if (state === 'unknown')
        await prisma.webhookEvent.update({
          where: { id: waiting.id },
          data: { errorMessage: 'ambiguous remote result' },
        });
      else
        await prisma.webhookExecutionClaim.updateMany({
          where: { webhookEventId: waiting.id },
          data:
            state === 'started'
              ? { businessStartedAt: new Date() }
              : state === 'completed'
                ? { status: 'COMPLETED', completedAt: new Date() }
                : { leaseToken: 'live-attempt', leaseExpiresAt: new Date(Date.now() + 60_000) },
        });
      const before = await prisma.webhookEvent.findUnique({ where: { id: waiting.id } });
      expect(await quarantine.parkSuccessors(poison.id, [waiting.id])).toBe(0);
      expect(await prisma.webhookEvent.findUnique({ where: { id: waiting.id } })).toEqual(before);
    },
  );

  it('fences a stale READY/start transition after the receipt has been parked', async () => {
    const poison = await receipt(undefined, { poison: true });
    const waiting = await receipt(chat(poison));
    await quarantine.parkSuccessors(poison.id, [waiting.id]);
    const claim = await prisma.webhookExecutionClaim.findUniqueOrThrow({
      where: { kind_semanticKey: { kind: 'EXECUTION', semanticKey: waiting.semanticKey! } },
    });
    await prisma.webhookExecutionClaim.update({
      where: { id: claim.id },
      data: {
        leaseToken: 'stale-reader',
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    const result = await prisma.$transaction((tx) =>
      WebhookCanonicalExecutionService.transitionLiveUnstartedOwnerWithClient(tx, {
        claimId: claim.id,
        webhookEventId: waiting.id,
        semanticKey: waiting.semanticKey!,
        leaseToken: 'stale-reader',
        executionBotId: claim.executionBotId,
        executionDeadlineAt: waiting.executionDeadlineAt,
        enforced: true,
        phase: 'start',
      }),
    );
    expect(result).toBe('deferred');
    expect(
      (await prisma.webhookExecutionClaim.findUniqueOrThrow({ where: { id: claim.id } }))
        .businessStartedAt,
    ).toBeNull();
  });

  it('expires a released successor at final start without renewing its original deadline', async () => {
    const poison = await receipt(undefined, { poison: true });
    const waiting = await receipt(chat(poison));
    await quarantine.parkSuccessors(poison.id, [waiting.id]);
    await completePredecessor(poison);
    await makeDue();
    await quarantine.reconcileDue();
    await prisma.webhookEvent.update({
      where: { id: waiting.id },
      data: { executionDeadlineAt: new Date(0) },
    });
    expect(await canonical.prepareExecution(waiting.id, waiting.botId)).toBeNull();
    expect(
      (await prisma.webhookEvent.findUniqueOrThrow({ where: { id: waiting.id } })).status,
    ).toBe('QUARANTINED');
    expect(
      (
        await prisma.webhookDependencyQuarantine.findFirstOrThrow({
          where: { receiptId: waiting.id },
        })
      ).state,
    ).toBe('EXPIRED');
  });

  it('records a second blocker without overwriting the first quarantine journal', async () => {
    const first = await receipt(undefined, { poison: true });
    const second = await receipt(chat(first), { poison: true });
    const waiting = await receipt(chat(first));
    await quarantine.parkSuccessors(first.id, [waiting.id]);
    await completePredecessor(first);
    await makeDue();
    expect((await quarantine.reconcileDue()).released).toBe(1);
    expect(await quarantine.parkSuccessors(second.id, [waiting.id])).toBe(1);
    expect(
      await prisma.webhookDependencyQuarantine.findMany({
        where: { receiptId: waiting.id },
        orderBy: { createdAt: 'asc' },
        select: { blockerId: true, state: true },
      }),
    ).toEqual([
      { blockerId: first.id, state: 'RELEASED' },
      { blockerId: second.id, state: 'WAITING' },
    ]);
    expect(await canonical.prepareExecution(waiting.id, waiting.botId)).toBeNull();
  });

  it.each([false, true])(
    'continues reconciliation after an item fails (hint unavailable: %s), without claiming success',
    async (hintUnavailable) => {
      const poison = await receipt(undefined, { poison: true });
      const first = await receipt(chat(poison));
      const second = await receipt(chat(poison));
      await quarantine.parkSuccessors(poison.id, [first.id, second.id]);
      await completePredecessor(poison);
      await makeDue();
      const failure = jest
        .spyOn(prisma, '$transaction')
        .mockRejectedValueOnce(new Error('injected persistence failure'));
      const hintFailure = hintUnavailable
        ? jest
            .spyOn(prisma.webhookDependencyQuarantine, 'updateMany')
            .mockRejectedValueOnce(new Error('injected retry hint failure'))
        : null;
      try {
        expect(await quarantine.reconcileDue()).toMatchObject({ inspected: 2, released: 1 });
        expect(
          await prisma.webhookEvent.count({
            where: { id: { in: [first.id, second.id] }, status: 'QUARANTINED' },
          }),
        ).toBe(1);
        expect((await quarantine.reconcileDue()).inspected).toBe(hintUnavailable ? 1 : 0);
      } finally {
        failure.mockRestore();
        hintFailure?.mockRestore();
      }
    },
  );

  it('serializes concurrent lease acquisition and parking so a parked receipt never starts', async () => {
    const poison = await receipt(undefined, { poison: true });
    for (let i = 0; i < 8; i++) {
      const waiting = await receipt(chat(poison));
      const claim = await prisma.webhookExecutionClaim.findUniqueOrThrow({
        where: { kind_semanticKey: { kind: 'EXECUTION', semanticKey: waiting.semanticKey! } },
      });
      const token = randomUUID();
      const [parked, started] = await Promise.all([
        quarantine.parkSuccessors(poison.id, [waiting.id]),
        prisma.$transaction(async (tx) => {
          await tx.webhookExecutionClaim.update({
            where: { id: claim.id },
            data: {
              leaseToken: token,
              leaseExpiresAt: new Date(Date.now() + 60_000),
            },
          });
          return WebhookCanonicalExecutionService.transitionLiveUnstartedOwnerWithClient(tx, {
            claimId: claim.id,
            webhookEventId: waiting.id,
            semanticKey: waiting.semanticKey!,
            leaseToken: token,
            executionBotId: claim.executionBotId,
            executionDeadlineAt: waiting.executionDeadlineAt,
            enforced: true,
            phase: 'start',
          });
        }),
      ]);
      expect(parked === 1 && started === 'transitioned').toBe(false);
      const final = await prisma.webhookEvent.findUniqueOrThrow({ where: { id: waiting.id } });
      const finalClaim = await prisma.webhookExecutionClaim.findUniqueOrThrow({
        where: { id: claim.id },
      });
      if (final.status === 'QUARANTINED') expect(finalClaim.businessStartedAt).toBeNull();
    }
  });

  it('caps each pass and rotates unresolved rows through the due index across retained history', async () => {
    const poison = await receipt(undefined, { poison: true });
    const waiting: WebhookEvent[] = [];
    for (let i = 0; i < WEBHOOK_QUARANTINE_BATCH_SIZE + 3; i++)
      waiting.push(await receipt(chat(poison)));
    expect(
      await quarantine.parkSuccessors(
        poison.id,
        waiting.map((row) => row.id),
      ),
    ).toBe(WEBHOOK_QUARANTINE_BATCH_SIZE);
    await quarantine.parkSuccessors(
      poison.id,
      waiting.slice(WEBHOOK_QUARANTINE_BATCH_SIZE).map((row) => row.id),
    );
    await makeDue();
    expect((await quarantine.reconcileDue()).inspected).toBe(WEBHOOK_QUARANTINE_BATCH_SIZE);
    expect((await quarantine.reconcileDue()).inspected).toBe(3);
    const historyIds = Array.from({ length: 10_000 }, () => randomUUID());
    ids.push(...historyIds);
    await prisma.webhookEvent.createMany({
      data: historyIds.map((id) => ({
        id,
        dedupKey: id,
        status: 'QUARANTINED',
        rawPayload: {},
        normalizedPayload: {},
      })),
    });
    await prisma.webhookDependencyQuarantine.createMany({
      data: historyIds.map((receiptId) => ({
        receiptId,
        blockerId: poison.id,
        anchorId: poison.id,
        chatId: chat(poison),
        originalStatus: 'RECEIVED',
        state: 'EXPIRED',
        deadlineAt: new Date(0),
        nextCheckAt: new Date(0),
        resolvedAt: new Date(),
      })),
    });
    for (const dueCount of [0, 2_500]) {
      if (dueCount)
        await prisma.webhookDependencyQuarantine.updateMany({
          where: { receiptId: { in: historyIds.slice(0, dueCount) } },
          data: { state: 'WAITING' },
        });
      await prisma.$executeRaw`ANALYZE webhook_dependency_quarantines`;
      const plan = await prisma.$queryRaw<Array<{ 'QUERY PLAN': unknown }>>(Prisma.sql`
        EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
        SELECT receipt_id, blocker_id, next_check_at FROM webhook_dependency_quarantines
        WHERE state = 'WAITING' AND next_check_at <= CURRENT_TIMESTAMP
        ORDER BY next_check_at, receipt_id, blocker_id LIMIT 16
      `);
      expect(JSON.stringify(plan)).toContain('webhook_dependency_quarantines_due_idx');
      expect(JSON.stringify(plan)).not.toContain('Seq Scan');
      const inspect = (value: unknown) => {
        if (Array.isArray(value)) {
          value.forEach(inspect);
          return;
        }
        if (!value || typeof value !== 'object') return;
        const node = value as Record<string, unknown>;
        if (typeof node['Actual Rows'] === 'number') {
          expect(node['Actual Rows'] * Number(node['Actual Loops'] ?? 1)).toBeLessThanOrEqual(16);
          expect(Number(node['Rows Removed by Filter'] ?? 0)).toBeLessThanOrEqual(16);
        }
        Object.values(node).forEach(inspect);
      };
      // A sort over zero/one eligible row is harmless. Bound actual work at *every*
      // plan node, including a nonempty skewed due population, without planner overrides.
      inspect(plan);
    }
  });
});
