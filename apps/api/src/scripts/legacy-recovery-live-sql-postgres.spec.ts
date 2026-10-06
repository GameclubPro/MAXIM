import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { Queue } from 'bullmq';
import { collectLegacyRecoveryLiveEvidence } from './legacy-recovery-effect-collect';
import { collectLegacyRecoveryAdmission } from './legacy-recovery-admission-preview';
import { parseLegacyRecoveryLiveRequest } from './legacy-recovery-live-protocol';
import { LEGACY_RECOVERY_LIVE_QUEUE_NAMES } from './legacy-recovery-live-registry';
import { isLegacyRecoveryWebhookQueue } from './legacy-recovery-queue-inventory';
import { RUNTIME_SERVICE_NAMES } from '../runtime/runtime-topology';
import { LEGACY_RECOVERY_LIVE_BUDGET } from './legacy-recovery-live-budget';
import { Prisma, createPrismaClient, type PrismaClient } from '../prisma/prisma-client';
import { WebhookParser } from '../webhook/webhook.parser';
import { buildWebhookSemanticEventKey } from '../webhook/webhook-semantic-event-key';
import { legacySnapshotDigest } from '../webhook/webhook-legacy-cold-install';
import {
  inventoryLegacyRecoveryLiveSql,
  inventoryLegacyRecoverySelectedSql,
  type LegacyRecoveryLiveSqlSelection,
  measureLegacyRecoverySqlPlan,
  type Allowance,
} from './legacy-recovery-live-sql';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const native = databaseUrl ? describe : describe.skip;
jest.setTimeout(120_000);

