import { ConfigService } from '@nestjs/config';
import { Queue, type ConnectionOptions } from 'bullmq';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import type { MaxUpdate } from '@maxim/contracts';
import { WebhookPreparationDeferredError } from '../common/webhook-preparation-deferred.error';
import { HealthService } from '../health/health.service';
import { createPrismaClient, Prisma, type PrismaClient } from '../prisma/prisma-client';
import { DEFAULT_MAX_PUBLISHER_BOT_ID } from '../publisher/publisher-bot-descriptor';
import { ActionHealthService } from '../system/action-health.service';
import { QueueMetricsService } from '../system/queue-metrics.service';
import { SystemModeService } from '../system/system-mode.service';
import { WebhookOutboxService } from './webhook-outbox.service';
import { WebhookParser } from './webhook.parser';
import { WEBHOOK_QUEUE_CRITICAL } from './webhook-queues';
import { WebhookService } from './webhook.service';
import { buildWebhookSemanticEventKey } from './webhook-semantic-event-key';
import { WebhookLegacyHoldService } from './webhook-legacy-hold.service';
import { DeferredWebhookScopes, type DeferredScopeState } from './webhook-outbox-deferred-scopes';
import { WebhookPreparationAdmission } from './webhook-preparation-admission';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const redisUrl = process.env.MAXIM_TEST_REDIS_URL?.trim() ?? '';
const native = databaseUrl && redisUrl ? describe : describe.skip;

