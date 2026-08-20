import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import {
  ChatEntityType,
  createPrismaClient,
  Prisma,
  type PrismaClient,
} from '../prisma/prisma-client';
import {
  ManagedEntityAccessWriter,
  type ManagedEntityAccessWriteContext,
} from './managed-entity-access-writer.service';
import { ManagedEntityAccessLossService } from './managed-entity-access-loss.service';
import { MaxBotLinkService } from './max-bot-link.service';
import { MANAGED_ENTITY_ACCESS_LOSS_CLEANUP_JOB_KIND } from './max-chat-admin-roster-sync.queue';
import { ModerationDeleteIntentAccessWakeService } from './moderation-delete-intent-access-wake.service';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const describePostgresRace = databaseUrl ? describe : describe.skip;
const POSTGRES_RACE_TIMEOUT_MS = 30_000;

jest.setTimeout(POSTGRES_RACE_TIMEOUT_MS);

function assertDisposableDatabaseUrl(value: string): void {
  const parsed = new URL(value);
  const databaseName = parsed.pathname.replace(/^\//u, '');
  if (
    !['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname) ||
    !databaseName.includes('race_test')
  ) {
    throw new Error(
      'CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL must target a local database containing race_test',
    );
  }
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  await client.query('ROLLBACK').catch(() => undefined);
}

async function assertRealDisposableDatabase(pool: Pool): Promise<void> {
  const result = await pool.query<{ database_name: string; server_version: string }>(
    'SELECT current_database() AS database_name, version() AS server_version',
  );
  const database = result.rows[0];
  if (
    !database?.database_name.includes('race_test') ||
    !database.server_version.startsWith('PostgreSQL ') ||
    /pglite|wasm/iu.test(database.server_version)
  ) {
    throw new Error(
      'PostgreSQL race tests require a disposable native PostgreSQL race_test database',
    );
  }
}

function createBotLinkService(prisma: PrismaClient, botIds: readonly string[]): MaxBotLinkService {
  const bots = botIds.map((id, index) => ({
    id,
    token: `race-token-${index + 1}`,
    state: 'active',
  }));
  return new MaxBotLinkService(
    prisma as never,
    {
      getBotById: (botId?: string | null) => bots.find((bot) => bot.id === botId) ?? null,
      getDefaultBot: () => bots[0],
      getEntryBot: () => bots[0],
    } as never,
    { getActiveBotId: () => null } as never,
    new ModerationDeleteIntentAccessWakeService(prisma as never),
  );
}

async function waitForBackendBlock(pool: Pool, backendPid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await pool.query<{ blocked: boolean }>(
      'SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked',
      [backendPid],
    );
    if (result.rows[0]?.blocked === true) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`PostgreSQL backend ${backendPid} did not become lock-blocked`);
}

async function waitForBlockedApplicationBackend(
  pool: Pool,
  applicationName: string,
): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await pool.query<{ pid: number }>(
      `SELECT activity.pid
      FROM pg_stat_activity AS activity
      WHERE activity.application_name = $1
        AND cardinality(pg_blocking_pids(activity.pid)) > 0
      LIMIT 1`,
      [applicationName],
    );
    const pid = result.rows[0]?.pid;
    if (typeof pid === 'number') {
      return pid;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`PostgreSQL application ${applicationName} did not become lock-blocked`);
}