native('native bounded live SQL inventory and actual plans', () => {
  let db: PrismaClient;
  let cutoff: Date;
  const prefix = `live-sql-${randomUUID()}`;
  const chatIds: string[] = [];
  const eventIds: string[] = [];

  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    )
      throw new Error('Live SQL fixtures require an isolated localhost race store');
    db = createPrismaClient(databaseUrl, { max: 4, statement_timeout: 5000 });
    const [identity] = await db.$queryRaw<Array<{ timezone: string; version: string }>>`
      SELECT current_setting('TimeZone') AS timezone, version()`;
    if (
      identity?.timezone !== 'UTC' ||
      process.env.TZ !== 'UTC' ||
      !identity.version.startsWith('PostgreSQL 16.')
    )
      throw new Error('Live SQL fixtures require PostgreSQL 16 and UTC');
    cutoff = (
      await db.$queryRaw<Array<{ at: Date }>>`
      SELECT finished_at AS at FROM _prisma_migrations
      WHERE migration_name = '20261005020000_add_multibot_order_fences'
      AND finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY finished_at DESC LIMIT 1`
    )[0]!.at;
    // FLAG: Disposable retained history is intentionally unrelated to the selected
    // receipt. Native EXPLAIN must show exact index access instead of global JSON scans.
    await db.webhookEvent.createMany({
      data: Array.from({ length: 10_000 }, (_, index) => ({
        id: `${prefix}:history:${String(index).padStart(5, '0')}`,
        dedupKey: `${prefix}:dedup:${index}`,
        semanticKey: `${prefix}:semantic:${index}`,
        botId: 'major',
        status: 'PROCESSED' as const,
        rawPayload: {},
        normalizedPayload: {},
        createdAt: new Date(cutoff.getTime() - 10_000),
        processedAt: cutoff,
      })),
    });
    await db.webhookExecutionClaim.createMany({
      data: Array.from({ length: 10_000 }, (_, index) => ({
        id: `${prefix}:history-claim:${index}`,
        kind: 'EXECUTION',
        semanticKey: `${prefix}:semantic:${index}`,
        status: 'COMPLETED' as const,
        createdAt: new Date(cutoff.getTime() - 10_000),
        completedAt: cutoff,
      })),
    });
    await db.$executeRaw`ANALYZE webhook_events`;
    await db.$executeRaw`ANALYZE webhook_execution_claims`;
  });
  afterEach(async () => {
    await db.maxActionLedgerEntry.deleteMany({
      where: { id: { startsWith: `${prefix}:action:` } },
    });
    await db.auditLog.deleteMany({ where: { id: { startsWith: `${prefix}:audit:` } } });
    await db.webhookExecutionClaim.deleteMany({ where: { webhookEventId: { in: eventIds } } });
    await db.webhookEvent.deleteMany({ where: { id: { in: eventIds.splice(0) } } });
    await db.messageRetentionCandidate.deleteMany({ where: { chatId: { in: chatIds } } });
    await db.messageRetentionPolicy.deleteMany({ where: { chatId: { in: chatIds } } });
    await db.chat.deleteMany({ where: { id: { in: chatIds.splice(0) } } });
    await db.nightModeTransitionReconcileRequest.deleteMany({
      where: { chatId: { startsWith: `${prefix}:lookup:` } },
    });
  });
  afterAll(async () => {
    await db.webhookExecutionClaim.deleteMany({
      where: { id: { startsWith: `${prefix}:history-claim:` } },
    });
    await db.webhookEvent.deleteMany({ where: { id: { startsWith: `${prefix}:history:` } } });
    await db.$disconnect();
  });

  function allowance(overrides: Partial<Allowance> = {}): Allowance {
    return {
      pages: 2000,
      rows: 100_000,
      probes: 100_000,
      bytes: 1_000_000_000,
      deadlineAtMs: Date.now() + 60_000,
      ...overrides,
    };
  }
  async function input() {
    const chatId = `-${prefix}-${randomUUID()}`;
    chatIds.push(chatId);
    await db.chat.create({
      data: { id: chatId, entityType: 'CHAT', title: 'Disposable SQL inventory' },
    });
    const timestamp = cutoff.getTime() - 5000;
    const raw = {
      update_type: 'message_created',
      timestamp,
      message: {
        timestamp,
        sender: { user_id: `held-${randomUUID()}`, is_bot: false },
        recipient: { chat_id: chatId, chat_type: 'chat' },
        body: { mid: `source-${randomUUID()}`, text: 'Private native inventory source text' },
      },
    };
    const normalized = new WebhookParser().parse(raw, { botId: 'major' });
    const semanticKey = buildWebhookSemanticEventKey(normalized)!;
    const owner = await db.webhookEvent.create({
      data: {
        botId: 'major',
        dedupKey: randomUUID(),
        semanticKey,
        status: 'FAILED',
        createdAt: new Date(timestamp + 1000),
        rawPayload: {},
        normalizedPayload: normalized as unknown as Prisma.InputJsonValue,
        errorMessage:
          'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:LEGACY_EXECUTION_UNVERIFIED; exact effects proof required',
      },
    });
    eventIds.push(owner.id);
    const claim = await db.webhookExecutionClaim.create({
      data: {
        kind: 'EXECUTION',
        semanticKey,
        webhookEventId: owner.id,
        createdAt: owner.createdAt,
      },
    });
    const request: LegacyRecoveryLiveSqlSelection = {
      selection: { ownerWebhookEventIds: [owner.id], majorBotIds: ['major'] },
    };
    return { request, owner, claim, raw, normalized };
  }
  async function read(request: LegacyRecoveryLiveSqlSelection, limits = allowance()) {
    return db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        return inventoryLegacyRecoveryLiveSql(tx, request, limits);
      },
      { isolationLevel: 'RepeatableRead', timeout: 65_000 },
    );
  }

  async function sourceLookupHistory(selectedChatId: string): Promise<void> {
    // FLAG: Representative unrelated history makes the strict source lookups use
    // their real indexes. No planner hint or production-table change is involved.
    const historyChats = Array.from({ length: 1000 }, (_, index) => `${prefix}:lookup:${index}`);
    chatIds.push(...historyChats);
    await db.chat.createMany({
      data: historyChats.map((id) => ({ id, title: 'Unrelated fixture' })),
    });
    await db.chatSettings.createMany({ data: historyChats.map((chatId) => ({ chatId })) });
    await db.moderationDeleteIntent.createMany({
      data: historyChats.map((chatId, index) => ({
        id: `${prefix}:intent:${index}`,
        chatId: index % 2 === 0 ? selectedChatId : chatId,
        messageId: `unrelated-${index}`,
        retryUntilAt: new Date(Date.now() + 60_000),
      })),
    });
    await db.maxActionLedgerEntry.createMany({
      data: historyChats.map((chatId, index) => ({
        id: `${prefix}:action:${index}`,
        jobId: `${prefix}:action-job:${index}`,
        chatId: index % 2 === 0 ? selectedChatId : chatId,
        messageId: `unrelated-${index}`,
        actionType: 'DELETE_MESSAGE',
      })),
    });
    await db.$executeRaw`ANALYZE chat_settings`;
    await db.$executeRaw`ANALYZE moderation_delete_intents`;
    await db.$executeRaw`ANALYZE max_action_ledger`;
  }

  it('proves the selected original source with plain planning and one read within the production budget', async () => {
    const { request, owner, claim, raw } = await input();
    await sourceLookupHistory(raw.message.recipient.chat_id);
    const before = legacySnapshotDigest({ owner, claim });
    const queries: string[] = [];
    const ledgerReads: Prisma.Sql[] = [];
    const result = await db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        const reader = {
          $queryRaw: async (statement: Prisma.Sql) => {
            queries.push(statement.sql);
            if (
              !statement.sql.startsWith('EXPLAIN') &&
              statement.sql.includes('FROM "max_action_ledger"')
            )
              ledgerReads.push(statement);
            return tx.$queryRaw(statement);
          },
        } as unknown as Prisma.TransactionClient;
        return inventoryLegacyRecoverySelectedSql(
          reader,
          request,
          allowance(LEGACY_RECOVERY_LIVE_BUDGET),
        );
      },
      { isolationLevel: 'RepeatableRead' },
    );
    process.stdout.write(
      `[native-selected-source-cost] ${JSON.stringify({ cost: result.cost, issues: result.issues })}\n`,
    );
    expect(result.issues).toEqual([]);
    expect(result.candidates).toHaveLength(1);
    for (let index = 0; index < queries.length; ) {
      if (queries[index]!.startsWith('EXPLAIN (VERBOSE, FORMAT JSON)')) {
        expect(queries[index]).toBe(`EXPLAIN (VERBOSE, FORMAT JSON) ${queries[index + 1]}`);
        index += 2;
      } else {
        expect(queries[index]).toContain("clock_timestamp() AT TIME ZONE 'UTC'");
        expect(queries[index]).toContain("current_setting('transaction_read_only')");
        expect(queries[index]).toContain("current_setting('TimeZone')");
        index += 1;
      }
    }
    expect(queries.some((query) => /EXPLAIN[^\n]*ANALYZE/u.test(query))).toBe(false);
    expect(
      result.proofs.every((proof) => /:(?:bounded-planning|returned)$/u.test(proof.descriptor)),
    ).toBe(true);
    expect(result.proofs.some((proof) => proof.descriptor === 'sql:audit_logs')).toBe(false);
    expect(result.cost.rows).toBeLessThan(1000);
    expect(
      legacySnapshotDigest({
        owner: await db.webhookEvent.findUniqueOrThrow({ where: { id: owner.id } }),
        claim: await db.webhookExecutionClaim.findUniqueOrThrow({ where: { id: claim.id } }),
      }),
    ).toBe(before);
    // FLAG: Native-only ANALYZE checks physical work against 500 same-chat rows.
    // The production query recorder above proves that its path never runs ANALYZE.
    for (const statement of ledgerReads) {
      const plans = await db.$queryRaw<Array<{ 'QUERY PLAN': unknown }>>(Prisma.sql`
        EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement}`);
      const plan = plans[0]!['QUERY PLAN'];
      expect(measureLegacyRecoverySqlPlan(plan).examinedRows).toBeLessThan(10);
      const root = (plan as Array<{ Plan: Record<string, number> }>)[0]!.Plan;
      expect((root['Shared Hit Blocks'] ?? 0) + (root['Shared Read Blocks'] ?? 0)).toBeLessThan(64);
    }
    await db.maxActionLedgerEntry.create({
      data: {
        id: `${prefix}:action:unknown`,
        jobId: `${prefix}:action-job:unknown`,
        chatId: raw.message.recipient.chat_id,
        messageId: raw.message.body.mid,
        actionType: 'FUTURE_UNKNOWN_ACTION',
      },
    });
    const refused = await db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        return inventoryLegacyRecoverySelectedSql(
          tx,
          request,
          allowance(LEGACY_RECOVERY_LIVE_BUDGET),
        );
      },
      { isolationLevel: 'RepeatableRead' },
    );
    expect(refused.issues.length).toBeGreaterThan(0);
    expect(refused.candidates).toEqual([]);
  });

  it('refuses a shadowed receipt relation before reading its source', async () => {
    const { request, owner } = await input();
    await db.$transaction(
      async (tx) => {
        await tx.$executeRaw`CREATE TEMP TABLE webhook_events (LIKE public.webhook_events INCLUDING ALL) ON COMMIT DROP`;
        await tx.$executeRaw(
          Prisma.sql`INSERT INTO webhook_events SELECT * FROM public.webhook_events WHERE id = ${owner.id}`,
        );
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        const queries: string[] = [];
        const reader = {
          $queryRaw: async (statement: Prisma.Sql) => {
            queries.push(statement.sql);
            return tx.$queryRaw(statement);
          },
        } as unknown as Prisma.TransactionClient;
        const result = await inventoryLegacyRecoverySelectedSql(reader, request, allowance());
        expect(result.issues).toContainEqual({
          code: 'sql_selected_scan_refused',
          descriptor: 'sql:owner-inspection',
        });
        expect(result.candidates).toEqual([]);
        const receiptQueries = queries.filter((query) => query.includes('FROM "webhook_events"'));
        expect(receiptQueries).toHaveLength(1);
        expect(receiptQueries[0]).toMatch(/^EXPLAIN \(VERBOSE, FORMAT JSON\)/u);
      },
      { isolationLevel: 'RepeatableRead', timeout: 35_000 },
    );
  });

  it('completes real online and cold previews while preserving unrelated queued work and unknown receipts', async () => {
    const { request: selection, owner, claim, raw } = await input();
    await sourceLookupHistory(raw.message.recipient.chat_id);
    const redisUrl = new URL(process.env.MAXIM_TEST_REDIS_URL!);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(redisUrl.hostname))
      throw new Error('Combined closure test requires disposable Redis');
    redisUrl.pathname = '/14';
    const redis = new Redis(redisUrl.toString());
    let queue: Queue | undefined;
    let ownsRedis = false;
    try {
      if (await redis.dbsize()) throw new Error('Combined closure Redis database is occupied');
      ownsRedis = true;
      queue = new Queue('max-actions-background', { connection: { url: redisUrl.toString() } });
      await queue.pause();
      await queue.addBulk(
        Array.from({ length: 8_000 }, (_, index) => ({
          name: 'preserved-fixture',
          data: { oldUnknownReceipt: index },
          opts: { jobId: `unrelated-${index}`, delay: 3600_000 },
        })),
      );
      const sourceSha = 'a'.repeat(40);
      const imageId = `sha256:${'b'.repeat(64)}`;
      const onlineRequest = {
        version: 1 as const,
        operation: 'admission_preview' as const,
        sourceSha,
        imageId,
        selection: selection.selection,
      };
      const online = await db.$transaction(
        async (tx) => {
          await tx.$executeRaw`SET TRANSACTION READ ONLY`;
          return collectLegacyRecoveryAdmission(tx, redis, onlineRequest);
        },
        { isolationLevel: 'RepeatableRead', timeout: 35_000 },
      );
      expect(online.issues).toEqual([]);
      expect(online).toMatchObject({
        decision: 'READY_FOR_COLD_REVIEW',
        sourceCoverageComplete: true,
        stoppingAuthorized: false,
        activationAuthorized: false,
        minimumEffectRowsForTwoReads: 16_000,
      });
      const services = [
        ...RUNTIME_SERVICE_NAMES.filter((name) => name !== 'api-all'),
        'ocr-native-sandbox',
        'photo-native-sandbox',
      ];
      const offline = parseLegacyRecoveryLiveRequest(
        JSON.stringify({
          version: 1,
          operation: 'inventory_preview',
          selection: selection.selection,
          binding: {
            maintenanceId: randomUUID(),
            queueFenceNonce: 'combined-native-closure-fence',
            transitionJournalSha256: 'c'.repeat(64),
            sourceSha,
            imageId,
            stoppedGenerations: services.map((serviceName, index) => ({
              serviceName,
              sourceSha,
              imageId,
              containerId: (index + 1).toString(16).padStart(64, '0'),
              stopped: true,
            })),
          },
        }),
      );
      const pipeline = redis.pipeline();
      for (const name of LEGACY_RECOVERY_LIVE_QUEUE_NAMES.filter(isLegacyRecoveryWebhookQueue))
        pipeline.hset(`bull:${name}:meta`, 'paused', '1');
      pipeline.set(
        'maxim:webhook-rollout:pause-owner:v1',
        `rollout:${offline.binding.queueFenceNonce}`,
      );
      await pipeline.exec();
      const preserved = await redis.hgetall('bull:max-actions-background:unrelated-0');
      const proof = await db.$transaction(
        async (tx) => {
          await tx.$executeRaw`SET TRANSACTION READ ONLY`;
          return collectLegacyRecoveryLiveEvidence(tx, redis, offline);
        },
        { isolationLevel: 'RepeatableRead', timeout: 35_000 },
      );
      expect(proof.issues).toEqual([]);
      expect(proof).toMatchObject({
        decision: 'READY_TO_INSTALL',
        applied: false,
        activationAuthorized: false,
        registrySha256: online.registrySha256,
        children: [],
      });
      expect(proof.inventorySha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(proof.previewSha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(await queue.getDelayedCount()).toBe(8_000);
      expect(await redis.hgetall('bull:max-actions-background:unrelated-0')).toEqual(preserved);
      expect(await db.webhookEvent.findUniqueOrThrow({ where: { id: owner.id } })).toEqual(owner);
      expect(await db.webhookExecutionClaim.findUniqueOrThrow({ where: { id: claim.id } })).toEqual(
        claim,
      );
      const commandRaw = {
        ...raw,
        message: { ...raw.message, body: { mid: `held-command-${randomUUID()}`, text: 'Старт' } },
      };
      const commandUpdate = new WebhookParser().parse(commandRaw, { botId: 'major' });
      const command = await db.webhookEvent.create({
        data: {
          botId: 'major',
          dedupKey: randomUUID(),
          semanticKey: buildWebhookSemanticEventKey(commandUpdate),
          status: 'RECEIVED',
          createdAt: owner.createdAt,
          rawPayload: {},
          normalizedPayload: commandUpdate as unknown as Prisma.InputJsonValue,
        },
      });
      eventIds.push(command.id);
      const deniedOnline = await db.$transaction(
        async (tx) => {
          await tx.$executeRaw`SET TRANSACTION READ ONLY`;
          return collectLegacyRecoveryAdmission(tx, redis, onlineRequest);
        },
        { isolationLevel: 'RepeatableRead', timeout: 35_000 },
      );
      const deniedCold = await db.$transaction(
        async (tx) => {
          await tx.$executeRaw`SET TRANSACTION READ ONLY`;
          return collectLegacyRecoveryLiveEvidence(tx, redis, offline);
        },
        { isolationLevel: 'RepeatableRead', timeout: 35_000 },
      );
      for (const denied of [deniedOnline, deniedCold]) {
        expect(denied.decision).toBe('DENY');
        expect(denied.issues).toContainEqual({
          code: 'materialization_preview_blocked',
          descriptor: 'sql:materialization-preview',
        });
      }
      expect(deniedOnline.sourceCoverageComplete).toBe(false);
      expect(deniedCold.inventorySha256).toBeNull();
      expect(await db.webhookEvent.findUniqueOrThrow({ where: { id: command.id } })).toEqual(
        command,
      );
      expect(await queue.getDelayedCount()).toBe(8_000);
    } finally {
      await queue?.close();
      if (ownsRedis) await redis.flushdb();
      redis.disconnect();
    }
  });

  it('reads one exact owner against retained history, accounts every native lookup and does not mutate it', async () => {
    const { request, owner, claim } = await input();
    const before = legacySnapshotDigest({ owner, claim });
    const result = await read(request);
    const bounded = await read(
      request,
      allowance({ pages: 512, rows: 10_000, probes: 50_000, bytes: 8 * 1024 * 1024 }),
    );
    process.stdout.write(
      `[native-sql-inventory-cost] ${JSON.stringify({ generous: result.cost, generousIssues: result.issues, bounded: bounded.cost, boundedIssues: bounded.issues })}\n`,
    );
    expect(result.candidates).toHaveLength(1);
    expect(result.selectedOwners).toMatchObject([
      { ownerWebhookEventId: owner.id, claimId: claim.id },
    ]);
    expect(
      result.issues.filter((issue) =>
        [
          'sql_selected_owner_unproved',
          'sql_history_scan_refused',
          'sql_inventory_query_failed',
          'sql_metadata_reply_unproved',
        ].includes(issue.code),
      ),
    ).toEqual([]);
    const historyPlans = result.proofs.filter((proof) =>
      ['sql:webhook_events', 'sql:webhook_execution_claims'].includes(proof.descriptor),
    );
    expect(historyPlans.length).toBeGreaterThanOrEqual(4);
    expect(
      historyPlans.every((proof) => proof.indexes.length > 0 && proof.examinedRows < 100),
    ).toBe(true);
    expect(result.cost.rows).toBeLessThan(10_000);
    const after = {
      owner: await db.webhookEvent.findUniqueOrThrow({ where: { id: owner.id } }),
      claim: await db.webhookExecutionClaim.findUniqueOrThrow({ where: { id: claim.id } }),
    };
    expect(legacySnapshotDigest(after)).toBe(before);
    const publicProjection = Object.fromEntries(
      Object.entries(result).filter(([key]) => key !== 'candidates'),
    );
    expect(JSON.stringify(publicProjection)).not.toContain('Private native inventory source text');
    expect(JSON.stringify(publicProjection)).not.toContain('"normalizedPayload":');
    expect(JSON.stringify(publicProjection)).not.toContain('"rawPayload":');
  });

  it('measures LIMIT work through real filtered history, loops and buffers, including empty scans', async () => {
    await db.$transaction(async (tx) => {
      // FLAG: Only disposable TEMP data is created. This fixture verifies the LIMIT
      // accounting failure mode; the production adapter contains no writes or DDL.
      await tx.$executeRaw`CREATE TEMP TABLE legacy_inventory_plan_fixture (id integer PRIMARY KEY, marker integer) ON COMMIT DROP`;
      await tx.$executeRaw`INSERT INTO legacy_inventory_plan_fixture SELECT value, CASE WHEN value = 5000 THEN 1 ELSE 0 END FROM generate_series(1, 5000) value`;
      await tx.$executeRaw`ANALYZE legacy_inventory_plan_fixture`;
      const [full] = await tx.$queryRaw<Array<{ 'QUERY PLAN': unknown }>>`
        EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT id FROM legacy_inventory_plan_fixture WHERE marker = 1 LIMIT 1`;
      const measured = measureLegacyRecoverySqlPlan(full!['QUERY PLAN']);
      expect(measured.returnedRows).toBe(1);
      expect(measured.examinedRows).toBeGreaterThanOrEqual(5000);
      expect(measured.bufferBytes).toBeGreaterThan(0);
      const [empty] = await tx.$queryRaw<Array<{ 'QUERY PLAN': unknown }>>`
        EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT id FROM legacy_inventory_plan_fixture WHERE id = -1`;
      expect(measureLegacyRecoverySqlPlan(empty!['QUERY PLAN'])).toMatchObject({
        returnedRows: 0,
        examinedRows: 0,
      });
      expect(measureLegacyRecoverySqlPlan(empty!['QUERY PLAN']).probes).toBeGreaterThan(0);
    });
  });

  it('refuses a missing semantic index before ANALYZE even when PostgreSQL chooses the ordered primary key', async () => {
    const { request, owner } = await input();
    await db.$transaction(
      async (tx) => {
        // FLAG: This isolated TEMP copy has the real receipt schema and PK, but no
        // semantic index. No production index is dropped and no planner hint is used.
        await tx.$executeRaw`CREATE TEMP TABLE webhook_events (LIKE public.webhook_events INCLUDING DEFAULTS) ON COMMIT DROP`;
        await tx.$executeRaw`ALTER TABLE webhook_events ADD PRIMARY KEY (id)`;
        await tx.$executeRaw(Prisma.sql`INSERT INTO webhook_events SELECT * FROM public.webhook_events
        WHERE id LIKE ${`${prefix}:history:%`} OR id = ${owner.id}`);
        await tx.$executeRaw`ANALYZE webhook_events`;
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        const queries: string[] = [];
        const reader = {
          $queryRaw: async (statement: Prisma.Sql) => {
            queries.push(statement.sql);
            return tx.$queryRaw(statement);
          },
        } as unknown as Prisma.TransactionClient;
        const result = await inventoryLegacyRecoveryLiveSql(reader, request, allowance());
        expect(result.issues).toContainEqual({
          code: 'sql_history_scan_refused',
          descriptor: 'sql:webhook_events',
        });
        const mirrorQueries = queries.filter(
          (sql) =>
            sql.includes('WITH page AS MATERIALIZED') && sql.includes('FROM "webhook_events"'),
        );
        expect(mirrorQueries).toHaveLength(1);
        expect(mirrorQueries[0]).toMatch(/^EXPLAIN \(FORMAT JSON\)/u);
        expect(result.selectedOwners).toHaveLength(1);
      },
      { isolationLevel: 'RepeatableRead', timeout: 65_000 },
    );
  });

  it('exhausts skewed audit metadata pages and refuses unknown future source ancestry', async () => {
    const { request, raw } = await input();
    await db.auditLog.createMany({
      data: Array.from({ length: 400 }, (_, index) => ({
        id: `${prefix}:audit:${String(index).padStart(5, '0')}`,
        chatId: raw.message.recipient.chat_id,
        actorUserId: 'unrelated',
        action: 'FUTURE_UNKNOWN_SOURCE',
        payload: { text: 'Metadata must not export this body' },
        createdAt: new Date('2099-01-01'),
      })),
    });
    const result = await read(request);
    expect(result.issues).toContainEqual({
      code: 'sql_source_unresolved',
      descriptor: 'sql:audit_logs',
    });
    expect(
      result.proofs.filter((proof) => proof.descriptor === 'sql:audit_logs').length,
    ).toBeGreaterThanOrEqual(26);
    expect(result.cost.rows).toBeGreaterThan(400);
    const publicProjection = Object.fromEntries(
      Object.entries(result).filter(([key]) => key !== 'candidates'),
    );
    expect(JSON.stringify(publicProjection)).not.toContain('Metadata must not export this body');
    const exhausted = await read(request, allowance({ rows: 1500 }));
    expect(exhausted.issues.some((issue) => issue.code === 'sql_budget_exceeded')).toBe(true);
  });

  it('preserves an independent retention source and refuses a different-chat source of the held author', async () => {
    const { request, raw } = await input();
    const chatId = `-${prefix}-retention-${randomUUID()}`;
    chatIds.push(chatId);
    await db.chat.create({
      data: { id: chatId, entityType: 'CHAT', title: 'Disposable retention source' },
    });
    await db.messageRetentionPolicy.create({
      data: { chatId, activationId: 'native-activation', enabled: true, hours: 24, quotaShard: 0 },
    });
    await db.messageRetentionCandidate.create({
      data: {
        chatId,
        messageId: 'independent',
        authorId: 'independent-author',
        originBotId: 'major',
        sourceAt: new Date(),
        activationId: 'native-activation',
        nextAttemptAt: new Date('2099-01-01'),
      },
    });
    const before = await db.messageRetentionCandidate.findMany({ where: { chatId } });
    const independent = await read(request);
    expect(
      independent.issues.some((issue) => issue.descriptor === 'sql:message_retention_candidates'),
    ).toBe(false);
    // An enabled policy has separate unresolved settings origin; it is never silently
    // counted as independent merely because its retained source passed inspection.
    expect(independent.issues).toContainEqual({
      code: 'sql_source_unresolved',
      descriptor: 'sql:message_retention_policies',
    });
    expect(await db.messageRetentionCandidate.findMany({ where: { chatId } })).toEqual(before);
    await db.messageRetentionCandidate.create({
      data: {
        chatId,
        messageId: 'globally-held',
        authorId: raw.message.sender.user_id,
        originBotId: 'major',
        sourceAt: new Date(),
        activationId: 'native-activation',
        nextAttemptAt: new Date('2099-01-01'),
      },
    });
    const held = await read(request);
    expect(held.issues).toContainEqual({
      code: 'sql_source_unresolved',
      descriptor: 'sql:message_retention_candidates',
    });
  });
});