// FLAG: Native local stores only. Real ingress/outbox/SystemMode/readiness, no MAX worker.
// Preparation observation proves admission isolation, not completed remote moderation.
native('fleet admission isolation from one unknown ordered scope', () => {
  jest.setTimeout(45_000);
  let prisma: PrismaClient;
  let redis: Redis;
  let ownsRedis = false;
  let queue: Queue;
  let ingress: WebhookService;
  let outbox: WebhookOutboxService;
  let mode: SystemModeService;
  let action: ActionHealthService;
  let health: HealthService;
  let metrics: QueueMetricsService;
  const receipts: string[] = [];
  const chats: string[] = [];
  const completedClaimIds: string[] = [];
  const holdCertificateIds: string[] = [];
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
    // FLAG: Queue names do not isolate global action-health or system-mode keys.
    // Own an empty local database so other native suites cannot throttle this fixture.
    const redisTarget = new URL(redisUrl);
    redisTarget.pathname = '/11';
    const fixtureRedisUrl = redisTarget.toString();
    redis = new Redis(fixtureRedisUrl, {
      maxRetriesPerRequest: null,
      commandTimeout: 10_000,
    });
    expect(await redis.info('server')).toMatch(/^redis_version:7\./mu);
    if (await redis.dbsize()) throw new Error('Disposable fleet Redis database is occupied');
    ownsRedis = true;
    queue = new Queue(`fleet-admission-${randomUUID()}`, {
      connection: redis as unknown as ConnectionOptions,
    });
    await queue.waitUntilReady();
    const config = new ConfigService({
      REDIS_URL: fixtureRedisUrl,
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
    const legacyHolds = new WebhookLegacyHoldService(prisma as never);
    Object.assign(ingress, { legacyHolds });
    Object.assign(outbox, { legacyHolds });
  });

  afterAll(async () => {
    await outbox?.onModuleDestroy();
    await health?.onModuleDestroy();
    await mode?.onModuleDestroy();
    await action?.onModuleDestroy();
    await ingress?.onModuleDestroy();
    await removeCompletedMirrorProofs();
    await prisma?.webhookEvent.deleteMany({ where: { id: { in: receipts } } });
    await prisma?.chat.deleteMany({ where: { id: { in: chats } } });
    await queue?.obliterate({ force: false });
    await queue?.close();
    if (ownsRedis) await redis.flushdb();
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

  async function removeCompletedMirrorProofs() {
    if (!prisma) return;
    await prisma.webhookLegacyRecovery.deleteMany({
      where: { certificateId: { in: holdCertificateIds } },
    });
    await prisma.webhookLegacyQuiescenceCertificate.deleteMany({
      where: { id: { in: holdCertificateIds.splice(0) } },
    });
    await prisma.webhookExecutionClaim.deleteMany({
      where: { id: { in: completedClaimIds.splice(0) } },
    });
  }

  function completedMirrorRecovery() {
    return outbox as unknown as {
      enqueueBatch(): Promise<void>;
      findOrderedWebhookHeadsForChats(
        ids: readonly string[],
      ): Promise<Map<string, { id: string; createdAt: Date }>>;
      recoverCompletedOrderedHeadMirrors(
        heads: ReadonlyMap<string, { id: string; createdAt: Date }>,
        concurrency?: number,
      ): Promise<number>;
      completedOrderedHeadMirrorsQuery(ids: readonly string[]): Prisma.Sql;
      completedOrderedHeadMirrorGuardQuery(id: string): Prisma.Sql;
      activeEnqueueUnits: Map<string, Promise<void>>;
      enqueueScans: Map<string, unknown>;
      pendingEnqueueRepresentatives: Map<string, string>;
      nextCompletedHeadRecoveryAt: number;
      completedHeadRecoveryOffset: number;
      completedMirrorRecoveryOffset: number;
      publisherBotId: string;
    };
  }

  async function completedMirror(tombstone = false) {
    const chatId = `-completed-mirror-${randomUUID()}`;
    chats.push(chatId);
    await prisma.chat.create({
      data: { id: chatId, title: 'Completed mirror recovery', entityType: 'CHAT' },
    });
    const sourceAt = new Date(Date.now() - 600_000);
    const payload = update(chatId, randomUUID(), sourceAt.getTime());
    const semanticKey = buildWebhookSemanticEventKey(payload)!;
    const completedAt = new Date(Date.now() - 1_000);
    const owner = await prisma.webhookEvent.create({
      data: {
        dedupKey: randomUUID(),
        botId: payload.botId,
        semanticKey,
        createdAt: sourceAt,
        executionDeadlineAt: new Date(sourceAt.getTime() + 300_000),
        status: 'PROCESSED',
        processedAt: completedAt,
        rawPayload: {},
        normalizedPayload: payload as unknown as Prisma.InputJsonValue,
      },
    });
    receipts.push(owner.id);
    const mirroredPayload = { ...payload, botId: 'major-2', updateId: randomUUID() };
    const mirror = await prisma.webhookEvent.create({
      data: {
        dedupKey: randomUUID(),
        botId: mirroredPayload.botId,
        semanticKey,
        createdAt: new Date(sourceAt.getTime() + 1),
        executionDeadlineAt: owner.executionDeadlineAt,
        rawPayload: {},
        normalizedPayload: mirroredPayload as unknown as Prisma.InputJsonValue,
      },
    });
    receipts.push(mirror.id);
    const claim = await prisma.webhookExecutionClaim.create({
      data: {
        kind: 'EXECUTION',
        semanticKey,
        webhookEventId: owner.id,
        executionBotId: payload.botId,
        enforced: true,
        status: 'COMPLETED',
        preparedAt: new Date(completedAt.getTime() - 2_000),
        businessStartedAt: new Date(completedAt.getTime() - 1_000),
        completedAt,
      },
    });
    completedClaimIds.push(claim.id);
    if (tombstone) await prisma.webhookEvent.delete({ where: { id: owner.id } });
    return { chatId, owner, mirror, claim, payload: mirroredPayload };
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

  it('retains a waiting Start across saturated polls and admits it before older ordinary refills', async () => {
    await prisma.webhookEvent.deleteMany({ where: { id: { in: receipts } } });
    const base = Date.now() - 10_000;
    const rows = ['ordinary', 'interactive'].map((workClass, index) => {
      const id = randomUUID();
      receipts.push(id);
      const payload = update(`-priority-native-${id}`, randomUUID(), base + index);
      payload.botId = `waiting-${workClass}`;
      if (workClass === 'interactive') payload.message!.text = 'Старт';
      return {
        id,
        dedupKey: id,
        botId: payload.botId,
        status: 'RECEIVED' as const,
        createdAt: new Date(base + index),
        rawPayload: {},
        normalizedPayload: JSON.parse(JSON.stringify(payload)),
      };
    });
    await prisma.webhookEvent.create({ data: rows[0]! });
    const preparation = new WebhookPreparationAdmission(12, () => {});
    const previousPreparation = (
      ingress as unknown as { preparationAdmission: WebhookPreparationAdmission }
    ).preparationAdmission;
    Object.assign(ingress, { preparationAdmission: preparation });
    Object.assign(outbox, {
      deferredEnqueueScopes: new DeferredWebhookScopes(),
      pendingEnqueueRepresentatives: new Map(),
      enqueueScans: new Map(),
    });
    const internal = outbox as unknown as {
      enqueueBatch(): Promise<void>;
      activeEnqueueUnits: Map<string, Promise<void>>;
      pendingEnqueueRepresentatives: Map<string, string>;
    };
    const releases: Array<() => void> = [];
    const hold = () =>
      new Promise<void>((resolve) => {
        releases.push(resolve);
      });
    const owners = ['a', 'a', 'b', 'b', 'c', 'c'].map((bot) => {
      const held = hold();
      return preparation.run(bot, 'ordinary', () => held);
    });
    const commandHold = hold();
    const admitted: string[] = [];
    const body = jest
      .spyOn(
        ingress as unknown as {
          preparePersistedWebhookEventAdmitted(id: string): Promise<unknown>;
        },
        'preparePersistedWebhookEventAdmitted',
      )
      .mockImplementation(async (id) => {
        admitted.push(id);
        if (id === rows[1]!.id) await commandHold;
        await prisma.webhookEvent.updateMany({
          where: { id, status: 'RECEIVED' },
          data: { status: 'PROCESSED', processedAt: new Date() },
        });
        return { canonical: false, prepared: false, normalizedPayload: null, executionBotId: null };
      });
    try {
      await internal.enqueueBatch();
      expect(admitted).toEqual([]);
      expect([...internal.pendingEnqueueRepresentatives.values()]).toEqual([rows[0]!.id]);
      await prisma.webhookEvent.create({ data: rows[1]! });
      await internal.enqueueBatch();
      expect(admitted).toEqual([]);
      expect([...internal.pendingEnqueueRepresentatives.values()]).toEqual([
        rows[0]!.id,
        rows[1]!.id,
      ]);
      releases[5]!();
      await owners[5];
      await internal.enqueueBatch();
      expect(admitted).toEqual([rows[1]!.id]);
      expect(preparation.snapshot()).toMatchObject({ inFlight: 6, ordinary: 5, interactive: 1 });
      expect(internal.activeEnqueueUnits.size).toBe(1);
      await internal.enqueueBatch();
      expect(admitted).toEqual([rows[1]!.id]);
      expect(internal.activeEnqueueUnits.size).toBe(1);
      expect(await prisma.webhookEvent.findUnique({ where: { id: rows[0]!.id } })).toMatchObject({
        status: 'RECEIVED',
        enqueueAttempts: 0,
        nextEnqueueAt: null,
      });
      releases[6]!();
      await Promise.all(internal.activeEnqueueUnits.values());
      await internal.enqueueBatch();
      expect(admitted).toEqual([rows[1]!.id, rows[0]!.id]);
      expect(preparation.snapshot()).toMatchObject({ inFlight: 5, ordinary: 5, interactive: 0 });
    } finally {
      releases.forEach((release) => release());
      await Promise.all(owners);
      await Promise.all(internal.activeEnqueueUnits.values());
      body.mockRestore();
      Object.assign(ingress, { preparationAdmission: previousPreparation });
      Object.assign(outbox, {
        deferredEnqueueScopes: new DeferredWebhookScopes(),
        pendingEnqueueRepresentatives: new Map(),
      });
    }
  });

  it('admits a middle chat across capped rotating pages with permanently blocked neighboring heads', async () => {
    await prisma.webhookEvent.deleteMany({ where: { id: { in: receipts } } });
    const catalogue = Array.from({ length: 1500 }, () => `-scan-fleet-${randomUUID()}`);
    chats.push(...catalogue);
    await prisma.chat.createMany({
      data: catalogue.map((id) => ({ id, title: 'Rotating fleet', entityType: 'CHAT' as const })),
    });
    const base = Date.now() - 120_000;
    const independentIndex = 600;
    let independentId = '';
    const rows = catalogue.flatMap((chatId, index): Prisma.WebhookEventCreateManyInput[] => {
      const id = randomUUID();
      receipts.push(id);
      if (index === independentIndex) independentId = id;
      const receipt = {
        id,
        dedupKey: id,
        botId: 'major-1',
        status: 'RECEIVED' as const,
        createdAt: new Date(base + index),
        rawPayload: {},
        normalizedPayload: JSON.parse(JSON.stringify(update(chatId, randomUUID(), base + index))),
        errorMessage: null as string | null,
      };
      if (index === independentIndex) return [receipt];
      const poisonId = randomUUID();
      receipts.push(poisonId);
      return [
        {
          ...receipt,
          id: poisonId,
          dedupKey: poisonId,
          status: 'FAILED' as const,
          createdAt: new Date(base - 1000),
          errorMessage:
            'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:LEGACY_EXECUTION_UNVERIFIED; exact effects proof required',
        },
        receipt,
      ];
    });
    await prisma.webhookEvent.createMany({ data: rows });
    const internals = outbox as unknown as {
      enqueueBatch(): Promise<void>;
      enqueueScans: Map<string, unknown>;
      activeEnqueueUnits: Map<string, Promise<void>>;
    };
    internals.enqueueScans = new Map();
    const admission = jest
      .spyOn(ingress, 'preparePersistedWebhookEvent')
      .mockImplementation(async () => {
        throw new WebhookPreparationDeferredError('native_preparation_boundary', 60_000);
      });
    try {
      // FLAG: Several full SQL cursor cycles must reach the middle independent chat
      // through final priority and dispatch while every unknown predecessor stays fenced.
      for (let pass = 0; pass < 16 && admission.mock.calls.length === 0; pass += 1)
        await internals.enqueueBatch();
      expect(admission.mock.calls.map(([id]) => id)).toEqual([independentId]);
      expect(
        await prisma.webhookEvent.count({ where: { id: { in: receipts }, status: 'FAILED' } }),
      ).toBe(catalogue.length - 1);
    } finally {
      await Promise.all(internals.activeEnqueueUnits.values());
      admission.mockRestore();
    }
  });

  it('preserves scope overflow through native bounded pages without stopping independent bot discovery', async () => {
    await prisma.webhookEvent.deleteMany({ where: { id: { in: receipts } } });
    const count = 1200;
    const independentIndex = 600;
    const base = Date.now() - 120_000;
    const rows = Array.from({ length: count }, (_, index) => {
      const id = randomUUID();
      receipts.push(id);
      const payload = update(`-scope-native-${id}`, randomUUID(), base + index);
      payload.botId = index === independentIndex ? 'independent-bot' : 'major-1';
      return {
        id,
        dedupKey: id,
        botId: payload.botId,
        status: 'RECEIVED' as const,
        createdAt: new Date(base + index),
        rawPayload: {},
        normalizedPayload: JSON.parse(JSON.stringify(payload)),
      };
    });
    await prisma.webhookEvent.createMany({ data: rows });
    const state = new DeferredWebhookScopes();
    const preparation = new WebhookPreparationAdmission(12, () => {});
    const previousPreparation = (
      ingress as unknown as { preparationAdmission: WebhookPreparationAdmission }
    ).preparationAdmission;
    Object.assign(ingress, { preparationAdmission: preparation });
    Object.assign(outbox, {
      deferredEnqueueScopes: state,
      pendingEnqueueRepresentatives: new Map(),
      enqueueScans: new Map(),
    });
    const internal = outbox as unknown as {
      enqueueBatch(): Promise<void>;
      selectEnqueueCandidates(): Promise<unknown[]>;
      deferredScopePageQuery(state: DeferredScopeState): Prisma.Sql;
      activeEnqueueUnits: Map<string, Promise<void>>;
    };
    const admitted: string[] = [];
    const body = jest
      .spyOn(
        ingress as unknown as {
          preparePersistedWebhookEventAdmitted(id: string): Promise<unknown>;
        },
        'preparePersistedWebhookEventAdmitted',
      )
      .mockImplementation(async (id) => {
        admitted.push(id);
        await prisma.webhookEvent.updateMany({
          where: { id, status: 'RECEIVED' },
          data: { status: 'PROCESSED', processedAt: new Date() },
        });
        return { canonical: false, prepared: false, normalizedPayload: null, executionBotId: null };
      });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const owners = [0, 1].map(() => preparation.run('major-1', 'ordinary', () => held));
    let selection: jest.SpyInstance | undefined;
    try {
      for (let pass = 0; pass < 30 && !admitted.includes(rows[independentIndex]!.id); pass++) {
        await internal.enqueueBatch();
        expect(state.snapshot().identities).toBeLessThanOrEqual(2);
        expect(state.snapshot().scopes).toBeLessThanOrEqual(1);
      }
      expect(admitted).toEqual([rows[independentIndex]!.id]);
      expect(state.snapshot().intervals).toBeGreaterThan(0);

      const planState: DeferredScopeState = {
        key: 'native-plan',
        scope: null,
        current: { first: rows[0]!, last: rows.at(-1)! },
        next: null,
        after: null,
        retained: new Map(),
      };
      const planRows = await prisma.$queryRaw<Array<{ 'QUERY PLAN': unknown }>>(
        Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${internal.deferredScopePageQuery(planState)}`,
      );
      const accesses: Record<string, unknown>[] = [];
      const visit = (value: unknown) => {
        if (Array.isArray(value)) for (const item of value) visit(item);
        else if (value && typeof value === 'object') {
          const node = value as Record<string, unknown>;
          if (node['Relation Name'] === 'webhook_events') accesses.push(node);
          for (const child of Object.values(node)) visit(child);
        }
      };
      visit(planRows[0]?.['QUERY PLAN']);
      expect(accesses.length).toBeGreaterThanOrEqual(4);
      expect(
        accesses.every((node) =>
          ['Index Scan', 'Index Only Scan'].includes(String(node['Node Type'])),
        ),
      ).toBe(true);
      expect(
        accesses.every((node) => !String(node.Filter ?? '').includes('normalized_payload')),
      ).toBe(true);
      expect(
        accesses.reduce(
          (sum, node) => sum + Number(node['Actual Rows']) * Number(node['Actual Loops']),
          0,
        ),
      ).toBeLessThanOrEqual(260);

      // No normal selector may rescue these skipped representatives in this phase.
      // Only the retained scope intervals can reach the overflow chat after A frees.
      selection = jest.spyOn(internal, 'selectEnqueueCandidates').mockResolvedValue([]);
      release();
      await Promise.all(owners);
      for (let pass = 0; pass < 80 && !admitted.includes(rows[40]!.id); pass++) {
        await internal.enqueueBatch();
        expect(state.snapshot().identities).toBeLessThanOrEqual(2);
      }
      expect(admitted).toContain(rows[40]!.id);
      expect(new Set(admitted).size).toBe(admitted.length);
    } finally {
      release();
      await Promise.all(owners);
      await Promise.all(internal.activeEnqueueUnits.values());
      selection?.mockRestore();
      body.mockRestore();
      Object.assign(ingress, { preparationAdmission: previousPreparation });
      Object.assign(outbox, {
        deferredEnqueueScopes: new DeferredWebhookScopes(),
        pendingEnqueueRepresentatives: new Map(),
      });
    }
  });

  it.each(['admitted', 'terminal'] as const)(
    'preserves native cross-bot same-chat debt after an earlier retained receipt is %s',
    async (earlierState) => {
      await prisma.webhookEvent.deleteMany({ where: { id: { in: receipts } } });
      const base = Date.now() - 60_000;
      const chatId = `-native-cross-scope-${randomUUID()}`;
      const source = [0, 1, 2].map((index) => {
        const id = randomUUID();
        receipts.push(id);
        const payload = update(
          index === 2 ? `${chatId}-anchor` : chatId,
          randomUUID(),
          base + index,
        );
        payload.botId = index === 1 ? 'independent-bot' : 'major-1';
        return {
          id,
          dedupKey: id,
          botId: payload.botId,
          status: 'RECEIVED' as const,
          createdAt: new Date(base + index),
          rawPayload: {},
          normalizedPayload: JSON.parse(JSON.stringify(payload)),
        };
      });
      await prisma.webhookEvent.createMany({ data: source });
      const state = new DeferredWebhookScopes();
      Object.assign(outbox, {
        deferredEnqueueScopes: state,
        pendingEnqueueRepresentatives: new Map(),
      });
      const internal = outbox as unknown as {
        enqueueCandidates(rows: unknown[]): Promise<unknown>;
        readDeferredEnqueueRepresentatives(now: Date, take: number): Promise<object[]>;
        mergeEnqueueCandidates(rows: object[], take: number): object[];
        activeEnqueueUnits: Map<string, Promise<void>>;
      };
      const preparation = jest
        .spyOn(ingress, 'preparePersistedWebhookEvent')
        .mockImplementation(async (id) => {
          await prisma.webhookEvent.updateMany({
            where: { id, status: 'RECEIVED' },
            data: { status: 'PROCESSED', processedAt: new Date() },
          });
          return {
            canonical: false,
            prepared: false,
            normalizedPayload: null,
            executionBotId: null,
          } as never;
        });
      try {
        const scope = { botId: 'major-1', workClass: 'ordinary' as const };
        state.capture(scope, 'event:absent', { id: 'absent', createdAt: new Date(base - 1) });
        state.capture(scope, `chat:${chatId}`, source[0]!);
        state.capture(scope, `chat:${chatId}-anchor`, source[2]!);
        for (let pass = 0; pass < 3; pass++)
          await internal.readDeferredEnqueueRepresentatives(new Date(), 100);
        expect(state.snapshot()).toEqual({ scopes: 2, identities: 3, intervals: 0 });
        if (earlierState === 'terminal')
          await prisma.webhookEvent.update({
            where: { id: source[0]!.id },
            data: { status: 'PROCESSED', processedAt: new Date() },
          });
        const first = await internal.readDeferredEnqueueRepresentatives(new Date(), 100);
        if (earlierState === 'admitted') {
          // Actual merge coalesces A/B to A. No chat expansion or normal discovery
          // supplies B later; only B's independent exact responsibility remains.
          await internal.enqueueCandidates(
            internal.mergeEnqueueCandidates(first, 100).map((row) => ({ ...row, priority: 5 })),
          );
        }
        expect(state.identities(100).map(({ id }) => id)).toContain(source[1]!.id);
        const second = await internal.readDeferredEnqueueRepresentatives(new Date(), 100);
        await internal.enqueueCandidates(
          internal.mergeEnqueueCandidates(second, 100).map((row) => ({ ...row, priority: 5 })),
        );
        expect(preparation.mock.calls.map(([id]) => id)).toContain(source[1]!.id);
      } finally {
        await Promise.all(internal.activeEnqueueUnits.values());
        preparation.mockRestore();
        Object.assign(outbox, {
          deferredEnqueueScopes: new DeferredWebhookScopes(),
          pendingEnqueueRepresentatives: new Map(),
        });
      }
    },
  );

  it('reloads a missing physical head from native scope debt and leaves nonordered events independent', async () => {
    await prisma.webhookEvent.deleteMany({ where: { id: { in: receipts } } });
    const base = Date.now() - 60_000;
    const chatId = `-native-missing-head-${randomUUID()}`;
    const source = [0, 1, 2].map((index) => {
      const id = randomUUID();
      receipts.push(id);
      const payload = update(chatId, randomUUID(), base + index);
      if (index === 2) payload.type = 'message_callback';
      return {
        id,
        dedupKey: id,
        botId: 'major-1',
        status: 'RECEIVED' as const,
        createdAt: new Date(base + index),
        rawPayload: {},
        normalizedPayload: JSON.parse(JSON.stringify(payload)),
      };
    });
    await prisma.webhookEvent.createMany({ data: source });
    const rows = await prisma.webhookEvent.findMany({
      where: { id: { in: source.map((row) => row.id) } },
      orderBy: { createdAt: 'asc' },
    });
    Object.assign(outbox, {
      deferredEnqueueScopes: new DeferredWebhookScopes(),
      pendingEnqueueRepresentatives: new Map(),
    });
    const internal = outbox as unknown as {
      enqueueCandidates(rows: unknown[]): Promise<unknown>;
      readDeferredEnqueueRepresentatives(now: Date, take: number): Promise<object[]>;
      deferredEnqueueScopes: DeferredWebhookScopes;
    };
    const preparation = jest
      .spyOn(ingress, 'preparePersistedWebhookEvent')
      .mockImplementation(async (id) => {
        await prisma.webhookEvent.updateMany({
          where: { id, status: 'RECEIVED' },
          data: { status: 'PROCESSED', processedAt: new Date() },
        });
        return {
          canonical: false,
          prepared: false,
          normalizedPayload: null,
          executionBotId: null,
        } as never;
      });
    try {
      await internal.enqueueCandidates(
        [rows[1], rows[2]].map((row) => ({ ...row, isBacklogScan: true, priority: 5 })),
      );
      expect(preparation.mock.calls.map(([id]) => id)).toEqual([rows[2]!.id]);
      expect(internal.deferredEnqueueScopes.snapshot().intervals).toBe(1);
      const heads = await internal.readDeferredEnqueueRepresentatives(new Date(), 100);
      await internal.enqueueCandidates(heads.map((row) => ({ ...row, priority: 5 })));
      expect(preparation.mock.calls.map(([id]) => id)).toEqual([rows[2]!.id, rows[0]!.id]);
      expect(await prisma.webhookEvent.findUnique({ where: { id: rows[1]!.id } })).toMatchObject({
        status: 'RECEIVED',
        enqueueAttempts: 0,
      });
    } finally {
      preparation.mockRestore();
      Object.assign(outbox, {
        deferredEnqueueScopes: new DeferredWebhookScopes(),
        pendingEnqueueRepresentatives: new Map(),
      });
    }
  });

  it('starts reserved receipts across poll deadlines while stale queue repairs remain eligible', async () => {
    await prisma.webhookEvent.deleteMany({ where: { id: { in: receipts } } });
    const staleCount = 60;
    const freshCount = 80;
    const catalogue = Array.from(
      { length: staleCount + freshCount },
      () => `-fifo-${randomUUID()}`,
    );
    chats.push(...catalogue);
    await prisma.chat.createMany({
      data: catalogue.map((id) => ({ id, title: 'Dispatch FIFO', entityType: 'CHAT' as const })),
    });
    const queuedAt = new Date(Date.now() - 300_000);
    const rows = catalogue.map((chatId, index) => {
      const id = randomUUID();
      receipts.push(id);
      const stale = index < staleCount;
      const createdAt = new Date((stale ? queuedAt.getTime() : Date.now() - 1000) + index);
      return {
        id,
        dedupKey: id,
        botId: 'major-1',
        status: stale ? ('QUEUED' as const) : ('RECEIVED' as const),
        queueName: stale ? WEBHOOK_QUEUE_CRITICAL : null,
        queuedAt: stale ? queuedAt : null,
        createdAt,
        rawPayload: {},
        normalizedPayload: JSON.parse(
          JSON.stringify(update(chatId, randomUUID(), createdAt.getTime())),
        ),
      };
    });
    await prisma.webhookEvent.createMany({ data: rows });
    await queue.addBulk(
      rows.slice(0, staleCount).map(({ id }) => ({
        name: 'process-webhook-event',
        data: { webhookEventId: id },
        opts: { jobId: id },
      })),
    );
    const internals = outbox as unknown as {
      enqueueBatch(): Promise<void>;
      enqueueScans: Map<string, unknown>;
      pendingEnqueueRepresentatives: Map<string, string>;
      activeEnqueueUnits: Map<string, Promise<void>>;
      webhookRoutingService: { resolveQueueName(id: string, update: unknown): Promise<string> };
    };
    internals.enqueueScans = new Map();
    internals.pendingEnqueueRepresentatives = new Map();
    const admission = jest
      .spyOn(ingress, 'preparePersistedWebhookEvent')
      .mockImplementation(async (_id, _fallback, snapshot) => ({
        canonical: true,
        prepared: true,
        normalizedPayload: snapshot,
        executionBotId: 'major-1',
        enforced: false,
      }));
    let release: () => void = () => undefined;
    let gate = Promise.resolve();
    const routing = jest
      .spyOn(internals.webhookRoutingService, 'resolveQueueName')
      .mockImplementation(async () => {
        await gate;
        return WEBHOOK_QUEUE_CRITICAL;
      });
    try {
      const freshIds: string[] = rows.slice(staleCount).map(({ id }) => id);
      const changedWhilePending = new Set<string>();
      for (let pass = 0; pass < 4; pass += 1) {
        gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        await internals.enqueueBatch();
        expect(internals.activeEnqueueUnits.size).toBeLessThanOrEqual(32);
        expect(internals.pendingEnqueueRepresentatives.size).toBeLessThanOrEqual(100);
        if (pass === 0) {
          expect(internals.activeEnqueueUnits.size).toBe(32);
          const pendingFresh = Array.from(internals.pendingEnqueueRepresentatives.values()).filter(
            (id) => freshIds.includes(id),
          );
          expect(pendingFresh.length).toBeGreaterThan(2);
          const [completed, deferred] = pendingFresh;
          changedWhilePending.add(completed!);
          changedWhilePending.add(deferred!);
          await prisma.webhookEvent.update({
            where: { id: completed! },
            data: { status: 'PROCESSED', processedAt: new Date() },
          });
          await prisma.webhookEvent.update({
            where: { id: deferred! },
            data: { nextEnqueueAt: new Date(Date.now() + 60_000) },
          });
        }
        // FLAG: Complete the slow handoff between polls. Waiting Bull jobs retain
        // their original queuedAt, so their same old repair heads stay eligible.
        release();
        await Promise.all(internals.activeEnqueueUnits.values());
        const prepared = new Set(admission.mock.calls.map(([id]) => id));
        if (freshIds.every((id) => changedWhilePending.has(id) || prepared.has(id))) break;
      }
      const prepared = new Set(admission.mock.calls.map(([id]) => id));
      expect(freshIds.filter((id) => prepared.has(id))).toHaveLength(
        freshCount - changedWhilePending.size,
      );
      expect(Array.from(changedWhilePending).some((id) => prepared.has(id))).toBe(false);
      expect(
        await prisma.webhookEvent.count({
          where: {
            id: { in: rows.slice(0, staleCount).map(({ id }) => id) },
            status: 'QUEUED',
            queuedAt,
            nextEnqueueAt: null,
          },
        }),
      ).toBe(staleCount);
    } finally {
      release();
      await Promise.all(internals.activeEnqueueUnits.values());
      admission.mockRestore();
      routing.mockRestore();
    }
  });

  describe('completed ordered mirror recovery before preparation', () => {
    beforeEach(async () => {
      const lane = completedMirrorRecovery();
      await Promise.all(lane.activeEnqueueUnits.values());
      await removeCompletedMirrorProofs();
      await prisma.webhookEvent.deleteMany({ where: { id: { in: receipts.splice(0) } } });
      lane.enqueueScans = new Map();
      lane.pendingEnqueueRepresentatives = new Map();
      lane.nextCompletedHeadRecoveryAt = 0;
      lane.completedHeadRecoveryOffset = 0;
      lane.completedMirrorRecoveryOffset = 0;
      lane.publisherBotId = DEFAULT_MAX_PUBLISHER_BOT_ID;
    });

    it.each([false, true])(
      'settles a proven completed mirror without preparation or MAX (tombstone=%s)',
      async (tombstone) => {
        const fixture = await completedMirror(tombstone);
        const lane = completedMirrorRecovery();
        const preparation = jest.spyOn(ingress, 'preparePersistedWebhookEvent');
        const admission = jest.spyOn(ingress, 'webhookPreparationSchedulingState');
        try {
          const heads = await lane.findOrderedWebhookHeadsForChats([fixture.chatId]);
          expect(heads.get(fixture.chatId)?.id).toBe(fixture.mirror.id);
          expect(await lane.recoverCompletedOrderedHeadMirrors(heads)).toBe(1);
          expect(
            await prisma.webhookEvent.findUnique({ where: { id: fixture.mirror.id } }),
          ).toMatchObject({
            status: 'DUPLICATE',
            processedAt: fixture.claim.completedAt,
            normalizedPayload: fixture.mirror.normalizedPayload,
            executionDeadlineAt: fixture.mirror.executionDeadlineAt,
            enqueueAttempts: 0,
            queueName: null,
            queuedAt: null,
            errorMessage: null,
            nextEnqueueAt: null,
          });
          expect(
            await prisma.webhookExecutionClaim.findUnique({ where: { id: fixture.claim.id } }),
          ).toMatchObject({
            status: 'COMPLETED',
            webhookEventId: tombstone ? null : fixture.owner.id,
            enforced: true,
            preparedAt: fixture.claim.preparedAt,
            businessStartedAt: fixture.claim.businessStartedAt,
            completedAt: fixture.claim.completedAt,
            leaseToken: null,
            leaseExpiresAt: null,
          });
          expect(await lane.findOrderedWebhookHeadsForChats([fixture.chatId])).toEqual(new Map());
          expect(preparation).not.toHaveBeenCalled();
          expect(admission).not.toHaveBeenCalled();
          expect(await queue.getJob(fixture.mirror.id)).toBeUndefined();
          expect(deniedMax).not.toHaveBeenCalled();
        } finally {
          preparation.mockRestore();
          admission.mockRestore();
        }
      },
    );

    it('settles a completed mirror and admits a fresh chat while another real preparation owns its slot', async () => {
      const slowChat = `-completed-slow-${randomUUID()}`;
      const freshChat = `-completed-fresh-${randomUUID()}`;
      chats.push(slowChat, freshChat);
      await prisma.chat.createMany({
        data: [slowChat, freshChat].map((id) => ({
          id,
          title: 'Independent completed mirror progress',
          entityType: 'CHAT' as const,
        })),
      });
      const slow = await ingress.storeReceipt(update(slowChat, randomUUID()), null);
      receipts.push(slow.webhookEventId!);
      let release!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      // FLAG: Block inside the real admission wrapper so the old poll retains both
      // its shared preparation slot and its same-chat ownership until completion.
      const admitted = jest
        .spyOn(
          ingress as unknown as {
            preparePersistedWebhookEventAdmitted(id: string): Promise<never>;
          },
          'preparePersistedWebhookEventAdmitted',
        )
        .mockImplementation(async (id) => {
          if (id === slow.webhookEventId) await pending;
          throw new WebhookPreparationDeferredError('native_preparation_boundary', 60_000);
        });
      const preparation = jest.spyOn(ingress, 'preparePersistedWebhookEvent');
      const admission = jest.spyOn(ingress, 'webhookPreparationSchedulingState');
      const lane = completedMirrorRecovery();
      try {
        await lane.enqueueBatch();
        expect(lane.activeEnqueueUnits.size).toBe(1);
        const heldTask = lane.activeEnqueueUnits.get(`chat:${slowChat}`);
        expect(heldTask).toBeDefined();
        const fixture = await completedMirror();
        const fresh = await ingress.storeReceipt(update(freshChat, randomUUID()), null);
        receipts.push(fresh.webhookEventId!);
        lane.nextCompletedHeadRecoveryAt = 0;
        await lane.enqueueBatch();
        expect(
          await prisma.webhookEvent.findUnique({ where: { id: fixture.mirror.id } }),
        ).toMatchObject({ status: 'DUPLICATE', enqueueAttempts: 0 });
        expect(new Set(preparation.mock.calls.map(([id]) => id))).toEqual(
          new Set([slow.webhookEventId, fresh.webhookEventId]),
        );
        expect(
          admission.mock.calls.some(
            ([snapshot]) => snapshot?.message?.messageId === fixture.payload.message?.messageId,
          ),
        ).toBe(false);
        expect(lane.activeEnqueueUnits.get(`chat:${slowChat}`)).toBe(heldTask);
        expect(lane.activeEnqueueUnits.size).toBe(1);
        expect(await queue.getJob(fixture.mirror.id)).toBeUndefined();
        expect(deniedMax).not.toHaveBeenCalled();
      } finally {
        release();
        await Promise.all(lane.activeEnqueueUnits.values());
        admitted.mockRestore();
        preparation.mockRestore();
        admission.mockRestore();
      }
    });

    it.each([
      'unfinished claim',
      'unenforced claim',
      'missing preparation',
      'missing completion',
      'live claim lease',
      'wrong claim kind',
      'unsettled owner',
      'owner semantic mismatch',
      'mirror semantic mismatch',
      'mirror ambiguity',
      'mirror quarantine',
      'prior queue attempt',
      'scope hold',
    ] as const)('preserves the complete receipt when proof is fenced by %s', async (reason) => {
      const fixture = await completedMirror();
      if (reason === 'unfinished claim')
        await prisma.webhookExecutionClaim.update({
          where: { id: fixture.claim.id },
          data: { status: 'READY', completedAt: null },
        });
      if (reason === 'unenforced claim')
        await prisma.webhookExecutionClaim.update({
          where: { id: fixture.claim.id },
          data: { enforced: false },
        });
      if (reason === 'missing preparation' || reason === 'missing completion')
        await prisma.webhookExecutionClaim.update({
          where: { id: fixture.claim.id },
          data: reason === 'missing preparation' ? { preparedAt: null } : { completedAt: null },
        });
      if (reason === 'live claim lease')
        await prisma.webhookExecutionClaim.update({
          where: { id: fixture.claim.id },
          data: { leaseToken: randomUUID(), leaseExpiresAt: new Date(Date.now() + 60_000) },
        });
      if (reason === 'wrong claim kind')
        await prisma.webhookExecutionClaim.update({
          where: { id: fixture.claim.id },
          data: { kind: 'COMMAND' },
        });
      if (reason === 'unsettled owner')
        await prisma.webhookEvent.update({
          where: { id: fixture.owner.id },
          data: { processedAt: null },
        });
      if (reason === 'owner semantic mismatch' || reason === 'mirror semantic mismatch') {
        const changed = structuredClone(fixture.payload);
        changed.message!.messageId = randomUUID();
        await prisma.webhookEvent.update({
          where: {
            id: reason === 'owner semantic mismatch' ? fixture.owner.id : fixture.mirror.id,
          },
          data: { normalizedPayload: changed as unknown as Prisma.InputJsonValue },
        });
      }
      if (reason === 'mirror ambiguity')
        await prisma.webhookEvent.update({
          where: { id: fixture.mirror.id },
          data: { errorMessage: 'ambiguous prior effects; retain proof boundary' },
        });
      if (reason === 'mirror quarantine')
        await prisma.webhookEvent.update({
          where: { id: fixture.mirror.id },
          data: { timeoutQuarantineExpiresAt: new Date(Date.now() + 60_000) },
        });
      if (reason === 'prior queue attempt')
        await prisma.webhookEvent.update({
          where: { id: fixture.mirror.id },
          data: { enqueueAttempts: 1 },
        });
      if (reason === 'scope hold') {
        // FLAG: This unsealed local fixture is only a denial proof; it grants no
        // order release and does not represent an authorized production recovery.
        const certificate = await prisma.webhookLegacyQuiescenceCertificate.create({
          data: {
            id: randomUUID(),
            sourceSha: 'a'.repeat(40),
            imageId: `sha256:${'b'.repeat(64)}`,
            attestation: {},
            attestationDigest: 'c'.repeat(64),
            previewSha256: 'd'.repeat(64),
          },
        });
        holdCertificateIds.push(certificate.id);
        await prisma.webhookLegacyRecovery.create({
          data: {
            id: randomUUID(),
            semanticKey: fixture.claim.semanticKey,
            ownerWebhookEventId: fixture.owner.id,
            claimId: fixture.claim.id,
            chatId: fixture.chatId,
            messageId: fixture.payload.message!.messageId,
            userId: fixture.payload.message!.senderId,
            sourceAt: fixture.owner.createdAt,
            rawPayloadDigest: 'e'.repeat(64),
            normalizedPayloadDigest: 'f'.repeat(64),
            ownerSnapshot: {},
            claimSnapshot: {},
            settingsSnapshot: {},
            certificateId: certificate.id,
          },
        });
      }
      const before = await prisma.webhookEvent.findUniqueOrThrow({
        where: { id: fixture.mirror.id },
      });
      const beforeClaim = await prisma.webhookExecutionClaim.findUniqueOrThrow({
        where: { id: fixture.claim.id },
      });
      const lane = completedMirrorRecovery();
      const preparation = jest.spyOn(ingress, 'preparePersistedWebhookEvent');
      try {
        const heads = await lane.findOrderedWebhookHeadsForChats([fixture.chatId]);
        expect(heads.get(fixture.chatId)?.id).toBe(fixture.mirror.id);
        expect(await lane.recoverCompletedOrderedHeadMirrors(heads)).toBe(0);
        expect(await prisma.webhookEvent.findUnique({ where: { id: fixture.mirror.id } })).toEqual(
          before,
        );
        expect(
          await prisma.webhookExecutionClaim.findUnique({ where: { id: fixture.claim.id } }),
        ).toEqual(beforeClaim);
        expect(preparation).not.toHaveBeenCalled();
        expect(await queue.getJob(fixture.mirror.id)).toBeUndefined();
        expect(deniedMax).not.toHaveBeenCalled();
      } finally {
        preparation.mockRestore();
      }
    });

    it('preserves the complete receipt behind an isolated immutable source hold', async () => {
      const fixture = await completedMirror();
      const certificateId = randomUUID();
      const abandonmentId = randomUUID();
      const rollback = new Error('Rollback isolated completed-mirror source hold');
      const preparation = jest.spyOn(ingress, 'preparePersistedWebhookEvent');
      try {
        await expect(
          prisma.$transaction(
            async (tx) => {
              // FLAG: Immutable evidence stays inside a rollback-only native transaction.
              // Committing it would pin a terminal body in other suites' retention scans.
              const certificateAt = new Date();
              await tx.webhookSourceAbandonmentCertificate.create({
                data: {
                  id: certificateId,
                  sourceSha: 'a'.repeat(40),
                  imageId: `sha256:${'b'.repeat(64)}`,
                  attestation: {},
                  attestationDigest: 'c'.repeat(64),
                  previewSha256: 'd'.repeat(64),
                  sourceClosureSha256: 'e'.repeat(64),
                  descendantsSha256: 'f'.repeat(64),
                  abandonBefore: certificateAt,
                  createdAt: certificateAt,
                  expectedSourceCount: 1,
                  expectedChildCount: 0,
                },
              });
              await tx.webhookSourceAbandonment.create({
                data: {
                  id: abandonmentId,
                  certificateId,
                  semanticKey: fixture.claim.semanticKey,
                  ownerWebhookEventId: fixture.owner.id,
                  claimId: fixture.claim.id,
                  chatId: fixture.chatId,
                  messageId: fixture.payload.message!.messageId,
                  subjectUserId: fixture.payload.message!.senderId,
                  sourceAt: fixture.owner.createdAt,
                  rawPayloadDigest: 'e'.repeat(64),
                  normalizedPayloadDigest: 'f'.repeat(64),
                  ownerSnapshot: {},
                  claimSnapshot: {},
                },
              });
              // FLAG: Both real lane transactions share this real RepeatableRead snapshot.
              // No SQL reader or hold guard is mocked; the outer transaction owns rollback.
              const scopedPrisma = {
                $transaction: (work: (client: Prisma.TransactionClient) => Promise<unknown>) =>
                  work(tx),
                $queryRaw: tx.$queryRaw.bind(tx),
                $executeRaw: tx.$executeRaw.bind(tx),
                webhookEvent: tx.webhookEvent,
                webhookExecutionClaim: tx.webhookExecutionClaim,
              };
              const holds = new WebhookLegacyHoldService(scopedPrisma as never);
              const lane = Object.create(WebhookOutboxService.prototype) as ReturnType<
                typeof completedMirrorRecovery
              >;
              Object.assign(lane, {
                prisma: scopedPrisma,
                legacyHolds: holds,
                enqueueConcurrency: 1,
                publisherBotId: DEFAULT_MAX_PUBLISHER_BOT_ID,
                activeEnqueueUnits: new Map(),
                nextCompletedHeadRecoveryAt: 0,
                completedHeadRecoveryOffset: 0,
                completedMirrorRecoveryOffset: 0,
              });
              const before = await tx.webhookEvent.findUniqueOrThrow({
                where: { id: fixture.mirror.id },
              });
              const beforeClaim = await tx.webhookExecutionClaim.findUniqueOrThrow({
                where: { id: fixture.claim.id },
              });
              expect(await holds.isUpdateHeld(fixture.payload, tx)).toBe(true);
              expect(
                await tx.$queryRaw(lane.completedOrderedHeadMirrorsQuery([fixture.mirror.id])),
              ).toEqual([{ mirrorId: fixture.mirror.id }]);
              expect(
                await tx.$queryRaw(lane.completedOrderedHeadMirrorGuardQuery(fixture.mirror.id)),
              ).toEqual([]);
              const heads = await lane.findOrderedWebhookHeadsForChats([fixture.chatId]);
              expect(heads.get(fixture.chatId)?.id).toBe(fixture.mirror.id);
              expect(await lane.recoverCompletedOrderedHeadMirrors(heads)).toBe(0);
              expect(
                await tx.webhookEvent.findUnique({ where: { id: fixture.mirror.id } }),
              ).toEqual(before);
              expect(
                await tx.webhookExecutionClaim.findUnique({ where: { id: fixture.claim.id } }),
              ).toEqual(beforeClaim);
              expect(preparation).not.toHaveBeenCalled();
              expect(await queue.getJob(fixture.mirror.id)).toBeUndefined();
              expect(deniedMax).not.toHaveBeenCalled();
              throw rollback;
            },
            {
              isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
              maxWait: 5_000,
              timeout: 15_000,
            },
          ),
        ).rejects.toBe(rollback);
        expect(
          await prisma.webhookSourceAbandonmentCertificate.findUnique({
            where: { id: certificateId },
          }),
        ).toBeNull();
        expect(
          await prisma.webhookSourceAbandonment.findUnique({ where: { id: abandonmentId } }),
        ).toBeNull();
        await removeCompletedMirrorProofs();
        await prisma.webhookEvent.deleteMany({ where: { id: { in: receipts.splice(0) } } });
        expect(
          await prisma.webhookExecutionClaim.findUnique({ where: { id: fixture.claim.id } }),
        ).toBeNull();
        expect(
          await prisma.webhookEvent.findUnique({ where: { id: fixture.owner.id } }),
        ).toBeNull();
      } finally {
        preparation.mockRestore();
      }
    });

    it.each(
      [DEFAULT_MAX_PUBLISHER_BOT_ID, 'configured-native-publisher'].flatMap((publisherId) =>
        (['mirror', 'owner', 'executor', 'tombstone executor'] as const).map((boundary) => ({
          publisherId,
          boundary,
        })),
      ),
    )(
      'retains a shared moderation key with Publisher $boundary ($publisherId)',
      async ({ publisherId, boundary }) => {
        const fixture = await completedMirror(boundary === 'tombstone executor');
        const lane = completedMirrorRecovery();
        lane.publisherBotId = publisherId;
        if (boundary === 'executor' || boundary === 'tombstone executor') {
          await prisma.webhookExecutionClaim.update({
            where: { id: fixture.claim.id },
            data: { executionBotId: publisherId },
          });
        } else {
          const id = boundary === 'mirror' ? fixture.mirror.id : fixture.owner.id;
          const row = await prisma.webhookEvent.findUniqueOrThrow({ where: { id } });
          await prisma.webhookEvent.update({
            where: { id },
            data: {
              botId: publisherId,
              normalizedPayload: {
                ...(row.normalizedPayload as unknown as MaxUpdate),
                botId: publisherId,
              } as unknown as Prisma.InputJsonValue,
            },
          });
        }
        const before = await prisma.webhookEvent.findUniqueOrThrow({
          where: { id: fixture.mirror.id },
        });
        const beforeClaim = await prisma.webhookExecutionClaim.findUniqueOrThrow({
          where: { id: fixture.claim.id },
        });
        const preparation = jest.spyOn(ingress, 'preparePersistedWebhookEvent');
        try {
          const heads = await lane.findOrderedWebhookHeadsForChats([fixture.chatId]);
          expect(await lane.recoverCompletedOrderedHeadMirrors(heads)).toBe(0);
          expect(
            await prisma.webhookEvent.findUnique({ where: { id: fixture.mirror.id } }),
          ).toEqual(before);
          expect(
            await prisma.webhookExecutionClaim.findUnique({ where: { id: fixture.claim.id } }),
          ).toEqual(beforeClaim);
          expect(preparation).not.toHaveBeenCalled();
          expect(deniedMax).not.toHaveBeenCalled();
        } finally {
          preparation.mockRestore();
        }
      },
    );

    it('keeps completed-mirror selection on bounded exact indexes across retained history', async () => {
      const fixture = await completedMirror();
      const history = Array.from({ length: 2_500 }, () => ({
        id: randomUUID(),
        claimId: randomUUID(),
        semanticKey: `retained-fleet-proof:${randomUUID()}`,
      }));
      receipts.push(...history.map(({ id }) => id));
      completedClaimIds.push(...history.map(({ claimId }) => claimId));
      await prisma.webhookEvent.createMany({
        data: history.map(({ id, semanticKey }) => ({
          id,
          dedupKey: id,
          semanticKey,
          status: 'PROCESSED' as const,
          processedAt: fixture.claim.completedAt,
          rawPayload: {},
          normalizedPayload: {},
        })),
      });
      await prisma.webhookExecutionClaim.createMany({
        data: history.map(({ id, claimId, semanticKey }) => ({
          id: claimId,
          semanticKey,
          webhookEventId: id,
          kind: 'EXECUTION',
          enforced: true,
          status: 'COMPLETED' as const,
          preparedAt: fixture.claim.preparedAt,
          completedAt: fixture.claim.completedAt,
        })),
      });
      const certificate = await prisma.webhookLegacyQuiescenceCertificate.create({
        data: {
          id: randomUUID(),
          sourceSha: 'a'.repeat(40),
          imageId: `sha256:${'b'.repeat(64)}`,
          attestation: {},
          attestationDigest: 'c'.repeat(64),
          previewSha256: 'd'.repeat(64),
        },
      });
      holdCertificateIds.push(certificate.id);
      // FLAG: Unrelated permanent-denial fixtures exercise the indexed hold readers;
      // these unsealed rows grant no source or order-release authority.
      await prisma.webhookLegacyRecovery.createMany({
        data: history.map(({ id, claimId, semanticKey }) => ({
          id: randomUUID(),
          semanticKey,
          ownerWebhookEventId: id,
          claimId,
          chatId: `-guard-history-${id}`,
          messageId: id,
          userId: id,
          sourceAt: fixture.owner.createdAt,
          rawPayloadDigest: 'e'.repeat(64),
          normalizedPayloadDigest: 'f'.repeat(64),
          ownerSnapshot: {},
          claimSnapshot: {},
          settingsSnapshot: {},
          certificateId: certificate.id,
        })),
      });
      await prisma.$executeRaw`ANALYZE webhook_events`;
      await prisma.$executeRaw`ANALYZE webhook_execution_claims`;
      await prisma.$executeRaw`ANALYZE webhook_legacy_recoveries`;
      const lane = completedMirrorRecovery();
      const ids = [fixture.mirror.id, ...history.slice(0, 199).map(({ id }) => id)];
      const explained = await prisma.$queryRaw<Array<{ 'QUERY PLAN': unknown }>>(
        Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${lane.completedOrderedHeadMirrorsQuery(ids)}`,
      );
      const nodes: Array<Record<string, unknown>> = [];
      const visit = (value: unknown) => {
        if (Array.isArray(value)) return value.forEach(visit);
        if (!value || typeof value !== 'object') return;
        const row = value as Record<string, unknown>;
        if (typeof row['Node Type'] === 'string') nodes.push(row);
        Object.values(row).forEach(visit);
      };
      visit(explained);
      const probes = nodes.filter((node) =>
        ['webhook_events', 'webhook_execution_claims'].includes(String(node['Relation Name'])),
      );
      expect(probes.length).toBeGreaterThanOrEqual(2);
      expect(
        probes.every(
          (node) =>
            String(node['Node Type']).includes('Index') &&
            Number(node['Actual Rows']) + Number(node['Rows Removed by Filter'] ?? 0) <= 1 &&
            Number(node['Actual Loops']) <= ids.length,
        ),
      ).toBe(true);
      expect(probes.map((node) => node['Index Name'])).toEqual(
        expect.arrayContaining([
          'webhook_events_pkey',
          'webhook_execution_claims_kind_semantic_key',
        ]),
      );
      expect(
        await prisma.$queryRaw<Array<{ mirrorId: string }>>(
          lane.completedOrderedHeadMirrorsQuery(ids),
        ),
      ).toEqual([{ mirrorId: fixture.mirror.id }]);
      nodes.length = 0;
      visit(
        await prisma.$queryRaw<Array<{ 'QUERY PLAN': unknown }>>(
          Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${lane.completedOrderedHeadMirrorGuardQuery(fixture.mirror.id)}`,
        ),
      );
      const guardReceipt = nodes.filter((node) => node['Relation Name'] === 'webhook_events');
      expect(guardReceipt).toHaveLength(1);
      expect(guardReceipt[0]).toMatchObject({
        'Index Name': 'webhook_events_pkey',
        'Actual Rows': 1,
        'Actual Loops': 1,
      });
      expect(String(guardReceipt[0]!['Index Cond'])).toContain('id =');
      const heldProbes = nodes.filter(
        (node) =>
          node['Relation Name'] === 'webhook_legacy_recoveries' && Number(node['Actual Loops']) > 0,
      );
      expect(heldProbes).toHaveLength(3);
      expect(
        heldProbes.every(
          (node) =>
            String(node['Node Type']).includes('Index') &&
            typeof node['Index Cond'] === 'string' &&
            Number(node['Actual Rows']) + Number(node['Rows Removed by Filter'] ?? 0) <= 1 &&
            Number(node['Actual Loops']) === 1,
        ),
      ).toBe(true);
      expect(
        await prisma.webhookEvent.findUnique({ where: { id: fixture.mirror.id } }),
      ).toMatchObject({ status: 'RECEIVED', enqueueAttempts: 0 });
    });
  });
});