describePostgresRace('PostgreSQL multi-bot routing races', () => {
  let pool: Pool;
  const createdChatIds: string[] = [];
  const createdMembershipActivityIds: string[] = [];
  const createdWebhookEventIds: string[] = [];

  beforeAll(async () => {
    assertDisposableDatabaseUrl(databaseUrl);
    pool = new Pool({
      connectionString: databaseUrl,
      max: 12,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 10_000,
    });
    await assertRealDisposableDatabase(pool);
  });

  afterEach(async () => {
    if (createdMembershipActivityIds.length > 0) {
      await pool.query(
        'DELETE FROM "chat_membership_activity_events" WHERE "id" = ANY($1::text[])',
        [createdMembershipActivityIds.splice(0)],
      );
    }
    if (createdWebhookEventIds.length > 0) {
      await pool.query('DELETE FROM "webhook_events" WHERE "id" = ANY($1::text[])', [
        createdWebhookEventIds.splice(0),
      ]);
    }
    if (createdChatIds.length > 0) {
      const chatIds = createdChatIds.splice(0);
      await pool.query('DELETE FROM "chats" WHERE "id" = ANY($1::text[])', [chatIds]);
      await pool.query(
        'DELETE FROM "chat_routing_reconcile_requests" WHERE "chat_id" = ANY($1::text[])',
        [chatIds],
      );
    }
  });

  afterAll(async () => {
    await pool.end();
  });

  it('creates one semantic claim and grants one business lease across six mirrored receipts', async () => {
    const suffix = randomUUID();
    const semanticKey = `postgres-race:${suffix}`;
    const eventIds = Array.from({ length: 6 }, (_, index) => `evt-${index + 1}-${suffix}`);
    createdWebhookEventIds.push(...eventIds);

    for (const [index, eventId] of eventIds.entries()) {
      await pool.query(
        `INSERT INTO "webhook_events" (
          "id", "dedup_key", "bot_id", "status", "raw_payload", "normalized_payload"
        ) VALUES ($1, $2, $3, 'RECEIVED', '{}'::jsonb, $4::jsonb)`,
        [
          eventId,
          `bot-${index + 1}:update-${suffix}`,
          `bot-${index + 1}`,
          JSON.stringify({ type: 'message_created', updateId: `update-${suffix}` }),
        ],
      );
    }

    const inserts = await Promise.all(
      eventIds.map((eventId, index) =>
        pool.query(
          `INSERT INTO "webhook_execution_claims" (
            "id", "kind", "semantic_key", "webhook_event_id", "enforced", "status", "updated_at"
          ) VALUES ($1, 'EXECUTION', $2, $3, TRUE, 'READY', CURRENT_TIMESTAMP)
          ON CONFLICT ("kind", "semantic_key") DO NOTHING`,
          [`claim-${index + 1}-${suffix}`, semanticKey, eventId],
        ),
      ),
    );
    expect(inserts.reduce((sum, result) => sum + (result.rowCount ?? 0), 0)).toBe(1);

    const leases = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        pool.query(
          `UPDATE "webhook_execution_claims"
          SET "lease_token" = $1, "lease_expires_at" = CURRENT_TIMESTAMP + INTERVAL '5 minutes'
          WHERE "kind" = 'EXECUTION'
            AND "semantic_key" = $2
            AND "status" = 'READY'
            AND ("lease_expires_at" IS NULL OR "lease_expires_at" < CURRENT_TIMESTAMP)
          RETURNING "id"`,
          [`lease-${index + 1}-${suffix}`, semanticKey],
        ),
      ),
    );
    expect(leases.reduce((sum, result) => sum + (result.rowCount ?? 0), 0)).toBe(1);
  });

  it('does not lock chats from the membership trigger and preserves a newer dirty epoch', async () => {
    const suffix = randomUUID();
    const chatId = `chat-${suffix}`;
    const botA = `bot-a-${suffix}`;
    const botB = `bot-b-${suffix}`;
    createdChatIds.push(chatId);

    await pool.query(
      `INSERT INTO "chats" (
        "id", "title", "entity_type", "catalog_kind", "routing_state", "routing_version", "updated_at"
      ) VALUES ($1, 'Race chat', 'CHAT', 'MANAGED', 'READY', 0, CURRENT_TIMESTAMP)`,
      [chatId],
    );
    await pool.query(
      `INSERT INTO "chat_bot_memberships" (
        "id", "chat_id", "bot_id", "role", "status", "capabilities", "bot_access_state", "updated_at"
      ) VALUES
        ($1, $3, $4, 'PRIMARY', 'ACTIVE', '[]'::jsonb, 'CONFIRMED_ADMIN', CURRENT_TIMESTAMP),
        ($2, $3, $5, 'STANDBY', 'ACTIVE', '[]'::jsonb, 'CONFIRMED_ADMIN', CURRENT_TIMESTAMP)`,
      [`membership-a-${suffix}`, `membership-b-${suffix}`, chatId, botA, botB],
    );

    const chatWriter = await pool.connect();
    const membershipWriter = await pool.connect();
    try {
      await chatWriter.query('BEGIN');
      await chatWriter.query(`SET LOCAL lock_timeout = '2s'`);
      await chatWriter.query('UPDATE "chats" SET "title" = $2 WHERE "id" = $1', [
        chatId,
        'Chat row locked',
      ]);

      await membershipWriter.query('BEGIN');
      await membershipWriter.query(`SET LOCAL lock_timeout = '2s'`);
      const membershipUpdate = membershipWriter.query(
        `UPDATE "chat_bot_memberships"
        SET "permissions_snapshot" = $3::jsonb
        WHERE "chat_id" = $1 AND "bot_id" = $2`,
        [chatId, botB, JSON.stringify({ isAdmin: true, permissions: ['write'] })],
      );
      await expect(
        Promise.race([
          membershipUpdate,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('membership trigger waited on chats')), 1_500),
          ),
        ]),
      ).resolves.toEqual(expect.objectContaining({ rowCount: 1 }));
      await membershipWriter.query('COMMIT');

      await chatWriter.query(
        `UPDATE "chat_bot_memberships"
        SET "role" = 'PRIMARY'
        WHERE "chat_id" = $1 AND "bot_id" = $2`,
        [chatId, botA],
      );
      await chatWriter.query('COMMIT');
    } catch (error: unknown) {
      await Promise.all([rollbackQuietly(chatWriter), rollbackQuietly(membershipWriter)]);
      throw error;
    } finally {
      chatWriter.release();
      membershipWriter.release();
    }

    const claimed = await pool.query<{ generation: string }>(
      `UPDATE "chat_routing_reconcile_requests"
      SET "lease_token" = $2, "lease_expires_at" = CURRENT_TIMESTAMP + INTERVAL '30 seconds'
      WHERE "chat_id" = $1
      RETURNING "generation"::text`,
      [chatId, `routing-lease-${suffix}`],
    );
    expect(claimed.rowCount).toBe(1);
    const claimedGeneration = BigInt(claimed.rows[0]!.generation);

    await pool.query(
      `UPDATE "chat_bot_memberships"
      SET "bot_access_state" = 'DENIED'
      WHERE "chat_id" = $1 AND "bot_id" = $2`,
      [chatId, botB],
    );
    const staleCompletion = await pool.query(
      `DELETE FROM "chat_routing_reconcile_requests"
      WHERE "chat_id" = $1 AND "generation" = $2 AND "lease_token" = $3`,
      [chatId, claimedGeneration.toString(), `routing-lease-${suffix}`],
    );
    expect(staleCompletion.rowCount).toBe(0);

    const remaining = await pool.query<{
      generation: string;
      lease_token: string | null;
      lease_expires_at: Date | null;
    }>(
      `SELECT "generation"::text, "lease_token", "lease_expires_at"
      FROM "chat_routing_reconcile_requests"
      WHERE "chat_id" = $1`,
      [chatId],
    );
    expect(remaining.rows).toEqual([
      expect.objectContaining({
        generation: (claimedGeneration + 1n).toString(),
        lease_token: null,
        lease_expires_at: null,
      }),
    ]);

    await pool.query(
      `UPDATE "chat_routing_reconcile_requests"
      SET "lease_token" = 'expired-worker',
          "lease_expires_at" = CURRENT_TIMESTAMP - INTERVAL '1 second'
      WHERE "chat_id" = $1`,
      [chatId],
    );
    const takeover = await pool.query(
      `UPDATE "chat_routing_reconcile_requests"
      SET "lease_token" = 'takeover-worker',
          "lease_expires_at" = CURRENT_TIMESTAMP + INTERVAL '30 seconds'
      WHERE "chat_id" = $1
        AND ("lease_expires_at" IS NULL OR "lease_expires_at" < CURRENT_TIMESTAMP)
      RETURNING "chat_id"`,
      [chatId],
    );
    expect(takeover.rowCount).toBe(1);
  });

  it('checks the membership epoch in a fresh statement after waiting for the chat lock', async () => {
    const suffix = randomUUID();
    const chatId = `chat-membership-fence-${suffix}`;
    const botId = `bot-membership-fence-${suffix}`;
    const userId = `user-membership-fence-${suffix}`;
    const membershipId = `membership-fence-${suffix}`;
    const activityId = `membership-activity-${suffix}`;
    const probeStartedAt = new Date('2026-08-20T12:00:00.000Z');
    const membershipEventAt = new Date(probeStartedAt.getTime() + 1);
    createdChatIds.push(chatId);
    createdMembershipActivityIds.push(activityId);

    await pool.query(
      `INSERT INTO "chats" (
        "id", "title", "entity_type", "catalog_kind", "routing_state", "routing_version",
        "bot_id", "primary_bot_id", "updated_at"
      ) VALUES ($1, 'Membership fence', 'CHAT', 'MANAGED', 'READY', 0, $2, $2, CURRENT_TIMESTAMP)`,
      [chatId, botId],
    );
    await pool.query(
      `INSERT INTO "chat_bot_memberships" (
        "id", "chat_id", "bot_id", "role", "status", "capabilities", "bot_access_state",
        "bot_access_checked_at", "bot_access_source", "updated_at"
      ) VALUES (
        $1, $2, $3, 'PRIMARY', 'ACTIVE', '[]'::jsonb, 'CONFIRMED_ADMIN',
        $4, 'handshake_start', CURRENT_TIMESTAMP
      )`,
      [membershipId, chatId, botId, probeStartedAt],
    );

    const lifecycleWriter = await pool.connect();
    const prisma = createPrismaClient(databaseUrl, {
      max: 1,
      statement_timeout: 10_000,
    });
    const accessWriter = new ManagedEntityAccessWriter(prisma as never, {} as never, {} as never);
    const lockCurrentProbe = (
      accessWriter as unknown as {
        lockCurrentProbe: (
          tx: Prisma.TransactionClient,
          context: ManagedEntityAccessWriteContext,
          checkedAt: Date,
        ) => Promise<boolean>;
      }
    ).lockCurrentProbe.bind(accessWriter);
    const context: ManagedEntityAccessWriteContext = {
      chatId,
      botId,
      senderId: userId,
      title: 'Membership fence',
      entityType: 'chat',
      prismaEntityType: ChatEntityType.CHAT,
      createdAt: null,
    };
    let grantCheck: Promise<boolean> | null = null;

    try {
      await prisma.$connect();
      await expect(
        prisma.$transaction((tx) => lockCurrentProbe(tx, context, probeStartedAt), {
          isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
          maxWait: 5_000,
          timeout: 15_000,
        }),
      ).resolves.toBe(true);

      await lifecycleWriter.query('BEGIN');
      await lifecycleWriter.query(`SET LOCAL lock_timeout = '5s'`);
      await lifecycleWriter.query('SELECT "id" FROM "chats" WHERE "id" = $1 FOR UPDATE', [chatId]);

      let resolveProbeBackendPid: ((pid: number) => void) | null = null;
      const probeBackendPid = new Promise<number>((resolve) => {
        resolveProbeBackendPid = resolve;
      });
      grantCheck = prisma.$transaction(
        async (tx) => {
          const backend = await tx.$queryRaw<Array<{ pid: number }>>`
            SELECT pg_backend_pid() AS pid
          `;
          const backendPid = backend[0]?.pid;
          if (typeof backendPid !== 'number') {
            throw new Error('Could not resolve the access-probe PostgreSQL backend');
          }
          resolveProbeBackendPid?.(backendPid);
          return lockCurrentProbe(tx, context, probeStartedAt);
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
          maxWait: 5_000,
          timeout: 15_000,
        },
      );
      const backendPid = await Promise.race([
        probeBackendPid,
        grantCheck.then(() => {
          throw new Error('Access probe settled before reaching the chat lock');
        }),
      ]);
      await waitForBackendBlock(pool, backendPid);

      await lifecycleWriter.query(
        `INSERT INTO "chat_membership_activity_events" (
          "id", "dedupe_key", "bot_id", "chat_id", "event_type", "user_id", "event_at",
          "created_at"
        ) VALUES ($1, $2, $3, $4, 'user_removed', $5, $6, $6)`,
        [activityId, `membership-fence:${suffix}`, botId, chatId, userId, membershipEventAt],
      );
      await lifecycleWriter.query('COMMIT');

      await expect(grantCheck).resolves.toBe(false);
    } catch (error: unknown) {
      await rollbackQuietly(lifecycleWriter);
      throw error;
    } finally {
      await rollbackQuietly(lifecycleWriter);
      await grantCheck?.catch(() => undefined);
      await prisma.$disconnect();
      lifecycleWriter.release();
    }
  });

  it('keeps a same-epoch committed removal ahead of a racing primary selection', async () => {
    const suffix = randomUUID();
    const chatId = `chat-route-lock-${suffix}`;
    const selectedBotId = `bot-selected-${suffix}`;
    const membershipId = `membership-selected-${suffix}`;
    const probeStartedAt = new Date();
    const accessExpiresAt = new Date(probeStartedAt.getTime() + 10 * 60_000);
    const selectionApplicationName = `route-selection-${suffix}`;
    const removalApplicationName = `route-removal-${suffix}`;
    createdChatIds.push(chatId);

    await pool.query(
      `INSERT INTO "chats" (
        "id", "title", "entity_type", "catalog_kind", "routing_state", "routing_version",
        "bot_id", "primary_bot_id", "updated_at"
      ) VALUES ($1, 'Locked route', 'CHAT', 'MANAGED', 'NO_ELIGIBLE_BOT', 7, NULL, NULL, $2)`,
      [chatId, probeStartedAt],
    );
    await pool.query(
      `INSERT INTO "chat_bot_memberships" (
        "id", "chat_id", "bot_id", "role", "status", "capabilities", "bot_access_state",
        "bot_access_checked_at", "bot_access_expires_at", "bot_access_source",
        "permissions_snapshot", "updated_at"
      ) VALUES (
        $1, $2, $3, 'STANDBY', 'ACTIVE', '[]'::jsonb, 'CONFIRMED_ADMIN',
        $4, $5, 'execution_planner_primary', $6::jsonb, $4
      )`,
      [
        membershipId,
        chatId,
        selectedBotId,
        probeStartedAt,
        accessExpiresAt,
        JSON.stringify({
          checkedAt: probeStartedAt.toISOString(),
          isAdmin: true,
          isOwner: false,
          permissions: ['write'],
        }),
      ],
    );

    const blocker = await pool.connect();
    const selectionPrisma = createPrismaClient(databaseUrl, {
      application_name: selectionApplicationName,
      max: 1,
      statement_timeout: 10_000,
    });
    const removalPrisma = createPrismaClient(databaseUrl, {
      application_name: removalApplicationName,
      max: 1,
      statement_timeout: 10_000,
    });
    const selectionService = createBotLinkService(selectionPrisma, [selectedBotId]);
    const removalService = createBotLinkService(removalPrisma, [selectedBotId]);
    let selection: Promise<boolean> | null = null;
    let removal: Promise<string | null> | null = null;

    try {
      await Promise.all([selectionPrisma.$connect(), removalPrisma.$connect()]);
      await blocker.query('BEGIN');
      await blocker.query(`SET LOCAL lock_timeout = '5s'`);
      await blocker.query(`SELECT "id" FROM "chats" WHERE "id" = $1 FOR UPDATE`, [chatId]);
      await blocker.query(
        `SELECT "id"
        FROM "chat_bot_memberships"
        WHERE "chat_id" = $1
        ORDER BY "bot_id" ASC, "id" ASC
        FOR UPDATE`,
        [chatId],
      );

      selection = selectionService.selectChatPrimaryBot({
        chatId,
        botId: selectedBotId,
        expectedRoutingVersion: 7,
        expectedAccessEpoch: {
          checkedAt: probeStartedAt,
          source: 'execution_planner_primary',
        },
      });
      removal = removalService.markChatBotRemoved({
        chatId,
        botId: selectedBotId,
        title: 'Locked route',
        entityType: ChatEntityType.CHAT,
        lifecycleEventAt: probeStartedAt,
        lifecycleEventType: 'bot_removed',
        lifecycleSource: 'webhook',
      });
      await Promise.all([
        waitForBlockedApplicationBackend(pool, selectionApplicationName),
        waitForBlockedApplicationBackend(pool, removalApplicationName),
      ]);

      await blocker.query('COMMIT');
      const [, removalPrimaryBotId] = await Promise.all([selection, removal]);
      expect(removalPrimaryBotId).toBeNull();

      const visibleChat = await pool.query<{
        bot_id: string | null;
        primary_bot_id: string | null;
        routing_state: string;
        routing_version: number;
      }>(
        `SELECT "bot_id", "primary_bot_id", "routing_state", "routing_version"
        FROM "chats"
        WHERE "id" = $1`,
        [chatId],
      );
      const visibleMemberships = await pool.query<{
        bot_id: string;
        role: string;
        status: string;
        lifecycle_event_at: Date | null;
        lifecycle_event_type: string | null;
        lifecycle_source: string | null;
      }>(
        `SELECT "bot_id", "role", "status", "lifecycle_event_at", "lifecycle_event_type",
          "lifecycle_source"
        FROM "chat_bot_memberships"
        WHERE "chat_id" = $1
        ORDER BY "bot_id" ASC`,
        [chatId],
      );
      expect(visibleChat.rows).toEqual([
        expect.objectContaining({
          bot_id: null,
          primary_bot_id: null,
          routing_state: 'NO_ELIGIBLE_BOT',
        }),
      ]);
      expect(visibleMemberships.rows).toEqual([
        {
          bot_id: selectedBotId,
          role: 'STANDBY',
          status: 'REMOVED',
          lifecycle_event_at: probeStartedAt,
          lifecycle_event_type: 'bot_removed',
          lifecycle_source: 'webhook',
        },
      ]);
      await expect(
        selectionService.resolveBotRoute({ purpose: 'send_message', chatId }),
      ).resolves.toEqual(
        expect.objectContaining({
          botId: null,
          candidateBotIds: [],
        }),
      );
    } catch (error: unknown) {
      await rollbackQuietly(blocker);
      await Promise.allSettled([selection, removal].filter((value) => value !== null));
      throw error;
    } finally {
      await rollbackQuietly(blocker);
      await Promise.all([selectionPrisma.$disconnect(), removalPrisma.$disconnect()]);
      blocker.release();
    }
  });

  it('lets a blocked positive access probe fence deferred cleanup through the parent chat', async () => {
    const suffix = randomUUID();
    const chatId = `chat-cleanup-probe-fence-${suffix}`;
    const lostBotId = `bot-lost-${suffix}`;
    const survivorBotId = `bot-survivor-${suffix}`;
    const lostMembershipId = `membership-lost-${suffix}`;
    const survivorMembershipId = `membership-survivor-${suffix}`;
    const probeAt = new Date();
    const lossAt = new Date(probeAt.getTime() - 30_333);
    const probeApplicationName = `access-probe-${suffix}`;
    const cleanupApplicationName = `access-cleanup-${suffix}`;
    createdChatIds.push(chatId);

    await pool.query(
      `INSERT INTO "chats" (
        "id", "title", "entity_type", "catalog_kind", "routing_state", "routing_version",
        "bot_id", "primary_bot_id", "updated_at"
      ) VALUES ($1, 'Cleanup probe fence', 'CHAT', 'MANAGED', 'NO_ELIGIBLE_BOT', 0, NULL, NULL, $2)`,
      [chatId, lossAt],
    );
    await pool.query(
      `INSERT INTO "chat_bot_memberships" (
        "id", "chat_id", "bot_id", "role", "status", "capabilities", "bot_access_state",
        "lifecycle_event_at", "lifecycle_event_type", "lifecycle_source", "updated_at"
      ) VALUES
        ($1, $3, $4, 'STANDBY', 'REMOVED', '[]'::jsonb, 'DENIED', $6, 'bot_removed',
          'webhook', $6),
        ($2, $3, $5, 'STANDBY', 'ACTIVE', '[]'::jsonb, 'UNKNOWN', NULL, NULL, NULL, $6)`,
      [lostMembershipId, survivorMembershipId, chatId, lostBotId, survivorBotId, lossAt],
    );

    const membershipBlocker = await pool.connect();
    const probePrisma = createPrismaClient(databaseUrl, {
      application_name: probeApplicationName,
      max: 1,
      statement_timeout: 10_000,
    });
    const cleanupPrisma = createPrismaClient(databaseUrl, {
      application_name: cleanupApplicationName,
      max: 1,
      statement_timeout: 10_000,
    });
    const probeService = createBotLinkService(probePrisma, [lostBotId, survivorBotId]);
    const cleanupService = new ManagedEntityAccessLossService(
      cleanupPrisma as never,
      {} as never,
      {} as never,
      undefined,
      undefined,
      {
        getActionableBots: () => [{ id: lostBotId }, { id: survivorBotId }],
      } as never,
    );
    let positiveProbe: Promise<boolean> | null = null;
    let deferredCleanup: ReturnType<
      ManagedEntityAccessLossService['processDeferredRuntimeCleanup']
    > | null = null;

    try {
      await Promise.all([probePrisma.$connect(), cleanupPrisma.$connect()]);
      await membershipBlocker.query('BEGIN');
      await membershipBlocker.query(`SET LOCAL lock_timeout = '5s'`);
      await membershipBlocker.query(
        `SELECT "id"
        FROM "chat_bot_memberships"
        WHERE "chat_id" = $1 AND "bot_id" = $2
        FOR UPDATE`,
        [chatId, survivorBotId],
      );

      positiveProbe = probeService.recordBotAccessProbe({
        chatId,
        botId: survivorBotId,
        access: {
          isAdmin: true,
          isOwner: false,
          permissions: ['write'],
        },
        source: 'cleanup_race_positive_probe',
        checkedAt: probeAt,
      });
      await waitForBlockedApplicationBackend(pool, probeApplicationName);

      deferredCleanup = cleanupService.processDeferredRuntimeCleanup({
        kind: MANAGED_ENTITY_ACCESS_LOSS_CLEANUP_JOB_KIND,
        chatId,
        botId: lostBotId,
        lifecycleEventAt: lossAt.toISOString(),
        lifecycleEventType: 'bot_removed',
        lifecycleSource: 'webhook',
        reason: 'bot_removed',
        source: 'webhook_bot_removed',
      });
      await waitForBlockedApplicationBackend(pool, cleanupApplicationName);

      await membershipBlocker.query('COMMIT');
      await expect(positiveProbe).resolves.toBe(true);
      await expect(deferredCleanup).resolves.toEqual({
        applied: false,
        skippedReason: 'surviving_access',
        cleanup: expect.objectContaining({
          canceledBroadcasts: null,
          pausedVkSources: null,
        }),
      });

      await expect(
        pool.query<{
          status: string;
          bot_access_state: string;
          bot_access_checked_at: Date | null;
        }>(
          `SELECT "status", "bot_access_state", "bot_access_checked_at"
          FROM "chat_bot_memberships"
          WHERE "chat_id" = $1 AND "bot_id" = $2`,
          [chatId, survivorBotId],
        ),
      ).resolves.toEqual(
        expect.objectContaining({
          rows: [
            expect.objectContaining({
              status: 'ACTIVE',
              bot_access_state: 'CONFIRMED_ADMIN',
              bot_access_checked_at: probeAt,
            }),
          ],
        }),
      );
    } catch (error: unknown) {
      await rollbackQuietly(membershipBlocker);
      await Promise.allSettled([positiveProbe, deferredCleanup]);
      throw error;
    } finally {
      await rollbackQuietly(membershipBlocker);
      await Promise.all([probePrisma.$disconnect(), cleanupPrisma.$disconnect()]);
      membershipBlocker.release();
    }
  });

  it('keeps a newer positive access probe ahead of a delayed older removal', async () => {
    const suffix = randomUUID();
    const chatId = `chat-positive-probe-removal-fence-${suffix}`;
    const botId = `bot-positive-probe-removal-fence-${suffix}`;
    const membershipId = `membership-positive-probe-removal-fence-${suffix}`;
    const removalAt = new Date('2026-08-20T12:00:00.123Z');
    const probeAt = new Date('2026-08-20T12:00:30.456Z');
    const probeApplicationName = `positive-probe-${suffix}`;
    const removalApplicationName = `older-removal-${suffix}`;
    createdChatIds.push(chatId);

    await pool.query(
      `INSERT INTO "chats" (
        "id", "title", "entity_type", "catalog_kind", "routing_state", "routing_version",
        "bot_id", "primary_bot_id", "updated_at"
      ) VALUES ($1, 'Positive probe removal fence', 'CHAT', 'MANAGED', 'READY', 0, $2, $2, $3)`,
      [chatId, botId, removalAt],
    );
    await pool.query(
      `INSERT INTO "chat_bot_memberships" (
        "id", "chat_id", "bot_id", "role", "status", "capabilities", "bot_access_state",
        "updated_at"
      ) VALUES ($1, $2, $3, 'PRIMARY', 'ACTIVE', '[]'::jsonb, 'UNKNOWN', $4)`,
      [membershipId, chatId, botId, removalAt],
    );

    const membershipBlocker = await pool.connect();
    const probePrisma = createPrismaClient(databaseUrl, {
      application_name: probeApplicationName,
      max: 1,
      statement_timeout: 10_000,
    });
    const removalPrisma = createPrismaClient(databaseUrl, {
      application_name: removalApplicationName,
      max: 1,
      statement_timeout: 10_000,
    });
    const probeService = createBotLinkService(probePrisma, [botId]);
    const removalService = createBotLinkService(removalPrisma, [botId]);
    let positiveProbe: Promise<boolean> | null = null;
    let delayedRemoval: Promise<string | null> | null = null;

    try {
      await Promise.all([probePrisma.$connect(), removalPrisma.$connect()]);
      await membershipBlocker.query('BEGIN');
      await membershipBlocker.query(`SET LOCAL lock_timeout = '5s'`);
      await membershipBlocker.query(
        `SELECT "id"
        FROM "chat_bot_memberships"
        WHERE "chat_id" = $1 AND "bot_id" = $2
        FOR UPDATE`,
        [chatId, botId],
      );

      positiveProbe = probeService.recordBotAccessProbe({
        chatId,
        botId,
        access: {
          isAdmin: true,
          isOwner: false,
          permissions: ['write'],
        },
        source: 'positive_probe_removal_race',
        checkedAt: probeAt,
      });
      await waitForBlockedApplicationBackend(pool, probeApplicationName);

      delayedRemoval = removalService.markChatBotRemoved({
        chatId,
        botId,
        title: 'Positive probe removal fence',
        entityType: ChatEntityType.CHAT,
        lifecycleEventAt: removalAt,
        lifecycleEventType: 'bot_removed',
        lifecycleSource: 'webhook',
      });
      await waitForBlockedApplicationBackend(pool, removalApplicationName);

      await membershipBlocker.query('COMMIT');
      await expect(positiveProbe).resolves.toBe(true);
      await expect(delayedRemoval).resolves.toBe(botId);

      await expect(
        pool.query<{
          status: string;
          bot_access_state: string;
          bot_access_checked_at: Date | null;
          lifecycle_event_at: Date | null;
        }>(
          `SELECT "status", "bot_access_state", "bot_access_checked_at", "lifecycle_event_at"
          FROM "chat_bot_memberships"
          WHERE "chat_id" = $1 AND "bot_id" = $2`,
          [chatId, botId],
        ),
      ).resolves.toEqual(
        expect.objectContaining({
          rows: [
            expect.objectContaining({
              status: 'ACTIVE',
              bot_access_state: 'CONFIRMED_ADMIN',
              bot_access_checked_at: probeAt,
              lifecycle_event_at: null,
            }),
          ],
        }),
      );
    } catch (error: unknown) {
      await rollbackQuietly(membershipBlocker);
      await Promise.allSettled([positiveProbe, delayedRemoval]);
      throw error;
    } finally {
      await rollbackQuietly(membershipBlocker);
      await Promise.all([probePrisma.$disconnect(), removalPrisma.$disconnect()]);
      membershipBlocker.release();
    }
  });

  it('keeps a newer denied access probe ahead of a delayed older bot_added', async () => {
    const suffix = randomUUID();
    const chatId = `chat-denied-probe-add-fence-${suffix}`;
    const botId = `bot-denied-probe-add-fence-${suffix}`;
    const membershipId = `membership-denied-probe-add-fence-${suffix}`;
    const priorLifecycleAt = new Date('2026-08-20T11:59:30.000Z');
    const addedAt = new Date('2026-08-20T12:00:00.123Z');
    const probeAt = new Date('2026-08-20T12:00:30.456Z');
    const probeApplicationName = `denied-probe-${suffix}`;
    const addApplicationName = `older-add-${suffix}`;
    createdChatIds.push(chatId);

    await pool.query(
      `INSERT INTO "chats" (
        "id", "title", "entity_type", "catalog_kind", "routing_state", "routing_version",
        "bot_id", "primary_bot_id", "updated_at"
      ) VALUES ($1, 'Denied probe add fence', 'CHAT', 'MANAGED', 'READY', 0, $2, $2, $3)`,
      [chatId, botId, priorLifecycleAt],
    );
    await pool.query(
      `INSERT INTO "chat_bot_memberships" (
        "id", "chat_id", "bot_id", "role", "status", "capabilities", "bot_access_state",
        "lifecycle_event_at", "lifecycle_event_type", "lifecycle_source", "updated_at"
      ) VALUES (
        $1, $2, $3, 'PRIMARY', 'ACTIVE', '[]'::jsonb, 'UNKNOWN', $4, 'bot_added',
        'webhook', $4
      )`,
      [membershipId, chatId, botId, priorLifecycleAt],
    );

    const membershipBlocker = await pool.connect();
    const probePrisma = createPrismaClient(databaseUrl, {
      application_name: probeApplicationName,
      max: 1,
      statement_timeout: 10_000,
    });
    const addPrisma = createPrismaClient(databaseUrl, {
      application_name: addApplicationName,
      max: 1,
      statement_timeout: 10_000,
    });
    const probeService = createBotLinkService(probePrisma, [botId]);
    const addService = createBotLinkService(addPrisma, [botId]);
    let deniedProbe: Promise<boolean> | null = null;
    let delayedAdd: Promise<string | null> | null = null;

    try {
      await Promise.all([probePrisma.$connect(), addPrisma.$connect()]);
      await membershipBlocker.query('BEGIN');
      await membershipBlocker.query(`SET LOCAL lock_timeout = '5s'`);
      await membershipBlocker.query(
        `SELECT "id"
        FROM "chat_bot_memberships"
        WHERE "chat_id" = $1 AND "bot_id" = $2
        FOR UPDATE`,
        [chatId, botId],
      );

      deniedProbe = probeService.recordBotAccessProbe({
        chatId,
        botId,
        access: null,
        source: 'denied_probe_add_race',
        checkedAt: probeAt,
        lastErrorCode: 'chat.denied',
      });
      await waitForBlockedApplicationBackend(pool, probeApplicationName);

      delayedAdd = addService.bindChatToBot({
        chatId,
        botId,
        title: 'Denied probe add fence',
        entityType: ChatEntityType.CHAT,
        lifecycleEventAt: addedAt,
        lifecycleEventType: 'bot_added',
        lifecycleSource: 'webhook',
      });
      await waitForBlockedApplicationBackend(pool, addApplicationName);

      await membershipBlocker.query('COMMIT');
      await expect(deniedProbe).resolves.toBe(true);
      await expect(delayedAdd).resolves.toBeNull();

      await expect(
        pool.query<{
          status: string;
          bot_access_state: string;
          bot_access_checked_at: Date | null;
          bot_access_source: string | null;
          lifecycle_event_at: Date | null;
          lifecycle_event_type: string | null;
        }>(
          `SELECT "status", "bot_access_state", "bot_access_checked_at", "bot_access_source",
            "lifecycle_event_at", "lifecycle_event_type"
          FROM "chat_bot_memberships"
          WHERE "chat_id" = $1 AND "bot_id" = $2`,
          [chatId, botId],
        ),
      ).resolves.toEqual(
        expect.objectContaining({
          rows: [
            expect.objectContaining({
              status: 'ACTIVE',
              bot_access_state: 'DENIED',
              bot_access_checked_at: probeAt,
              bot_access_source: 'denied_probe_add_race',
              lifecycle_event_at: priorLifecycleAt,
              lifecycle_event_type: 'bot_added',
            }),
          ],
        }),
      );
      await expect(
        pool.query<{ primary_bot_id: string | null; routing_state: string }>(
          `SELECT "primary_bot_id", "routing_state" FROM "chats" WHERE "id" = $1`,
          [chatId],
        ),
      ).resolves.toEqual(
        expect.objectContaining({
          rows: [{ primary_bot_id: null, routing_state: 'NO_ELIGIBLE_BOT' }],
        }),
      );
    } catch (error: unknown) {
      await rollbackQuietly(membershipBlocker);
      await Promise.allSettled([deniedProbe, delayedAdd]);
      throw error;
    } finally {
      await rollbackQuietly(membershipBlocker);
      await Promise.all([probePrisma.$disconnect(), addPrisma.$disconnect()]);
      membershipBlocker.release();
    }
  });

  it('grants exactly one half-open publication claim for a disappeared send route', async () => {
    const suffix = randomUUID();
    const chatId = `chat-half-open-${suffix}`;
    const botId = `bot-half-open-${suffix}`;
    const membershipId = `membership-half-open-${suffix}`;
    const claimedAt = new Date('2026-07-27T18:00:01.000Z');
    const claimedUntil = new Date('2026-07-28T00:00:01.000Z');
    createdChatIds.push(chatId);

    await pool.query(
      `INSERT INTO "chats" (
        "id", "title", "entity_type", "catalog_kind", "routing_state", "routing_version", "updated_at"
      ) VALUES ($1, 'Half-open race', 'CHAT', 'MANAGED', 'READY', 0, CURRENT_TIMESTAMP)`,
      [chatId],
    );
    await pool.query(
      `INSERT INTO "chat_bot_memberships" (
        "id", "chat_id", "bot_id", "role", "status", "capabilities", "bot_access_state",
        "send_route_failure_count", "send_route_quarantined_until",
        "send_route_last_failure_code", "updated_at"
      ) VALUES (
        $1, $2, $3, 'PRIMARY', 'ACTIVE', '[]'::jsonb, 'CONFIRMED_ADMIN',
        1, $4, 'PUBLICATION_MESSAGE_DISAPPEARED', CURRENT_TIMESTAMP
      )`,
      [membershipId, chatId, botId, new Date('2026-07-27T18:00:00.000Z')],
    );

    const claims = await Promise.all(
      Array.from({ length: 6 }, () =>
        pool.query(
          `UPDATE "chat_bot_memberships"
          SET "send_route_quarantined_until" = $4
          WHERE "chat_id" = $1
            AND "bot_id" = $2
            AND "status" = 'ACTIVE'
            AND "send_route_failure_count" = 1
            AND "send_route_last_failure_code" = 'PUBLICATION_MESSAGE_DISAPPEARED'
            AND (
              "send_route_quarantined_until" IS NULL
              OR "send_route_quarantined_until" <= $3
            )
          RETURNING "id"`,
          [chatId, botId, claimedAt, claimedUntil],
        ),
      ),
    );

    expect(claims.reduce((sum, result) => sum + (result.rowCount ?? 0), 0)).toBe(1);
    await expect(
      pool.query<{ send_route_quarantined_until: Date }>(
        `SELECT "send_route_quarantined_until"
        FROM "chat_bot_memberships"
        WHERE "chat_id" = $1 AND "bot_id" = $2`,
        [chatId, botId],
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        rows: [expect.objectContaining({ send_route_quarantined_until: claimedUntil })],
      }),
    );
  });
});
