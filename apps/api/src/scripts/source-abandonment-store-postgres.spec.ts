import { buildMaxActionIdempotencyKey } from '../max/max-action-idempotency';
import { MANAGED_HANDSHAKE_CONFIRMATION_AUTO_DELETE_DELAY_MS } from '../max/managed-handshake-confirmation';
import { createHash, randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { buildGroupCommandKey } from '../common/group-command-key';
import { RUNTIME_SERVICE_NAMES } from '../runtime/runtime-topology';
import { createPrismaClient, Prisma, type PrismaClient } from '../prisma/prisma-client';
import { WebhookParser } from '../webhook/webhook.parser';
import { buildWebhookSemanticEventKey } from '../webhook/webhook-semantic-event-key';
import {
  buildSourceAbandonmentInventoryDigest,
  executeSourceAbandonmentStore,
  parseSourceAbandonmentStoreRequest,
  sourceAbandonmentStorePoolConfig,
} from './source-abandonment-store';
import {
  collectSourceAbandonmentAdmission,
  collectSourceAbandonmentLiveEvidence,
} from './source-abandonment-collect';
import { LEGACY_RECOVERY_LIVE_QUEUE_NAMES } from './legacy-recovery-live-registry';
import * as sourceSql from './source-abandonment-live-sql';
import { isLegacyRecoveryWebhookQueue } from './legacy-recovery-queue-inventory';
import type { SourceAbandonmentRedisReader } from './source-abandonment-live-redis';
import {
  inventorySourceAbandonmentSql,
  SourceInventorySqlMeter,
} from './source-abandonment-live-sql';
import {
  SOURCE_ABANDONMENT_PROTOCOL,
  sourceAbandonmentDigest,
  type SourceAbandonmentLiveOutput,
  type SourceAbandonmentLiveRequest,
  type SourceAbandonmentLiveSelection,
} from './source-abandonment-live-protocol';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const redisUrl = process.env.MAXIM_TEST_REDIS_URL?.trim() ?? '';
const native = databaseUrl && redisUrl ? describe : describe.skip;
jest.setTimeout(60_000);

native('modern exact-source offline inventory and store PostgreSQL authority', () => {
  let db: PrismaClient;
  let readonlyDb: PrismaClient;
  let chatId: string;
  let ownerId: string;
  let selection: SourceAbandonmentLiveSelection;
  let liveRequest: SourceAbandonmentLiveRequest;
  let redis: Redis;
  let fixtureRedisUrl: string;
  let ownsRedis = false;
  let historyWebhookIds: string[] = [];
  const queues: Queue[] = [];

  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    ) {
      throw new Error('Disposable loopback PostgreSQL required');
    }
    db = createPrismaClient(databaseUrl, { max: 4, statement_timeout: 15_000 });
    readonlyDb = createPrismaClient(databaseUrl, sourceAbandonmentStorePoolConfig(true));
    const [identity] = await db.$queryRaw<Array<{ version: string; timezone: string }>>`
      SELECT version(), current_setting('TimeZone') AS timezone`;
    expect(identity?.version).toMatch(/^PostgreSQL 16\./u);
    expect(identity?.timezone).toBe('UTC');
    const redisTarget = new URL(redisUrl);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(redisTarget.hostname))
      throw new Error('Disposable loopback Redis required');
    redisTarget.pathname = '/14';
    fixtureRedisUrl = redisTarget.toString();
    redis = new Redis(fixtureRedisUrl, { maxRetriesPerRequest: 1, commandTimeout: 10_000 });
    expect(await redis.info('server')).toMatch(/^redis_version:7\./mu);
    if (await redis.dbsize()) throw new Error('Disposable native Redis database is occupied');
    ownsRedis = true;
  });
  afterAll(async () => {
    await readonlyDb?.$disconnect();
    await db?.$disconnect();
    redis?.disconnect();
  });
  beforeEach(async () => {
    chatId = `-source-store-${randomUUID()}`;
    ownerId = randomUUID();
    await db.chat.create({
      data: { id: chatId, title: 'Native source inventory', entityType: 'CHAT' },
    });
    await db.chatSettings.create({ data: { chatId } });
    const [clock] = await db.$queryRaw<Array<{ at: Date; migrationAt: Date }>>`
      SELECT clock_timestamp() AT TIME ZONE 'UTC' AS at, finished_at AS "migrationAt"
      FROM _prisma_migrations WHERE migration_name = '20261005020000_add_multibot_order_fences'
        AND finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY finished_at DESC LIMIT 1`;
    expect(clock!.at.getTime()).toBeGreaterThan(clock!.migrationAt.getTime());
    const at = clock!.at.getTime();
    const update = new WebhookParser().parse(
      {
        update_type: 'message_created',
        update_id: randomUUID(),
        timestamp: at,
        message: {
          sender: { user_id: 'fixture-source-user', is_bot: false },
          recipient: { chat_id: chatId, chat_type: 'chat' },
          timestamp: at,
          body: { mid: `source-${randomUUID()}`, text: 'Original plain source' },
        },
      },
      { botId: 'major-1' },
    );
    const owner = await db.webhookEvent.create({
      data: {
        id: ownerId,
        botId: 'major-1',
        dedupKey: ownerId,
        semanticKey: buildWebhookSemanticEventKey(update),
        normalizedPayload: JSON.parse(JSON.stringify(update)),
        rawPayload: update.raw!,
        status: 'FAILED',
        errorMessage: 'CANONICAL_BUSINESS_ALREADY_STARTED',
        executionDeadlineAt: new Date(at + 300_000),
      },
    });
    const [started] = await db.$queryRaw<
      Array<{ at: Date }>
    >`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS at`;
    await db.webhookExecutionClaim.create({
      data: {
        kind: 'EXECUTION',
        semanticKey: owner.semanticKey!,
        webhookEventId: ownerId,
        enforced: true,
        executionBotId: 'major-1',
        status: 'READY',
        createdAt: owner.createdAt,
        preparedAt: started!.at,
        businessStartedAt: started!.at,
      },
    });
    // FLAG: Own the representative distribution and statistics for every competing
    // chat-prefix index; prior suites' empty-table plans are not source-scope proof.
    historyWebhookIds = Array.from({ length: 512 }, () => randomUUID());
    await db.webhookEvent.createMany({
      data: historyWebhookIds.map((id, index) => {
        const historyUpdate = new WebhookParser().parse(
          {
            update_type: 'message_created',
            update_id: id,
            timestamp: at,
            message: {
              sender: { user_id: 'fixture-source-user', is_bot: false },
              recipient: { chat_id: chatId, chat_type: 'chat' },
              timestamp: at,
              body: { mid: `unrelated-history-${index}`, text: 'Independent pending source' },
            },
          },
          { botId: 'major-1' },
        );
        return {
          id,
          botId: 'major-1',
          dedupKey: id,
          semanticKey: buildWebhookSemanticEventKey(historyUpdate),
          normalizedPayload: JSON.parse(JSON.stringify(historyUpdate)),
          rawPayload: historyUpdate.raw!,
          status: 'FAILED' as const,
          errorMessage: 'NATIVE_UNRELATED_PREPARATION_FAILURE',
          createdAt: owner.createdAt,
          executionDeadlineAt: owner.executionDeadlineAt,
        };
      }),
    });
    // FLAG: Earlier suites can leave a tiny, bloated claims relation whose cheaper
    // kind-only scan correctly fails the collector's full-identity plan proof.
    // Own representative history for both common kinds and analyze it every time.
    await db.webhookExecutionClaim.createMany({
      data: historyWebhookIds.map((id, index) => ({
        kind: index % 2 === 0 ? 'EXECUTION' : 'COMMAND',
        semanticKey:
          index % 2 === 0
            ? `message:message_created:${chatId}:unrelated-history-${index}`
            : buildGroupCommandKey(chatId, `unrelated-history-${index}`),
        webhookEventId: id,
        status: 'COMPLETED' as const,
        createdAt: owner.createdAt,
        completedAt: started!.at,
      })),
    });
    await db.moderationEvent.createMany({
      data: Array.from({ length: 512 }, (_, index) => ({
        chatId,
        userId: 'unrelated-history-user',
        messageId: `unrelated-history-${index}`,
        eventType: 'MESSAGE' as const,
        ruleCode: 'NATIVE_HISTORY',
        action: 'NONE' as const,
      })),
    });
    await db.moderationViolationMessageClaim.createMany({
      data: Array.from({ length: 512 }, (_, index) => ({
        dedupeKey: `history-${ownerId}-${index}`,
        chatId,
        userId: 'unrelated-history-user',
        messageId: `unrelated-history-${index}`,
        ruleCode: 'NATIVE_HISTORY',
        updateType: 'message_created',
      })),
    });
    await db.spammerObservation.createMany({
      data: Array.from({ length: 512 }, (_, index) => ({
        chatId,
        userId: 'unrelated-history-user',
        messageId: `unrelated-history-${index}`,
        source: 'NATIVE_HISTORY',
        score: 0,
        reason: 'Unrelated native fixture',
        evidenceHash: sourceAbandonmentDigest(`history-${ownerId}-${index}`),
        expiresAt: new Date(at + 86_400_000),
      })),
    });
    await db.moderationDeleteIntent.createMany({
      data: Array.from({ length: 512 }, (_, index) => ({
        id: `history-${ownerId}-${index}`,
        chatId,
        messageId: `unrelated-history-${index}`,
        status: 'SUCCEEDED' as const,
        executeAt: new Date(at - 2000),
        retryUntilAt: new Date(at - 1000),
        completedAt: new Date(at - 1000),
      })),
    });
    await db.$executeRaw`ANALYZE webhook_events`;
    await db.$executeRaw`ANALYZE webhook_execution_claims`;
    await db.$executeRaw`ANALYZE moderation_events`;
    await db.$executeRaw`ANALYZE moderation_violation_message_claims`;
    await db.$executeRaw`ANALYZE spammer_observations`;
    await db.$executeRaw`ANALYZE moderation_delete_intents`;
    const [cutoff] = await db.$queryRaw<
      Array<{ at: Date }>
    >`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS at`;
    selection = {
      protocol: SOURCE_ABANDONMENT_PROTOCOL,
      abandonBefore: cutoff!.at.toISOString(),
      ownerWebhookEventIds: [ownerId],
      majorBotIds: ['major-1'],
    };
    const sourceSha = 'a'.repeat(40),
      imageId = `sha256:${'b'.repeat(64)}`;
    liveRequest = {
      version: 1,
      operation: 'inventory_preview',
      selection,
      binding: {
        maintenanceId: randomUUID(),
        queueFenceNonce: randomUUID(),
        transitionJournalSha256: sourceAbandonmentDigest('native-store-journal'),
        sourceSha,
        imageId,
        stoppedGenerations: [
          ...RUNTIME_SERVICE_NAMES.filter((name) => name !== 'api-all'),
          'ocr-native-sandbox',
          'photo-native-sandbox',
        ].map((serviceName) => ({
          serviceName,
          containerId: sourceAbandonmentDigest(serviceName),
          sourceSha,
          imageId,
          stopped: true as const,
        })),
      },
    };
    // FLAG: This fixture owns only the empty disposable Redis database above.
    // The collector receives EVAL_RO; no production stop or restart is simulated.
    const pipeline = redis.pipeline();
    for (const name of LEGACY_RECOVERY_LIVE_QUEUE_NAMES.filter(isLegacyRecoveryWebhookQueue))
      pipeline.hset(`bull:${name}:meta`, 'paused', '1');
    pipeline.set(
      'maxim:webhook-rollout:pause-owner:v1',
      `rollout:${liveRequest.binding.queueFenceNonce}`,
    );
    await pipeline.exec();
  });
  afterEach(async () => {
    for (const queue of queues.splice(0)) await queue.close();
    if (ownsRedis) await redis.flushdb();
    const held = await db.webhookSourceAbandonment.findUnique({
      where: { ownerWebhookEventId: ownerId },
    });
    if (!held) {
      await db.webhookExecutionClaim.deleteMany({ where: { webhookEventId: ownerId } });
      await db.webhookEvent.deleteMany({ where: { id: ownerId } });
    }
    const historyIds = historyWebhookIds.splice(0);
    await db.webhookExecutionClaim.deleteMany({ where: { webhookEventId: { in: historyIds } } });
    await db.webhookEvent.deleteMany({ where: { id: { in: historyIds } } });
    await db.spammerObservation.deleteMany({ where: { chatId } });
    await db.chat.deleteMany({ where: { id: chatId } });
    await db.maxActionLedgerEntry.deleteMany({ where: { chatId } });
  });

  function inventory() {
    return db.$transaction(
      (tx) =>
        inventorySourceAbandonmentSql(tx, selection, {
          pages: 512,
          rows: 10_000,
          probes: 50_000,
          bytes: 8 * 1024 * 1024,
          deadlineAtMs: Date.now() + 30_000,
        }),
      { timeout: 30_000 },
    );
  }

  function collect(reader: SourceAbandonmentRedisReader = redis) {
    return db.$transaction((tx) => collectSourceAbandonmentLiveEvidence(tx, reader, liveRequest), {
      timeout: 30_000,
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    });
  }

  async function candidateMeter(tx: Prisma.TransactionClient, pages = 512) {
    await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
    await tx.$executeRaw`SET LOCAL enable_bitmapscan = off`;
    return new SourceInventorySqlMeter(tx, {
      pages,
      rows: 10_000,
      probes: 50_000,
      bytes: 8 * 1024 * 1024,
      deadlineAtMs: Date.now() + 30_000,
    });
  }

  it('proves every mirror while reading shared claim and settings evidence only twice', async () => {
    const owner = await db.webhookEvent.findUniqueOrThrow({ where: { id: ownerId } });
    const mirrorIds = Array.from({ length: 6 }, () => randomUUID());
    try {
      await db.webhookEvent.createMany({
        data: mirrorIds.map((id) => ({
          id,
          botId: owner.botId,
          dedupKey: id,
          semanticKey: owner.semanticKey,
          rawPayload: owner.rawPayload as Prisma.InputJsonValue,
          normalizedPayload: owner.normalizedPayload as Prisma.InputJsonValue,
          status: 'RECEIVED' as const,
        })),
      });
      const result = await inventory();
      expect(result.issues).toEqual([]);
      expect(result.selectedOwners).toHaveLength(1);
      expect(
        result.plans.filter((plan) => plan.descriptor === 'sql:exact-source-family'),
      ).toHaveLength(1);
      // FLAG: Every distinct receipt still pays for its own size and exact PK proof.
      // Shared settings and all kind-prefix sentinels get one independent final reread.
      expect(result.plans.filter((plan) => plan.descriptor === 'sql:source-size')).toHaveLength(
        mirrorIds.length + 2,
      );
      expect(result.plans.filter((plan) => plan.descriptor === 'sql:webhook_events')).toHaveLength(
        mirrorIds.length + 2,
      );
      expect(result.plans.filter((plan) => plan.descriptor === 'sql:chat_settings')).toHaveLength(
        2,
      );
      const prefixes = result.plans.filter((plan) => plan.descriptor === 'sql:claim-kind-prefix');
      expect(prefixes.length).toBeGreaterThan(0);
      for (const digest of new Set(prefixes.map((plan) => plan.querySha256)))
        expect(prefixes.filter((plan) => plan.querySha256 === digest)).toHaveLength(2);
      const claims = result.plans.filter(
        (plan) => plan.descriptor === 'sql:webhook_execution_claims',
      );
      expect(claims.length).toBeGreaterThan(mirrorIds.length);
      for (const digest of new Set(claims.map((plan) => plan.querySha256)))
        expect(claims.filter((plan) => plan.querySha256 === digest).length).toBeLessThanOrEqual(2);
      expect(result.cost.pages).toBe(result.plans.length * 2 + 2);
      expect(result.cost.probes).toBe(result.cost.pages);
      expect((await inventory()).stableDigest).toBe(result.stableDigest);
    } finally {
      await db.webhookEvent.deleteMany({ where: { id: { in: mirrorIds } } });
    }
  });

  it('keeps cached evidence detached from caller mutations, including Date and claim arrays', async () => {
    await db.$transaction(async (tx) => {
      const meter = await candidateMeter(tx);
      const first = await meter
        .candidateReader()
        .webhookEvent.findUnique({ where: { id: ownerId } });
      const original = structuredClone(first);
      expect(first!.createdAt).toBeInstanceOf(Date);
      first!.createdAt.setTime(0);
      (first!.normalizedPayload as Prisma.JsonObject).type = 'forged';
      const claims = await meter.candidateReader().webhookExecutionClaim.findMany({
        where: { webhookEventId: ownerId },
      });
      const originalClaims = structuredClone(claims);
      claims[0]!.kind = 'FORGED';
      claims.push({ ...claims[0]! });
      expect(
        await meter.candidateReader().webhookEvent.findUnique({ where: { id: ownerId } }),
      ).toEqual(original);
      expect(
        await meter.candidateReader().webhookExecutionClaim.findMany({
          where: { webhookEventId: ownerId },
        }),
      ).toEqual(originalClaims);
      await expect(meter.verifyCandidateReads()).resolves.toBeUndefined();
      expect(meter.plans.filter((plan) => plan.descriptor === 'sql:webhook_events')).toHaveLength(
        2,
      );
      expect(
        meter.plans.filter((plan) => plan.descriptor === 'sql:webhook_execution_claims'),
      ).toHaveLength(2);
    });
  });

  it('fits eight selected owners with two mirrors each inside the unchanged SQL budget', async () => {
    const owner = await db.webhookEvent.findUniqueOrThrow({ where: { id: ownerId } });
    const claim = await db.webhookExecutionClaim.findFirstOrThrow({
      where: { webhookEventId: ownerId, kind: 'EXECUTION' },
    });
    const addedIds: string[] = [];
    const selectedIds = [ownerId];
    try {
      for (let index = 0; index < 8; index++) {
        let sourceOwner = owner;
        if (index > 0) {
          const id = randomUUID();
          const raw = structuredClone(owner.rawPayload) as {
            update_id: string;
            message: { body: { mid: string } };
          };
          raw.update_id = id;
          raw.message.body.mid = `batch-source-${id}`;
          const update = new WebhookParser().parse(raw, { botId: owner.botId! });
          sourceOwner = await db.webhookEvent.create({
            data: {
              id,
              botId: owner.botId,
              dedupKey: id,
              semanticKey: buildWebhookSemanticEventKey(update),
              rawPayload: raw,
              normalizedPayload: JSON.parse(JSON.stringify(update)),
              status: 'FAILED',
              errorMessage: owner.errorMessage,
              executionDeadlineAt: owner.executionDeadlineAt,
              createdAt: owner.createdAt,
            },
          });
          addedIds.push(id);
          selectedIds.push(id);
          await db.webhookExecutionClaim.create({
            data: {
              kind: 'EXECUTION',
              semanticKey: sourceOwner.semanticKey!,
              webhookEventId: id,
              enforced: true,
              executionBotId: owner.botId,
              status: 'READY',
              createdAt: claim.createdAt,
              preparedAt: claim.preparedAt,
              businessStartedAt: claim.businessStartedAt,
            },
          });
        }
        const mirrorIds = [randomUUID(), randomUUID()];
        await db.webhookEvent.createMany({
          data: mirrorIds.map((id) => ({
            id,
            botId: sourceOwner.botId,
            dedupKey: id,
            semanticKey: sourceOwner.semanticKey,
            rawPayload: sourceOwner.rawPayload as Prisma.InputJsonValue,
            normalizedPayload: sourceOwner.normalizedPayload as Prisma.InputJsonValue,
            status: 'RECEIVED' as const,
          })),
        });
        addedIds.push(...mirrorIds);
      }
      selection = { ...selection, ownerWebhookEventIds: selectedIds };
      const result = await inventory();
      expect(result.issues).toEqual([]);
      expect(result.selectedOwners).toHaveLength(8);
      expect(result.cost.pages).toBeLessThanOrEqual(512);
      expect(
        result.plans.filter((plan) => plan.descriptor === 'sql:exact-source-family'),
      ).toHaveLength(8);
      expect(result.plans.filter((plan) => plan.descriptor === 'sql:source-size')).toHaveLength(32);
      expect((await inventory()).stableDigest).toBe(result.stableDigest);
    } finally {
      await db.webhookExecutionClaim.deleteMany({ where: { webhookEventId: { in: addedIds } } });
      await db.webhookEvent.deleteMany({ where: { id: { in: addedIds } } });
    }
  });

  it('keeps the complete-family saturation sentinel outside memoization', async () => {
    const owner = await db.webhookEvent.findUniqueOrThrow({ where: { id: ownerId } });
    const mirrorIds = Array.from({ length: 200 }, () => randomUUID());
    try {
      await db.webhookEvent.createMany({
        data: mirrorIds.map((id) => ({
          id,
          botId: owner.botId,
          dedupKey: id,
          semanticKey: owner.semanticKey,
          rawPayload: owner.rawPayload as Prisma.InputJsonValue,
          normalizedPayload: owner.normalizedPayload as Prisma.InputJsonValue,
          status: 'RECEIVED' as const,
        })),
      });
      const result = await inventory();
      expect(result.issues).toContainEqual({
        code: 'source_family_saturated_or_missing',
        descriptor: 'sql:exact-source-family',
      });
      expect(result.plans.filter((plan) => plan.descriptor === 'sql:exact-source-family')).toEqual([
        expect.objectContaining({ returnedRows: 201 }),
      ]);
    } finally {
      await db.webhookEvent.deleteMany({ where: { id: { in: mirrorIds } } });
    }
  });

  it.each(['settings', 'owner', 'command', 'kind'] as const)(
    'refuses a concurrent %s change before accepting reused READ COMMITTED proof',
    async (changed) => {
      const addedClaimIds: string[] = [];
      try {
        await db.$transaction(
          async (tx) => {
            const meter = await candidateMeter(tx);
            const reader = meter.candidateReader();
            if (changed === 'settings') {
              await reader.chatSettings.findUnique({ where: { chatId } });
              await reader.chatSettings.findUnique({ where: { chatId } });
              await db.chatSettings.update({
                where: { chatId },
                data: { adminBanCommandName: 'особое' },
              });
            } else if (changed === 'owner') {
              await reader.webhookEvent.findUnique({ where: { id: ownerId } });
              await reader.webhookEvent.findUnique({ where: { id: ownerId } });
              await db.webhookEvent.update({
                where: { id: ownerId },
                data: { errorMessage: 'Changed source evidence' },
              });
            } else {
              const owner = await db.webhookEvent.findUniqueOrThrow({ where: { id: ownerId } });
              let kind = 'COMMAND';
              let semanticKey = buildGroupCommandKey(
                chatId,
                (
                  owner.normalizedPayload as {
                    message: { messageId: string };
                  }
                ).message.messageId,
              );
              if (changed === 'kind') {
                const last = await db.webhookExecutionClaim.findFirstOrThrow({
                  orderBy: { kind: 'desc' },
                });
                const where = { kind: { gt: last.kind } };
                expect(await reader.webhookExecutionClaim.findFirst({ where })).toBeNull();
                expect(await reader.webhookExecutionClaim.findFirst({ where })).toBeNull();
                kind = `${last.kind}~memo-${randomUUID()}`;
                semanticKey = owner.semanticKey!;
              } else {
                const where = { kind_semanticKey: { kind, semanticKey } };
                expect(await reader.webhookExecutionClaim.findUnique({ where })).toBeNull();
                expect(await reader.webhookExecutionClaim.findUnique({ where })).toBeNull();
              }
              const claim = await db.webhookExecutionClaim.create({
                data: { kind, semanticKey, webhookEventId: ownerId },
              });
              addedClaimIds.push(claim.id);
            }
            await expect(meter.verifyCandidateReads()).rejects.toMatchObject({
              code: 'sql_candidate_proof_changed',
            });
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 30_000 },
        );
      } finally {
        await db.webhookExecutionClaim.deleteMany({ where: { id: { in: addedClaimIds } } });
      }
    },
  );

  it('never reuses proof across inventory calls within the same transaction', async () => {
    await db.$transaction(
      async (tx) => {
        const meter = await candidateMeter(tx);
        const first = await inventorySourceAbandonmentSql(tx, selection, meter.allowance);
        expect(first.issues).toEqual([]);
        const claim = await tx.webhookExecutionClaim.create({
          data: {
            kind: `INDEPENDENT-${randomUUID()}`,
            semanticKey: first.candidates[0]!.claim.semanticKey,
            webhookEventId: ownerId,
          },
        });
        try {
          const second = await inventorySourceAbandonmentSql(tx, selection, meter.allowance);
          expect(second.issues).toContainEqual({
            code: 'source_started_claim_unproved',
            descriptor: 'sql:selected-source',
          });
          expect(second.candidates).toEqual([]);
        } finally {
          await tx.webhookExecutionClaim.delete({ where: { id: claim.id } });
        }
      },
      { timeout: 30_000 },
    );
  });

  it('charges the independent verification against the original page cap', async () => {
    await db.$transaction(async (tx) => {
      const meter = await candidateMeter(tx, 2);
      const reader = meter.candidateReader();
      await reader.chatSettings.findUnique({ where: { chatId } });
      await reader.chatSettings.findUnique({ where: { chatId } });
      expect(meter.cost.pages).toBe(2);
      await expect(meter.verifyCandidateReads()).rejects.toMatchObject({
        code: 'sql_budget_exceeded',
      });
      expect(meter.cost.pages).toBe(2);
    });
  });

  it.each([
    [19_000, 0, 'READY_FOR_COLD_REVIEW'],
    [19_000, 4_000, 'DENY'],
    [20_001, 0, 'DENY'],
  ] as const)(
    'bounds two catalog passes at %i ms and final SQL at %i ms: %s',
    async (catalogMs, childSqlMs, decision) => {
      const startedAt = Date.now();
      let elapsed = 0;
      const clock = jest.spyOn(Date, 'now').mockImplementation(() => startedAt + elapsed);
      const originalSql = sourceSql.inventorySourceAbandonmentSql;
      const originalChildSql = sourceSql.inventorySourceAbandonmentChildSql;
      const sql = jest
        .spyOn(sourceSql, 'inventorySourceAbandonmentSql')
        .mockImplementation(async (...args) => {
          const result = await originalSql(...args);
          elapsed += 3_000;
          return result;
        });
      const childSql = jest
        .spyOn(sourceSql, 'inventorySourceAbandonmentChildSql')
        .mockImplementation(async (...args) => {
          const result = await originalChildSql(...args);
          elapsed += childSqlMs;
          return result;
        });
      let catalogReads = 0;
      const reader: SourceAbandonmentRedisReader = {
        eval_ro: redis.eval_ro.bind(redis),
        multi() {
          const transaction = redis.multi();
          const exec = transaction.exec.bind(transaction);
          transaction.exec = async () => {
            const result = await exec();
            // FLAG: Only the collector wall clock is virtual. Native SQL, Redis
            // EVAL_RO, commandstats measurements and proof parsing stay real.
            elapsed += catalogMs;
            catalogReads++;
            return result;
          };
          return transaction;
        },
      };
      try {
        const evidence = await db.$transaction(
          (tx) =>
            collectSourceAbandonmentAdmission(tx, reader, {
              version: 1,
              operation: 'admission_preview',
              sourceSha: liveRequest.binding.sourceSha,
              imageId: liveRequest.binding.imageId,
              selection,
            }),
          { timeout: 50_000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
        );
        expect(evidence.decision).toBe(decision);
        expect(catalogReads).toBe(2);
        expect(evidence.redisCatalogs).toHaveLength(2);
        if (catalogMs > 20_000) {
          expect(evidence.redisCatalogs.every((proof) => !proof.complete)).toBe(true);
          expect(evidence.issues).toContainEqual({
            code: 'CATALOG_DEADLINE_EXCEEDED',
            descriptor: 'redis:namespace-catalog',
          });
        } else {
          expect(evidence.redisCatalogs.every((proof) => proof.complete)).toBe(true);
          expect(elapsed).toBe(41_000 + childSqlMs);
          expect(childSql).toHaveBeenCalledTimes(1);
          expect(evidence.issues).toEqual(
            childSqlMs
              ? [{ code: 'inventory_store_or_budget_refused', descriptor: 'inventory' }]
              : [],
          );
        }
      } finally {
        childSql.mockRestore();
        sql.mockRestore();
        clock.mockRestore();
      }
    },
  );

  it.each(['', '2027-01-02T03:04:05.000Z'])(
    'preserves the full settings row and admits a source with string expiry %j',
    async (requiredSubscriptionExpiresAt) => {
      const settings = await db.chatSettings.update({
        where: { chatId },
        data: { requiredSubscriptionExpiresAt },
      });
      const restored = await db.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
        await tx.$executeRaw`SET LOCAL enable_bitmapscan = off`;
        const meter = new SourceInventorySqlMeter(tx, {
          pages: 4,
          rows: 4,
          probes: 4,
          bytes: 2 * 1024 * 1024,
          deadlineAtMs: Date.now() + 10_000,
        });
        return meter.candidateReader().chatSettings.findUnique({ where: { chatId } });
      });
      expect(restored).toMatchObject(settings);
      const evidence = await db.$transaction(
        (tx) =>
          collectSourceAbandonmentAdmission(tx, redis, {
            version: 1,
            operation: 'admission_preview',
            sourceSha: liveRequest.binding.sourceSha,
            imageId: liveRequest.binding.imageId,
            selection,
          }),
        { timeout: 30_000, isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
      );
      expect(evidence.issues).toEqual([]);
      expect(evidence.decision).toBe('READY_FOR_COLD_REVIEW');
      expect(evidence.sourceCoverageComplete).toBe(true);
      expect(evidence.selectedOwners).toHaveLength(1);
    },
  );

  it.each([
    ['missing', Prisma.TransactionIsolationLevel.RepeatableRead, 'DENY'],
    ['pending', Prisma.TransactionIsolationLevel.RepeatableRead, 'DENY'],
    ['missing', Prisma.TransactionIsolationLevel.ReadCommitted, 'READY_FOR_COLD_REVIEW'],
    ['pending', Prisma.TransactionIsolationLevel.ReadCommitted, 'READY_FOR_COLD_REVIEW'],
  ] as const)(
    'reproduces a post-snapshot cleanup parent %s under %s as %s',
    async (initialParent, isolationLevel, decision) => {
      const suffix = randomUUID();
      const parentKey = `snapshot-parent-${suffix}`;
      const childKey = `snapshot-cleanup-${suffix}`;
      const cleanupChat = '-200';
      const createdAt = new Date(Date.now() - 1000).toISOString();
      const completedAt = new Date().toISOString();
      const context = { moderationNoticeEnvelope: { version: 1 } };
      const metadata = {
        createdAt,
        autoDeleteDelayMs: 60_000,
        sendAutoDelete: null,
        hasOptions: true,
        optionKeys: ['textFormat'],
        ledgerContext: context,
      };
      const parent = {
        jobId: parentKey,
        chatId: cleanupChat,
        actionType: 'SEND_MESSAGE',
        messageId: null,
        userId: null,
        sourceTag: 'moderation_notice',
        status: 'SUCCEEDED' as const,
        terminal: true,
        ambiguous: false,
        remoteMessageId: `confirmed-${suffix}`,
        dispatchBotId: 'major-1',
        completedAt: new Date(completedAt),
        metadata,
      };
      const historyKeys = Array.from({ length: 512 }, (_, index) => `snapshot-${suffix}-${index}`);
      const queue = await actionQueue();
      try {
        // FLAG: Representative committed history keeps the actual metered resolver's
        // exact unique-index proof valid without changing production planner flags.
        await db.maxActionLedgerEntry.createMany({
          data: historyKeys.map((jobId) => ({ ...parent, jobId })),
        });
        if (initialParent === 'pending')
          await db.maxActionLedgerEntry.create({
            data: {
              ...parent,
              status: 'IN_PROGRESS',
              terminal: false,
              remoteMessageId: null,
              completedAt: null,
            },
          });
        await db.$executeRaw`ANALYZE max_action_ledger`;
        let interleaved = false;
        const reader: SourceAbandonmentRedisReader = {
          eval_ro: (script, keys, ...args) => redis.eval_ro(script, keys, ...args),
          multi() {
            const transaction = redis.multi();
            const measured = {
              eval_ro(script: string, keys: number, ...args: string[]) {
                transaction.eval_ro(script, keys, ...args);
                return measured;
              },
              async exec() {
                if (!interleaved) {
                  interleaved = true;
                  // FLAG: The actual collector has completed its initial SQL inventory here.
                  // Commit on an independent connection before publishing the cleanup.
                  if (initialParent === 'missing')
                    await db.maxActionLedgerEntry.create({ data: parent });
                  else
                    await db.maxActionLedgerEntry.update({
                      where: { jobId: parentKey },
                      data: parent,
                    });
                  await queue.add(
                    'action',
                    {
                      actionType: 'DELETE_MESSAGE',
                      idempotencyKey: childKey,
                      chatId: cleanupChat,
                      messageId: parent.remoteMessageId,
                      botId: 'major-1',
                      sourceTag: 'moderation_notice',
                      ledgerContext: context,
                      sendAutoDelete: {
                        version: 2,
                        sourceSendJobId: parentKey,
                        sourceChatId: cleanupChat,
                        sourceMessageId: null,
                        sourceUserId: null,
                        sourceCreatedAt: createdAt,
                        sourceSendCompletedAt: completedAt,
                        requestedDelayMs: 60_000,
                        originBotId: 'major-1',
                      },
                    },
                    { jobId: childKey, delay: 60_000 },
                  );
                }
                return transaction.exec();
              },
            };
            return measured;
          },
        };
        const result = await readonlyDb.$transaction(
          async (tx) => {
            await tx.$executeRaw`SET TRANSACTION READ ONLY`;
            return collectSourceAbandonmentAdmission(tx, reader, {
              version: 1,
              operation: 'admission_preview',
              sourceSha: liveRequest.binding.sourceSha,
              imageId: liveRequest.binding.imageId,
              selection,
            });
          },
          { timeout: 30_000, isolationLevel },
        );
        expect(interleaved).toBe(true);
        expect(result.selectedOwners).toHaveLength(1);
        expect(result.redisCatalogs).toHaveLength(2);
        expect(result.redisCatalogs.every((catalog) => catalog.complete && !catalog.issue)).toBe(
          true,
        );
        expect(result.decision).toBe(decision);
        expect(result.issues).toEqual(
          decision === 'DENY'
            ? [
                {
                  code: 'CLEANUP_ORIGINAL_SOURCE_UNPROVED',
                  descriptor: 'redis:max-actions-background',
                },
              ]
            : [],
        );
        expect(result.stoppingAuthorized).toBe(false);
        expect(result.activationAuthorized).toBe(false);
        expect(
          await db.maxActionLedgerEntry.findUniqueOrThrow({ where: { jobId: parentKey } }),
        ).toMatchObject(parent);
        expect(await redis.zcard('bull:max-actions-background:delayed')).toBe(1);
        expect(
          await db.webhookSourceAbandonment.findUnique({ where: { ownerWebhookEventId: ownerId } }),
        ).toBeNull();
      } finally {
        await db.maxActionLedgerEntry.deleteMany({
          where: { jobId: { in: [parentKey, ...historyKeys] } },
        });
      }
    },
  );

  it.each([
    ['major', 'admission_preview'],
    ['major', 'inventory_preview'],
    ['publisher', 'admission_preview'],
    ['publisher', 'inventory_preview'],
    ['publisher-missing-catalog', 'admission_preview'],
    ['publisher-missing-catalog', 'inventory_preview'],
    ['required-subscription', 'admission_preview'],
    ['required-subscription', 'inventory_preview'],
    ['required-subscription-invalid', 'admission_preview'],
    ['required-subscription-invalid', 'inventory_preview'],
    ['notice-source', 'admission_preview'],
    ['notice-source', 'inventory_preview'],
    ['notice-rule', 'admission_preview'],
    ['notice-rule', 'inventory_preview'],
    ['notice-rule-source', 'admission_preview'],
    ['notice-rule-source', 'inventory_preview'],
    ['notice-rule-followup', 'admission_preview'],
    ['notice-rule-followup', 'inventory_preview'],
    ['notice-rule-followup-source', 'admission_preview'],
    ['notice-rule-followup-source', 'inventory_preview'],
    ['notice-rule-source-conflict', 'admission_preview'],
    ['notice-rule-source-conflict', 'inventory_preview'],
    ['notice-followup-only', 'admission_preview'],
    ['notice-followup-only', 'inventory_preview'],
  ] as const)(
    'proves exact completed %s notice cleanup through %s without changing it',
    async (origin, operation) => {
      const suffix = randomUUID();
      const publisher = origin.startsWith('publisher');
      const requiredSubscription = origin.startsWith('required-subscription');
      const finiteNotice = origin.startsWith('notice-');
      const botId = publisher ? 'publisher-1' : 'major-1';
      const followupId = `notice-followup-${suffix}`;
      const publisherBotId = origin === 'publisher' ? botId : undefined;
      const cleanupChat = '-200';
      const parentKey = buildMaxActionIdempotencyKey('explicit', [
        ...(publisher ? [botId] : []),
        'SEND_MESSAGE',
        origin.includes('followup')
          ? `${followupId}:explanation`
          : publisher
            ? `publisher-handshake-start:${cleanupChat}:${suffix}`
            : `managed-handshake-start:groupcmd:v1:${suffix}`,
      ]);
      const childKey = `handshake-cleanup-${suffix}`;
      const createdAt = new Date(Date.now() - 1000).toISOString();
      const completedAt = new Date().toISOString();
      const sourceTag =
        requiredSubscription || finiteNotice ? 'moderation_notice' : 'managed_handshake';
      let context: Record<string, Prisma.InputJsonValue> | null = requiredSubscription
        ? {
            moderationNoticeEnvelope: { version: 1 },
            requiredSubscriptionNotice: {
              version: origin === 'required-subscription-invalid' ? 2 : 1,
              chatId: cleanupChat,
              messageId: `original-${suffix}`,
              userId: 'original-user',
              reasonKey: 'REQUIRED_SUBSCRIPTION:message-delete',
              policySha256: 'a'.repeat(64),
              sourceAtMs: Date.parse(createdAt) - 1_000,
              deadlineAtMs: Date.parse(createdAt) - 1_000 + 5 * 60_000,
            },
          }
        : null;
      if (finiteNotice) {
        context = { moderationNoticeEnvelope: { version: 1 } };
        const sourceAtMs = Date.parse(createdAt) - 1_000;
        if (origin.includes('rule'))
          context.moderationRuleNotice = {
            version: 1,
            chatId: cleanupChat,
            messageId: `original-${suffix}`,
            userId: 'original-user',
            reasonKey: 'LINK_BLOCKED:message-delete',
            ruleCode: 'LINK_BLOCKED',
            policySha256: 'a'.repeat(64),
            deadlineAtMs: sourceAtMs + 300_000,
          };
        if (origin.includes('source'))
          context.moderationSource = {
            version: 1,
            chatId: cleanupChat,
            userId: 'original-user',
            messageId: origin.endsWith('conflict') ? 'conflicting-original' : `original-${suffix}`,
          };
        if (origin.includes('followup'))
          context.moderationRuleFollowup = {
            version: 1,
            id: followupId,
            issuedAtMs: sourceAtMs + 500,
          };
      }
      const delay = MANAGED_HANDSHAKE_CONFIRMATION_AUTO_DELETE_DELAY_MS;
      const metadata = {
        createdAt,
        hasText: true,
        textLength: 42,
        autoDeleteDelayMs: delay,
        sendAutoDelete: null,
        hasOptions: true,
        optionKeys: ['buttons'],
        ledgerContext: context,
      };
      const parent = {
        jobId: parentKey,
        chatId: cleanupChat,
        actionType: 'SEND_MESSAGE',
        messageId: null,
        userId: null,
        sourceTag,
        status: 'SUCCEEDED' as const,
        terminal: true,
        ambiguous: false,
        remoteMessageId: `confirmed-${suffix}`,
        dispatchBotId: botId,
        completedAt: new Date(completedAt),
        metadata,
      };
      const historyKeys = Array.from(
        { length: 512 },
        (_, index) => `handshake-history-${suffix}-${index}`,
      );
      const queueName = finiteNotice ? 'max-actions-background' : 'max-actions-interactive';
      const queue = new Queue(queueName, { connection: { url: fixtureRedisUrl } });
      queues.push(queue);
      await queue.pause();
      try {
        // FLAG: The fixture owns these exact rows and an empty disposable queue only.
        // Retained history exercises the unchanged exact-index parent resolver.
        await db.maxActionLedgerEntry.createMany({
          data: [parent, ...historyKeys.map((jobId) => ({ ...parent, jobId }))],
        });
        await db.$executeRaw`ANALYZE max_action_ledger`;
        await queue.add(
          'action',
          {
            actionType: 'DELETE_MESSAGE',
            idempotencyKey: childKey,
            chatId: cleanupChat,
            messageId: parent.remoteMessageId,
            botId,
            sourceTag,
            ...(context ? { ledgerContext: context } : {}),
            sendAutoDelete: {
              version: 2,
              sourceSendJobId: parentKey,
              sourceChatId: cleanupChat,
              sourceMessageId: null,
              sourceUserId: null,
              sourceCreatedAt: createdAt,
              sourceSendCompletedAt: completedAt,
              requestedDelayMs: delay,
              originBotId: botId,
            },
          },
          { jobId: childKey, delay },
        );
        // FLAG: Redis may serialize identical hash fields in a different RDB order.
        // Compare every BullMQ job field and its delayed score, not DUMP encoding bytes.
        const queueBefore = await redis.hgetall(`bull:${queueName}:${childKey}`);
        const delayedScoreBefore = await redis.zscore(`bull:${queueName}:delayed`, childKey);
        expect(Object.keys(queueBefore).length).toBeGreaterThan(0);
        expect(delayedScoreBefore).not.toBeNull();
        const parentBefore = await db.maxActionLedgerEntry.findUniqueOrThrow({
          where: { jobId: parentKey },
        });
        const result = await readonlyDb.$transaction(
          async (tx) => {
            await tx.$executeRaw`SET TRANSACTION READ ONLY`;
            return operation === 'admission_preview'
              ? collectSourceAbandonmentAdmission(tx, redis, {
                  version: 1,
                  operation,
                  sourceSha: liveRequest.binding.sourceSha,
                  imageId: liveRequest.binding.imageId,
                  selection,
                  ...(publisherBotId ? { publisherBotId } : {}),
                })
              : collectSourceAbandonmentLiveEvidence(tx, redis, {
                  ...liveRequest,
                  binding: {
                    ...liveRequest.binding,
                    ...(publisherBotId ? { publisherBotId } : {}),
                  },
                });
          },
          {
            timeout: 30_000,
            isolationLevel:
              operation === 'admission_preview'
                ? Prisma.TransactionIsolationLevel.ReadCommitted
                : Prisma.TransactionIsolationLevel.RepeatableRead,
          },
        );
        const denied =
          origin === 'publisher-missing-catalog' ||
          origin === 'required-subscription-invalid' ||
          origin === 'notice-rule-source-conflict' ||
          origin === 'notice-followup-only';
        expect(result.decision).toBe(
          denied
            ? 'DENY'
            : operation === 'admission_preview'
              ? 'READY_FOR_COLD_REVIEW'
              : 'READY_TO_INSTALL',
        );
        expect(result.issues).toEqual(
          denied
            ? [
                {
                  code: 'CLEANUP_ORIGINAL_SOURCE_UNPROVED',
                  descriptor: `redis:${queueName}`,
                },
              ]
            : [],
        );
        expect(result.selectedOwners).toHaveLength(1);
        expect(result.activationAuthorized).toBe(false);
        expect(result.applied).toBe(false);
        expect(result.selectionSha256).toBe(sourceAbandonmentDigest(selection));
        expect(result.redisCatalogs).toHaveLength(2);
        if ('children' in result) {
          expect(result.children).toEqual([]);
          expect(result.binding.publisherBotId).toBe(publisherBotId);
        }
        expect(
          await db.maxActionLedgerEntry.findUniqueOrThrow({ where: { jobId: parentKey } }),
        ).toEqual(parentBefore);
        expect(await redis.hgetall(`bull:${queueName}:${childKey}`)).toEqual(queueBefore);
        expect(await redis.zscore(`bull:${queueName}:delayed`, childKey)).toBe(delayedScoreBefore);
        expect(await redis.zcard(`bull:${queueName}:delayed`)).toBe(1);
        expect(
          await db.webhookSourceAbandonment.findUnique({ where: { ownerWebhookEventId: ownerId } }),
        ).toBeNull();
      } finally {
        await db.maxActionLedgerEntry.deleteMany({
          where: { jobId: { in: [parentKey, ...historyKeys] } },
        });
      }
    },
  );

  async function actionQueue() {
    const queue = new Queue('max-actions-background', { connection: { url: fixtureRedisUrl } });
    queues.push(queue);
    await queue.pause();
    return queue;
  }

  async function storeFixture(observed?: SourceAbandonmentLiveOutput) {
    const output = observed ?? (await collect());
    expect(output.issues).toEqual([]);
    expect(output.decision).toBe('READY_TO_INSTALL');
    expect(output.redisEvidenceSha256).toMatch(/^[a-f0-9]{64}$/u);
    const inventorySha256 = buildSourceAbandonmentInventoryDigest(output);
    const bytes = Buffer.from(JSON.stringify({ ...output, inventorySha256 }));
    const request = parseSourceAbandonmentStoreRequest(
      JSON.stringify({
        version: 1,
        operation: 'certificate_create',
        certificateId: randomUUID(),
        binding: liveRequest.binding,
        selection,
        expected: {
          inventorySha256,
          inventoryArtifactSha256: createHash('sha256').update(bytes).digest('hex'),
          previewSha256: output.previewSha256,
        },
      }),
    );
    return { request, bytes };
  }

  it('inspects the actual indexed source family without rewriting started evidence', async () => {
    const before = await db.webhookEvent.findUniqueOrThrow({ where: { id: ownerId } });
    const claims = await db.webhookExecutionClaim.findMany({ where: { webhookEventId: ownerId } });
    const result = await inventory();
    expect(result.issues).toEqual([]);
    expect(result.candidates).toHaveLength(1);
    expect(result.selectedOwners).toHaveLength(1);
    expect(result.children).toEqual([]);
    expect(result.plans.length).toBeGreaterThan(0);
    expect(result.plans.flatMap((plan) => plan.indexes)).toContain(
      'webhook_events_source_family_pending_idx',
    );
    expect(
      result.plans
        .filter((plan) => plan.descriptor === 'sql:webhook_execution_claims')
        .flatMap((plan) => plan.indexes),
    ).toEqual(
      expect.arrayContaining([
        'webhook_execution_claims_event_kind_idx',
        'webhook_execution_claims_kind_semantic_key',
      ]),
    );
    expect(await db.webhookEvent.findUniqueOrThrow({ where: { id: ownerId } })).toEqual(before);
    expect(await db.webhookExecutionClaim.findMany({ where: { webhookEventId: ownerId } })).toEqual(
      claims,
    );
  });

  it('retains a source-less historical ambiguous member ledger without claiming its attribution', async () => {
    const ledger = await db.maxActionLedgerEntry.create({
      data: {
        jobId: `old-unknown-member-${randomUUID()}`,
        chatId,
        userId: 'fixture-source-user',
        actionType: 'BAN_MEMBER',
        status: 'AMBIGUOUS',
        ambiguous: true,
        attemptCount: 1,
        dispatchStartedAt: new Date(),
      },
    });
    const result = await inventory();
    expect(result.issues).toEqual([]);
    expect(result.children).toEqual([]);
    expect(await db.maxActionLedgerEntry.findUniqueOrThrow({ where: { id: ledger.id } })).toEqual(
      ledger,
    );
  });

  it.each([false, true])(
    'installs once and reconciles immutable source proofs through a read-only SQL connection (forward=%s)',
    async (forward) => {
      if (forward) {
        const owner = await db.webhookEvent.findUniqueOrThrow({ where: { id: ownerId } });
        const raw = structuredClone(owner.rawPayload) as Record<string, unknown>;
        const message = raw.message as Record<string, unknown>;
        message.link = {
          type: 'forward',
          chat_id: '-independent-linked-chat',
          sender: { user_id: 'independent-linked-author', is_bot: false },
          message: {
            mid: 'independent-linked-message',
            text: 'A strict flat forwarded photo caption',
            attachments: [
              {
                type: 'image',
                payload: { photo_id: 41, url: 'https://i.oneme.ru/native-forward-one' },
              },
              {
                type: 'image',
                payload: { photo_id: 42, url: 'https://i.oneme.ru/native-forward-two' },
              },
            ],
          },
        };
        const update = new WebhookParser().parse(raw, { botId: owner.botId! });
        await db.webhookEvent.update({
          where: { id: ownerId },
          data: {
            rawPayload: raw as Prisma.InputJsonValue,
            normalizedPayload: JSON.parse(JSON.stringify(update)),
          },
        });
      }
      const before = await db.webhookEvent.findUniqueOrThrow({ where: { id: ownerId } });
      const claims = await db.webhookExecutionClaim.findMany({
        where: { webhookEventId: ownerId },
      });
      const { request, bytes } = await storeFixture();
      expect(await executeSourceAbandonmentStore(db, request, bytes)).toMatchObject({
        state: 'UNSEALED',
        activationAuthorized: false,
      });
      expect(
        await executeSourceAbandonmentStore(
          readonlyDb,
          { ...request, operation: 'readback' },
          bytes,
        ),
      ).toMatchObject({ state: 'UNSEALED' });
      expect(
        await executeSourceAbandonmentStore(db, { ...request, operation: 'install' }, bytes),
      ).toMatchObject({
        state: 'MATERIALIZED',
        completeChats: 1,
        requiredChats: 1,
        activationAuthorized: false,
      });
      expect(
        await executeSourceAbandonmentStore(
          readonlyDb,
          { ...request, operation: 'readback' },
          bytes,
        ),
      ).toMatchObject({
        state: 'MATERIALIZED',
        completeChats: 1,
        requiredChats: 1,
      });
      expect(await db.webhookEvent.findUniqueOrThrow({ where: { id: ownerId } })).toEqual({
        ...before,
        sourceDispositionId: expect.any(String),
        sourceDispositionReceiptId: ownerId,
      });
      expect(
        await db.webhookExecutionClaim.findMany({ where: { webhookEventId: ownerId } }),
      ).toEqual(claims);
      expect(await db.webhookLegacyRecovery.count({ where: { chatId } })).toBe(0);
      expect(
        await db.webhookSourceAbandonment.findFirstOrThrow({
          where: { ownerWebhookEventId: ownerId },
        }),
      ).toMatchObject({
        chatId,
        messageId: (before.normalizedPayload as { message: { messageId: string } }).message
          .messageId,
        subjectUserId: 'fixture-source-user',
      });
      expect(
        await db.webhookEvent.count({
          where: {
            id: { in: historyWebhookIds },
            status: 'FAILED',
            processedAt: null,
            sourceDispositionId: null,
            sourceDispositionReceiptId: null,
          },
        }),
      ).toBe(historyWebhookIds.length);
      await expect(
        executeSourceAbandonmentStore(db, { ...request, operation: 'install' }, bytes),
      ).rejects.toThrow('cannot be replayed');
      expect(
        await executeSourceAbandonmentStore(
          readonlyDb,
          { ...request, operation: 'readback' },
          bytes,
        ),
      ).toMatchObject({ state: 'MATERIALIZED' });
    },
  );

  it('denies settings drift between certificate creation and atomic installation', async () => {
    const { request, bytes } = await storeFixture();
    await executeSourceAbandonmentStore(db, request, bytes);
    await db.chatSettings.update({
      where: { chatId },
      data: { maxMessageLengthEnabled: true, maxMessageLength: 15 },
    });
    await expect(
      executeSourceAbandonmentStore(db, { ...request, operation: 'install' }, bytes),
    ).rejects.toThrow('evidence changed');
    expect(
      await db.webhookSourceAbandonment.count({ where: { certificateId: request.certificateId } }),
    ).toBe(0);
    expect(await db.webhookEvent.findUniqueOrThrow({ where: { id: ownerId } })).toMatchObject({
      status: 'FAILED',
      sourceDispositionId: null,
      sourceDispositionReceiptId: null,
    });
    expect(
      await db.webhookSourceAbandonmentCertificate.findUniqueOrThrow({
        where: { id: request.certificateId },
      }),
    ).toMatchObject({ sealedAt: null });
  });

  it('rejects altered artifact bytes before installing a certificate', async () => {
    const { request, bytes } = await storeFixture();
    await expect(
      executeSourceAbandonmentStore(db, request, Buffer.concat([bytes, Buffer.from(' ')])),
    ).rejects.toThrow('artifact mismatch');
    expect(
      await db.webhookSourceAbandonmentCertificate.findUnique({
        where: { id: request.certificateId },
      }),
    ).toBeNull();
  });

  it('collects an exact BullMQ child, preserves an independent same-user job, and installs only the exact child hold', async () => {
    const sql = await inventory();
    expect(sql.issues).toEqual([]);
    const source = sql.candidates[0]!.source;
    const queue = await actionQueue();
    const child = {
      actionType: 'DELETE_MESSAGE',
      chatId: source.chatId,
      messageId: source.messageId,
      userId: source.userId,
      idempotencyKey: `child-${randomUUID()}`,
      attempt: 0,
    };
    const independent = {
      ...child,
      messageId: 'another-source',
      idempotencyKey: `independent-${randomUUID()}`,
    };
    await queue.add('action', child, { jobId: child.idempotencyKey });
    await queue.add('action', independent, { jobId: independent.idempotencyKey });
    const before = await redis.hgetall(`bull:max-actions-background:${child.idempotencyKey}`);
    const output = await collect();
    expect(output.issues).toEqual([]);
    expect(output.children).toEqual([
      expect.objectContaining({
        jobKey: child.idempotencyKey,
        queueName: 'max-actions-background',
        chatId: source.chatId,
        messageId: source.messageId,
        userId: source.userId,
      }),
    ]);
    const { request, bytes } = await storeFixture(output);
    await executeSourceAbandonmentStore(db, request, bytes);
    await executeSourceAbandonmentStore(db, { ...request, operation: 'install' }, bytes);
    expect(
      await db.webhookSourceChildHold.findMany({
        where: { abandonment: { certificateId: request.certificateId } },
        include: { abandonment: true },
      }),
    ).toEqual([
      expect.objectContaining({
        childKey: child.idempotencyKey,
        kind: 'MAX_ACTION',
        abandonment: expect.objectContaining({
          chatId: source.chatId,
          messageId: source.messageId,
        }),
      }),
    ]);
    expect(await redis.hgetall(`bull:max-actions-background:${child.idempotencyKey}`)).toEqual(
      before,
    );
    expect(await queue.getJobCounts('paused')).toEqual({ paused: 2 });
    expect(await db.maxActionLedgerEntry.count({ where: { chatId } })).toBe(0);
  });

  it('denies an actionable source-less member job while retaining independently fenced ambiguous history', async () => {
    const queue = await actionQueue();
    const data = {
      actionType: 'BAN_MEMBER',
      chatId,
      userId: 'fixture-source-user',
      idempotencyKey: `unknown-${randomUUID()}`,
      attempt: 0,
    };
    await queue.add('action', data, { jobId: data.idempotencyKey });
    const denied = await collect();
    expect(denied.decision).toBe('DENY');
    expect(denied.issues).toContainEqual(
      expect.objectContaining({ code: 'ACTION_SOURCE_UNPROVED' }),
    );
    expect(denied.inventorySha256).toBeNull();
    const ledger = await db.maxActionLedgerEntry.create({
      data: {
        jobId: data.idempotencyKey,
        chatId,
        userId: data.userId,
        actionType: 'BAN_MEMBER',
        status: 'AMBIGUOUS',
        ambiguous: true,
        attemptCount: 1,
        dispatchStartedAt: new Date(),
      },
    });
    const fenced = await collect();
    expect(fenced.issues).toEqual([]);
    expect(fenced.decision).toBe('READY_TO_INSTALL');
    expect(fenced.children).toEqual([]);
    expect(await db.maxActionLedgerEntry.findUniqueOrThrow({ where: { id: ledger.id } })).toEqual(
      ledger,
    );
    expect(await queue.getJobCounts('paused')).toEqual({ paused: 1 });
  });

  it('accepts Publisher auxiliary TTL expiry only between independently stable cold inventories', async () => {
    const names = ['publisher-start', 'publisher-binding-refresh'];
    for (const name of names) {
      await redis.hset(`bull:${name}:meta`, 'version', 'fixture');
      await redis.set(`bull:${name}:stalled-check`, '1', 'PX', 60_000);
    }
    const reviewed = await collect();
    expect(reviewed.issues).toEqual([]);
    expect(reviewed.decision).toBe('READY_TO_INSTALL');
    for (const name of names) await redis.pexpire(`bull:${name}:stalled-check`, 1);
    await new Promise((done) => setTimeout(done, 20));
    for (const name of names) expect(await redis.exists(`bull:${name}:stalled-check`)).toBe(0);
    const rechecked = await collect();
    expect(rechecked.issues).toEqual([]);
    expect(rechecked.decision).toBe('READY_TO_INSTALL');
    expect(rechecked.redisEvidenceSha256).toBe(reviewed.redisEvidenceSha256);
    expect(rechecked.inventorySha256).toBe(reviewed.inventorySha256);
    for (const name of names) {
      expect(reviewed.redisCatalogs[0]!.namespaceKeyCounts[name]).toBe(2);
      expect(rechecked.redisCatalogs[0]!.namespaceKeyCounts[name]).toBe(1);
    }
    for (const inventory of [reviewed, rechecked]) {
      expect(inventory.redisCatalogs).toHaveLength(2);
      expect(inventory.redisCatalogs.every((catalog) => catalog.complete && !catalog.issue)).toBe(
        true,
      );
      expect(inventory.redisCatalogs[0]!.namespaceKeyCounts).toEqual(
        inventory.redisCatalogs[1]!.namespaceKeyCounts,
      );
    }
    expect(
      await db.webhookSourceAbandonment.findUnique({ where: { ownerWebhookEventId: ownerId } }),
    ).toBeNull();
  });

  it('denies Publisher auxiliary expiry between the two complete reads of one cold inventory', async () => {
    const key = 'bull:publisher-binding-refresh:stalled-check';
    await redis.hset('bull:publisher-binding-refresh:meta', 'version', 'fixture');
    await redis.set(key, '1', 'PX', 60_000);
    let headers = 0;
    const reader: SourceAbandonmentRedisReader = {
      multi: () => redis.multi(),
      async eval_ro(script, keyCount, ...args) {
        const result = await redis.eval_ro(script, keyCount, ...args);
        if (script.startsWith('-- source-abandonment:headers') && ++headers === 2) {
          await redis.pexpire(key, 1);
          await new Promise((done) => setTimeout(done, 20));
          expect(await redis.exists(key)).toBe(0);
        }
        return result;
      },
    };
    const result = await collect(reader);
    expect(headers).toBe(4);
    expect(result.redisCatalogs).toHaveLength(2);
    expect(result.redisCatalogs.every((catalog) => catalog.complete && !catalog.issue)).toBe(true);
    expect(result.decision).toBe('DENY');
    expect(result.issues).toContainEqual({
      code: 'redis_inventory_changed',
      descriptor: 'redis:all',
    });
    expect(result.inventorySha256).toBeNull();
  });

  it('denies a cold inventory when a real Redis job changes between the two complete reads', async () => {
    const sql = await inventory();
    expect(sql.issues).toEqual([]);
    const source = sql.candidates[0]!.source;
    const queue = await actionQueue();
    const key = `changing-${randomUUID()}`;
    await queue.add(
      'action',
      {
        actionType: 'DELETE_MESSAGE',
        chatId: source.chatId,
        messageId: source.messageId,
        userId: source.userId,
        idempotencyKey: key,
        attempt: 0,
      },
      { jobId: key },
    );
    let headers = 0;
    const reader: SourceAbandonmentRedisReader = {
      multi: () => redis.multi(),
      async eval_ro(script, keyCount, ...args) {
        const result = await redis.eval_ro(script, keyCount, ...args);
        if (script.startsWith('-- source-abandonment:headers') && ++headers === 2)
          await redis.hset(`bull:max-actions-background:${key}`, 'progress', '1');
        return result;
      },
    };
    const result = await collect(reader);
    expect(headers).toBe(4);
    expect(result.decision).toBe('DENY');
    expect(result.issues).toContainEqual({
      code: 'redis_inventory_changed',
      descriptor: 'redis:all',
    });
    expect(result.inventorySha256).toBeNull();
    expect(
      await db.webhookSourceAbandonment.findUnique({ where: { ownerWebhookEventId: ownerId } }),
    ).toBeNull();
  });
});
