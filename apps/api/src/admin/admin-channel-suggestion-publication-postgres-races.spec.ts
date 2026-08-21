import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const describePostgresRace = databaseUrl ? describe : describe.skip;

jest.setTimeout(30_000);

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

describePostgresRace('PostgreSQL channel suggestion publication ledger races', () => {
  let pool: Pool;
  let chatId: string;
  let suggestionId: string;
  let ledgerJobId: string;

  const buildPublishingPayload = (claimToken: string) => ({
    type: 'suggest',
    reviewStatus: 'publishing',
    reviewAction: 'publish',
    reviewPublicationProtocol: 'max_action_ledger_v1',
    reviewPublicationLedgerJobId: ledgerJobId,
    reviewClaimToken: claimToken,
    reviewClaimedAt: '2026-08-20T10:00:00.000Z',
    reviewClaimedByUserId: 'admin-race',
  });

  const insertLedger = (
    client: PoolClient,
    ledgerId: string,
    metadata: Record<string, unknown> = { ledgerContext: null },
  ) =>
    client.query(
      `INSERT INTO max_action_ledger (
        id, job_id, action_type, chat_id, source_tag, metadata, updated_at
      ) VALUES (
        $1, $2, 'SEND_MESSAGE', $3, 'suggestion_delivery', $4::jsonb, CURRENT_TIMESTAMP
      )`,
      [ledgerId, ledgerJobId, chatId, JSON.stringify(metadata)],
    );

  beforeAll(async () => {
    assertDisposableDatabaseUrl(databaseUrl);
    pool = new Pool({
      connectionString: databaseUrl,
      max: 6,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 10_000,
    });
    const database = await pool.query<{ database_name: string; server_version: string }>(
      'SELECT current_database() AS database_name, version() AS server_version',
    );
    expect(database.rows[0]?.database_name).toContain('race_test');
    expect(database.rows[0]?.server_version).toMatch(/^PostgreSQL /u);
    const trigger = await pool.query<{ present: boolean }>(
      `SELECT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'max_action_ledger_channel_suggestion_publication_insert_guard'
          AND NOT tgisinternal
      ) AS present`,
    );
    expect(trigger.rows[0]?.present).toBe(true);
  });

  beforeEach(async () => {
    const suffix = randomUUID();
    chatId = `suggestion-race-chat-${suffix}`;
    suggestionId = `suggestion-race-${suffix}`;
    ledgerJobId = `channel-suggestion:publish:v1:${suggestionId}`;
    await pool.query(
      `INSERT INTO chats (
        id, title, entity_type, catalog_kind, routing_state, routing_version, updated_at
      ) VALUES ($1, 'Suggestion race', 'CHANNEL', 'MANAGED', 'READY', 0, CURRENT_TIMESTAMP)`,
      [chatId],
    );
    await pool.query(
      `INSERT INTO audit_logs (id, chat_id, actor_user_id, action, payload, created_at)
      VALUES (
        $1, $2, 'author-race', 'CHANNEL_DIALOG_SUGGESTION', $3::jsonb,
        CURRENT_TIMESTAMP - INTERVAL '1 day'
      )`,
      [suggestionId, chatId, JSON.stringify(buildPublishingPayload('claim-release-first'))],
    );
  });

  afterEach(async () => {
    await pool.query('DELETE FROM max_action_ledger WHERE job_id = $1', [ledgerJobId]);
    await pool.query('DELETE FROM audit_logs WHERE id = $1', [suggestionId]);
    await pool.query('DELETE FROM chats WHERE id = $1', [chatId]);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('rejects an insert started between the null ledger read and claim reset, then permits cancel', async () => {
    const releaseClient = await pool.connect();
    const insertClient = await pool.connect();
    let insert: Promise<unknown> | null = null;
    try {
      await releaseClient.query('BEGIN');
      await releaseClient.query(`SET LOCAL lock_timeout = '5s'`);
      await releaseClient.query('SELECT id FROM audit_logs WHERE id = $1 FOR UPDATE', [
        suggestionId,
      ]);
      const ledgerBeforeInsert = await releaseClient.query(
        'SELECT id FROM max_action_ledger WHERE job_id = $1',
        [ledgerJobId],
      );
      expect(ledgerBeforeInsert.rowCount).toBe(0);

      await insertClient.query('BEGIN');
      const backend = await insertClient.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      insert = insertLedger(insertClient, `ledger-release-first-${randomUUID()}`);
      await waitForBackendBlock(pool, backend.rows[0]!.pid);

      await releaseClient.query(
        `UPDATE audit_logs
        SET payload = (payload || jsonb_build_object('reviewStatus', 'pending'))
          - 'reviewAction'
          - 'reviewPublicationProtocol'
          - 'reviewPublicationLedgerJobId'
          - 'reviewClaimToken'
          - 'reviewClaimedAt'
          - 'reviewClaimedByUserId'
        WHERE id = $1`,
        [suggestionId],
      );
      await releaseClient.query('COMMIT');

      await expect(insert).rejects.toMatchObject({ code: '23514' });
      await rollbackQuietly(insertClient);
      const persistedLedger = await pool.query(
        'SELECT id FROM max_action_ledger WHERE job_id = $1',
        [ledgerJobId],
      );
      expect(persistedLedger.rowCount).toBe(0);

      const cancelled = await pool.query(
        `UPDATE audit_logs
        SET payload = payload || jsonb_build_object('reviewStatus', 'cancelled')
        WHERE id = $1 AND payload->>'reviewStatus' = 'pending'
        RETURNING id`,
        [suggestionId],
      );
      expect(cancelled.rowCount).toBe(1);
    } finally {
      await rollbackQuietly(releaseClient);
      await rollbackQuietly(insertClient);
      await insert?.catch(() => undefined);
      releaseClient.release();
      insertClient.release();
    }
  });

  it('lets an earlier insert finish, then deletes it under the release lock and permits republish', async () => {
    const insertClient = await pool.connect();
    const releaseClient = await pool.connect();
    let releaseLock: Promise<unknown> | null = null;
    try {
      await insertClient.query('BEGIN');
      await insertLedger(insertClient, `ledger-insert-first-${randomUUID()}`);

      await releaseClient.query('BEGIN');
      const backend = await releaseClient.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      releaseLock = releaseClient.query('SELECT id FROM audit_logs WHERE id = $1 FOR UPDATE', [
        suggestionId,
      ]);
      await waitForBackendBlock(pool, backend.rows[0]!.pid);

      await insertClient.query('COMMIT');
      await releaseLock;
      const ledgerAfterLock = await releaseClient.query(
        'SELECT id FROM max_action_ledger WHERE job_id = $1',
        [ledgerJobId],
      );
      expect(ledgerAfterLock.rowCount).toBe(1);
      await releaseClient.query('DELETE FROM max_action_ledger WHERE job_id = $1', [ledgerJobId]);
      await releaseClient.query(
        `UPDATE audit_logs
        SET payload = (payload || jsonb_build_object('reviewStatus', 'pending'))
          - 'reviewAction'
          - 'reviewPublicationProtocol'
          - 'reviewPublicationLedgerJobId'
          - 'reviewClaimToken'
          - 'reviewClaimedAt'
          - 'reviewClaimedByUserId'
        WHERE id = $1`,
        [suggestionId],
      );
      await releaseClient.query('COMMIT');

      const republishClaimToken = 'claim-republish';
      const claimed = await pool.query(
        `UPDATE audit_logs
        SET payload = payload || $2::jsonb
        WHERE id = $1 AND payload->>'reviewStatus' = 'pending'
        RETURNING id`,
        [suggestionId, JSON.stringify(buildPublishingPayload(republishClaimToken))],
      );
      expect(claimed.rowCount).toBe(1);
      await pool.query(
        `INSERT INTO max_action_ledger (
          id, job_id, action_type, chat_id, source_tag, metadata, updated_at
        ) VALUES (
          $1, $2, 'SEND_MESSAGE', $3, 'suggestion_delivery', $4::jsonb, CURRENT_TIMESTAMP
        )`,
        [
          `ledger-republish-${randomUUID()}`,
          ledgerJobId,
          chatId,
          JSON.stringify({
            ledgerContext: {
              suggestionId,
              publicationProtocol: 'max_action_ledger_v1',
              claimToken: republishClaimToken,
              actorUserId: 'author-race',
            },
          }),
        ],
      );
      const republished = await pool.query('SELECT id FROM max_action_ledger WHERE job_id = $1', [
        ledgerJobId,
      ]);
      expect(republished.rowCount).toBe(1);
    } finally {
      await rollbackQuietly(insertClient);
      await rollbackQuietly(releaseClient);
      await releaseLock?.catch(() => undefined);
      insertClient.release();
      releaseClient.release();
    }
  });

  it('allows a completed duplicate after publish but still rejects a new orphan insert', async () => {
    const completedLedgerId = `ledger-completed-duplicate-${randomUUID()}`;
    await pool.query(
      `INSERT INTO max_action_ledger (
        id, job_id, action_type, chat_id, source_tag, metadata, updated_at
      ) VALUES (
        $1, $2, 'SEND_MESSAGE', $3, 'suggestion_delivery', $4::jsonb, CURRENT_TIMESTAMP
      )`,
      [completedLedgerId, ledgerJobId, chatId, JSON.stringify({ ledgerContext: null })],
    );
    await pool.query(
      `UPDATE max_action_ledger
      SET status = 'SUCCEEDED',
        ambiguous = false,
        terminal = true,
        dispatch_token = 'dispatch-completed-duplicate',
        dispatch_started_at = CURRENT_TIMESTAMP,
        dispatch_bot_id = 'bot-completed-duplicate',
        remote_message_id = 'mid-completed-duplicate',
        completed_at = CURRENT_TIMESTAMP
      WHERE job_id = $1`,
      [ledgerJobId],
    );
    await pool.query(
      `UPDATE audit_logs
      SET payload = (payload || jsonb_build_object(
        'reviewStatus', 'published',
        'publishedMessageId', 'mid-completed-duplicate'
      ))
        - 'reviewAction'
        - 'reviewClaimToken'
        - 'reviewClaimedAt'
        - 'reviewClaimedByUserId'
      WHERE id = $1`,
      [suggestionId],
    );

    const duplicate = await pool.query(
      `INSERT INTO max_action_ledger (
        id, job_id, action_type, chat_id, source_tag, metadata, updated_at
      ) VALUES (
        $1, $2, 'SEND_MESSAGE', $3, 'suggestion_delivery', $4::jsonb, CURRENT_TIMESTAMP
      )
      ON CONFLICT (job_id) DO NOTHING
      RETURNING id`,
      [
        `ledger-duplicate-attempt-${randomUUID()}`,
        ledgerJobId,
        chatId,
        JSON.stringify({ ledgerContext: null }),
      ],
    );
    expect(duplicate.rowCount).toBe(0);

    await pool.query('DELETE FROM max_action_ledger WHERE job_id = $1', [ledgerJobId]);
    await expect(
      pool.query(
        `INSERT INTO max_action_ledger (
          id, job_id, action_type, chat_id, source_tag, metadata, updated_at
        ) VALUES (
          $1, $2, 'SEND_MESSAGE', $3, 'suggestion_delivery', $4::jsonb, CURRENT_TIMESTAMP
        )
        ON CONFLICT (job_id) DO NOTHING`,
        [
          `ledger-orphan-attempt-${randomUUID()}`,
          ledgerJobId,
          chatId,
          JSON.stringify({ ledgerContext: null }),
        ],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    const orphan = await pool.query('SELECT id FROM max_action_ledger WHERE job_id = $1', [
      ledgerJobId,
    ]);
    expect(orphan.rowCount).toBe(0);
  });
});
