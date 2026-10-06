import { ConfigService } from '@nestjs/config';
import { Queue, type ConnectionOptions } from 'bullmq';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import type { MaxUpdate } from '@maxim/contracts';
import { WebhookPreparationDeferredError } from '../common/webhook-preparation-deferred.error';
import { HealthService } from '../health/health.service';
import { createPrismaClient, type PrismaClient } from '../prisma/prisma-client';
import { ActionHealthService } from '../system/action-health.service';
import { QueueMetricsService } from '../system/queue-metrics.service';
import { SystemModeService } from '../system/system-mode.service';
import { WebhookOutboxService } from './webhook-outbox.service';
import { WebhookParser } from './webhook.parser';
import { WEBHOOK_QUEUE_CRITICAL } from './webhook-queues';
import { WebhookService } from './webhook.service';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const redisUrl = process.env.MAXIM_TEST_REDIS_URL?.trim() ?? '';
const native = databaseUrl && redisUrl ? describe : describe.skip;

// FLAG: Native local stores only. Real ingress/outbox/SystemMode/readiness, no MAX worker.
// Preparation observation proves admission isolation, not completed remote moderation.
native('fleet admission isolation from one unknown ordered scope', () => {
  jest.setTimeout(45_000);
  let prisma: PrismaClient;
  let redis: Redis;
  let queue: Queue;
  let ingress: WebhookService;
  let outbox: WebhookOutboxService;
  let mode: SystemModeService;
  let action: ActionHealthService;
  let health: HealthService;
  let metrics: QueueMetricsService;
  const receipts: string[] = [];
  const chats: string[] = [];
  const deniedMax = jest.fn(() => {
    throw new Error('MAX calls are forbidden');
  });

  beforeAll(async () => {
    for (const [value, database] of [
      [databaseUrl, true],
      [redisUrl, false],
    ] as const) {
      const url = new URL(value);
      if (
        !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
        (database && !url.pathname.includes('race_test'))
      )
        throw new Error('Disposable loopback PostgreSQL/Redis stores required');
    }
    prisma = createPrismaClient(databaseUrl, { max: 8, statement_timeout: 10_000 });
    const [identity] = await prisma.$queryRaw<Array<{ version: string; timezone: string }>>`
      SELECT version(), current_setting('TimeZone') AS timezone`;
    expect(identity?.version).toMatch(/^PostgreSQL 16\./u);
    expect(identity?.timezone).toBe('UTC');
    redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
    queue = new Queue(`fleet-admission-${randomUUID()}`, {
      connection: redis as unknown as ConnectionOptions,
    });
    await queue.waitUntilReady();
    const config = new ConfigService({
      REDIS_URL: redisUrl,
      ENQUEUE_BATCH_SIZE: 400,
      ENQUEUE_CONCURRENCY: 32,
      READINESS_QUEUE_SNAPSHOT_MAX_AGE_MS: 0,
      SYSTEM_MODE_QUEUE_SNAPSHOT_MAX_AGE_MS: 0,
      WEBHOOK_RAW_PAYLOAD_SAMPLE_RATE: 1,
    });
    ingress = new WebhookService(prisma as never, config, {} as never);
    Object.assign(ingress, { maxClient: new Proxy({}, { get: () => deniedMax }) });
    metrics = new QueueMetricsService(
      prisma as never,
      {} as never,
      { get: () => undefined } as never,
      {} as never,
    );
    action = new ActionHealthService(config);
    mode = new SystemModeService(config, metrics, action);
    health = new HealthService(prisma as never, metrics, mode, config);
    outbox = new WebhookOutboxService(
      prisma as never,
      config,
      { get: () => queue } as never,
      { resolveQueueName: async () => WEBHOOK_QUEUE_CRITICAL } as never,
      ingress,
      queue as never,
      queue as never,
      queue as never,
      mode,
    );
  });

  afterAll(async () => {
    await outbox?.onModuleDestroy();
    await health?.onModuleDestroy();
    await mode?.onModuleDestroy();
    await action?.onModuleDestroy();
    await ingress?.onModuleDestroy();
    await prisma?.webhookEvent.deleteMany({ where: { id: { in: receipts } } });
    await prisma?.chat.deleteMany({ where: { id: { in: chats } } });
    await queue?.obliterate({ force: false });
    await queue?.close();
    await redis?.quit();
    await prisma?.$disconnect();
    expect(deniedMax).not.toHaveBeenCalled();
  });

  function update(chatId: string, userId: string, at = Date.now()): MaxUpdate {
    const value = new WebhookParser().parse(
      {
        update_type: 'message_created',
        timestamp: at,
        message: {
          sender: { user_id: userId, name: 'Native fixture', is_bot: false },
          recipient: { chat_id: chatId, chat_type: 'chat' },
          timestamp: at,
          body: { mid: randomUUID(), text: 'Ordinary human text' },
        },
      },
      { botId: 'major-1' },
    );
    value.updateId = randomUUID();
    return value;
  }

  it('admits quiet chats at configured capacity while preserving the hot unknown fence and raw lag', async () => {
    const catalogue = Array.from({ length: 10_000 }, (_, i) => `-fleet-${randomUUID()}-${i}`);
    chats.push(...catalogue);
    await prisma.chat.createMany({
      data: catalogue.map((id) => ({
        id,
        entityType: 'CHAT' as const,
        title: 'Native fleet fixture',
      })),
    });
    const old = new Date(Date.now() - 600_000);
    const poisonId = randomUUID();
    receipts.push(poisonId);
    const poison = update(catalogue[0]!, 'poison', old.getTime() - 1000);
    await prisma.webhookEvent.create({
      data: {
        id: poisonId,
        dedupKey: poisonId,
        botId: 'major-1',
        status: 'FAILED',
        createdAt: new Date(old.getTime() - 1000),
        rawPayload: {},
        normalizedPayload: JSON.parse(JSON.stringify(poison)),
        errorMessage:
          'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:LEGACY_EXECUTION_UNVERIFIED; exact effects proof required',
      },
    });
    await prisma.webhookEvent.createMany({
      data: Array.from({ length: 800 }, (_, i) => {
        const id = randomUUID();
        receipts.push(id);
        return {
          id,
          dedupKey: id,
          botId: 'major-1',
          status: 'RECEIVED' as const,
          createdAt: old,
          rawPayload: {},
          normalizedPayload: JSON.parse(
            JSON.stringify(update(catalogue[0]!, `hot-${i}`, old.getTime())),
          ),
        };
      }),
    });
    const quietIds: string[] = [];
    for (const chatId of catalogue.slice(-3)) {
      const stored = await ingress.storeReceipt(update(chatId, randomUUID()), null);
      expect(stored.duplicate).toBe(false);
      receipts.push(stored.webhookEventId!);
      quietIds.push(stored.webhookEventId!);
    }
    await mode.evaluateAutoMode();
    expect(await mode.getEffectiveSnapshot()).toMatchObject({
      mode: 'degrade',
      condition: 'queue_backlog',
    });
    const internals = outbox as unknown as {
      resolveEnqueueAdmission(
        now: Date,
      ): Promise<{ degraded: boolean; batchSize: number; enqueueConcurrency: number }>;
      enqueueBatch(): Promise<void>;
      findOrderedWebhookHeadsForChats(ids: string[]): Promise<Map<string, { id: string }>>;
    };
    expect(await internals.resolveEnqueueAdmission(new Date())).toMatchObject({
      degraded: false,
      batchSize: 400,
      enqueueConcurrency: 32,
    });
    const admission = jest
      .spyOn(ingress, 'preparePersistedWebhookEvent')
      .mockImplementation(async () => {
        throw new WebhookPreparationDeferredError('native_preparation_boundary', 1000);
      });
    await internals.enqueueBatch();
    expect(new Set(admission.mock.calls.map(([id]) => id))).toEqual(new Set(quietIds));
    expect(
      (await internals.findOrderedWebhookHeadsForChats([catalogue[0]!])).get(catalogue[0]!)?.id,
    ).toBe(poisonId);
    const ready = await health.ready();
    expect(ready.checks.database).toBe(true);
    expect(ready.checks.redis).toBe(true);
    expect(ready.checks.queueLag.ok).toBe(false);
    expect((await metrics.getLagSnapshot({ maxAgeMs: 0 })).effectiveLagSec).toBeGreaterThan(590);
    expect(await queue.getJobCounts('wait', 'active', 'prioritized')).toEqual({
      wait: 0,
      active: 0,
      prioritized: 0,
    });
    admission.mockRestore();
  });

  it('polls fresh independent receipts while a prior preparation remains in flight in real stores', async () => {
    await prisma.webhookEvent.deleteMany({ where: { id: { in: receipts } } });
    const slowChat = `-slow-poll-${randomUUID()}`;
    const freshChat = `-fresh-poll-${randomUUID()}`;
    chats.push(slowChat, freshChat);
    await prisma.chat.createMany({
      data: [slowChat, freshChat].map((id) => ({
        id,
        title: 'Poll isolation',
        entityType: 'CHAT' as const,
      })),
    });
    const slow = await ingress.storeReceipt(update(slowChat, randomUUID()), null);
    receipts.push(slow.webhookEventId!);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const admission = jest
      .spyOn(ingress, 'preparePersistedWebhookEvent')
      .mockImplementation(async (id) => {
        if (id === slow.webhookEventId) await pending;
        throw new WebhookPreparationDeferredError('native_preparation_boundary', 1_000);
      });
    const internals = outbox as unknown as {
      enqueueBatch(): Promise<void>;
      activeEnqueueUnits: Map<string, Promise<void>>;
    };
    try {
      await internals.enqueueBatch();
      expect(internals.activeEnqueueUnits.size).toBe(1);
      const next = await ingress.storeReceipt(update(slowChat, randomUUID()), null);
      const fresh = await ingress.storeReceipt(update(freshChat, randomUUID()), null);
      receipts.push(next.webhookEventId!, fresh.webhookEventId!);
      await internals.enqueueBatch();
      expect(admission.mock.calls.map(([id]) => id)).toEqual([
        slow.webhookEventId,
        fresh.webhookEventId,
      ]);
      expect(
        await prisma.webhookEvent.findUnique({ where: { id: next.webhookEventId! } }),
      ).toMatchObject({ status: 'RECEIVED', enqueueAttempts: 0, nextEnqueueAt: null });
      expect(internals.activeEnqueueUnits.size).toBe(1);
    } finally {
      release();
      await Promise.all(internals.activeEnqueueUnits.values());
      admission.mockRestore();
    }
  });
});
