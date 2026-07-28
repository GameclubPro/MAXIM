import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const describePostgresRace = databaseUrl ? describe : describe.skip;

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

describePostgresRace('PostgreSQL multi-bot routing races', () => {
  let pool: Pool;
  const createdChatIds: string[] = [];
  const createdWebhookEventIds: string[] = [];

  beforeAll(() => {
    assertDisposableDatabaseUrl(databaseUrl);
    pool = new Pool({ connectionString: databaseUrl, max: 12 });
  });

  afterEach(async () => {
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
