import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import {
  describe,
  it,
  before as beforeAll,
  after as afterAll,
  beforeEach,
  afterEach,
} from 'node:test';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import type { PGlite as EmbeddedPostgres } from '@electric-sql/pglite';
import { purgeRetentionPage } from '../src/message-retention/message-retention-purge';
import { discoverRetentionReceipts } from '../src/message-retention/message-retention-recovery';
import { Prisma } from '../src/prisma/prisma-client';

const { PGlite } = createRequire(require.resolve('@prisma/dev'))(
  '@electric-sql/pglite',
) as typeof import('@electric-sql/pglite');
const migration = readFileSync(
  resolve(__dirname, '../prisma/migrations/20260920190000_add_message_retention/migration.sql'),
  'utf8',
);
const reconciliationMigration = readFileSync(
  resolve(
    __dirname,
    '../prisma/migrations/20261002020000_add_retention_reconciliation/migration.sql',
  ),
  'utf8',
);
const postgresUrl = process.env.MAXIM_TEST_POSTGRES_URL;
if (postgresUrl && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(postgresUrl).hostname))
  throw new Error('Retention SQL tests require a local disposable database');

describe('retention PostgreSQL statements', () => {
  let db: EmbeddedPostgres;
  let postgres: Client | null = null;
  const schema = `retention_test_${randomUUID().replaceAll('-', '')}`;
  const adapter = {
    $queryRaw: async (query: Prisma.Sql) => {
      return (
        await db.query(
          query.text,
          query.values.map((v) => (v instanceof Date ? v.toISOString() : v)),
        )
      ).rows;
    },
    $executeRaw: async (query: Prisma.Sql) => {
      return (
        await db.query(
          query.text,
          query.values.map((v) => (v instanceof Date ? v.toISOString() : v)),
        )
      ).affectedRows;
    },
  };
  beforeAll(async () => {
    if (postgresUrl) {
      postgres = new Client({
        connectionString: postgresUrl,
        statement_timeout: 5000,
        connectionTimeoutMillis: 3000,
      });
      await postgres.connect();
      await postgres.query(`CREATE SCHEMA "${schema}"; SET search_path TO "${schema}"`);
      db = {
        exec: async (sql: string) => {
          await postgres!.query(sql);
          return [];
        },
        query: async (sql: string, values: unknown[]) => {
          const result = await postgres!.query(sql, values);
          return { rows: result.rows, affectedRows: result.rowCount };
        },
        close: async () => {
          await postgres!.query(`DROP SCHEMA "${schema}" CASCADE`);
          await postgres!.end();
        },
      } as unknown as EmbeddedPostgres;
    } else db = new PGlite();
    await db.exec("SET TIME ZONE 'UTC'");
    await db.exec(`
      CREATE TABLE chats (id TEXT PRIMARY KEY, entity_type TEXT NOT NULL DEFAULT 'CHAT');
      CREATE TABLE managed_entity_admin_members (chat_id TEXT, user_id TEXT, entity_type TEXT, role TEXT, expires_at TIMESTAMP(3));
      CREATE INDEX admin_lookup ON managed_entity_admin_members(chat_id, user_id);
      CREATE TABLE audit_logs (id TEXT PRIMARY KEY, chat_id TEXT REFERENCES chats(id), actor_user_id TEXT, action TEXT, payload JSONB, created_at TIMESTAMP(3));
      CREATE TABLE moderation_delete_intents (id TEXT PRIMARY KEY, chat_id TEXT, message_id TEXT, status TEXT DEFAULT 'PENDING',
        delete_dispatch_started_at TIMESTAMP(3), delete_dispatch_started_bot_id TEXT,
        remote_delete_succeeded_at TIMESTAMP(3), remote_delete_succeeded_bot_id TEXT, lease_expires_at TIMESTAMP(3));
    `);
    await db.exec(migration);
    await db.exec(reconciliationMigration);
  });
  beforeEach(async () => {
    await db.exec(`BEGIN; INSERT INTO chats(id) VALUES ('-1');
      INSERT INTO message_retention_policies(chat_id, activation_id, quota_shard, enabled, capture_after)
      VALUES ('-1', 'activation', 0, TRUE, CURRENT_TIMESTAMP - INTERVAL '1 hour');`);
  });
  afterEach(async () => {
    await db.exec(`ROLLBACK;
    TRUNCATE message_retention_candidates, message_retention_policies, managed_entity_admin_members, audit_logs, moderation_delete_intents, chats CASCADE;
    UPDATE message_retention_quotas SET pending_count=0, paused_at=NULL, healthy_since=NULL;`);
  });
  afterAll(async () => {
    await db.close();
  });

  async function snapshot() {
    return (
      await db.query<{
        pending_count: number;
        skipped_count: number;
        quota_count: number;
        candidates: number;
      }>(`
      SELECT p.pending_count, p.skipped_count, q.pending_count AS quota_count,
        (SELECT COUNT(*)::int FROM message_retention_candidates) AS candidates
      FROM message_retention_policies p JOIN message_retention_quotas q ON q.shard=p.quota_shard WHERE p.chat_id='-1'`)
    ).rows[0]!;
  }
  async function receipt(
    id: string,
    status: string,
    owned: boolean,
    marker: boolean,
    live: boolean,
  ) {
    await db.query(
      `INSERT INTO moderation_delete_intents(id,chat_id,message_id,status,retention_owned,delete_dispatch_started_at,lease_expires_at)
      VALUES ($1,'-1',$1,$2,$3,$4,$5)`,
      [
        id,
        status,
        owned,
        marker ? new Date().toISOString() : null,
        live ? new Date(Date.now() + 60_000).toISOString() : null,
      ],
    );
    await db.query(
      `INSERT INTO message_retention_candidates(chat_id,message_id,author_id,origin_bot_id,source_at,activation_id,status,completed_at,intent_id,outcome_code)
      VALUES ('-1',$1,'u1','bot1',CURRENT_TIMESTAMP - INTERVAL '10 days','activation',$2,CURRENT_TIMESTAMP - INTERVAL '8 days',$1,$3)`,
      [
        id,
        status === 'SUCCEEDED' ? 'deleted' : 'cancelled',
        status === 'SUCCEEDED' ? 'deleted' : 'cancelled',
      ],
    );
  }
  it('retains ambiguous candidates with their intents, without deleting ordinary moderation', async () => {
    await receipt('success', 'SUCCEEDED', true, true, false);
    await receipt('unknown', 'AMBIGUOUS', true, true, false);
    await receipt('live', 'IN_PROGRESS', true, false, true);
    await receipt('ordinary', 'PENDING', false, false, false);
    await receipt('unattempted', 'PENDING', true, false, false);
    await purgeRetentionPage(adapter as never, null);
    assert.deepEqual(
      (await db.query('SELECT message_id FROM message_retention_candidates ORDER BY message_id'))
        .rows,
      [{ message_id: 'live' }, { message_id: 'unknown' }],
    );
    assert.deepEqual(
      (await db.query('SELECT id FROM moderation_delete_intents ORDER BY id')).rows,
      [{ id: 'live' }, { id: 'ordinary' }, { id: 'unknown' }],
    );
  });
  it('moves the cleanup cursor past a full page of unresolved receipts', async () => {
    await db.exec(`INSERT INTO moderation_delete_intents(id,chat_id,message_id,retention_owned,status,delete_dispatch_started_at)
      SELECT 'a'||lpad(i::text,4,'0'),'-1','a'||lpad(i::text,4,'0'),TRUE,'AMBIGUOUS',CURRENT_TIMESTAMP FROM generate_series(1,500) i;
      INSERT INTO message_retention_candidates(chat_id,message_id,author_id,origin_bot_id,source_at,activation_id,status,completed_at,intent_id)
      SELECT '-1',id,'u1','bot1',CURRENT_TIMESTAMP - INTERVAL '10 days','activation','cancelled',CURRENT_TIMESTAMP - INTERVAL '8 days',id FROM moderation_delete_intents;`);
    await receipt('z-success', 'SUCCEEDED', true, true, false);
    const cursor = await purgeRetentionPage(adapter as never, null);
    assert.equal(cursor?.messageId, 'a0500');
    await purgeRetentionPage(adapter as never, cursor);
    assert.deepEqual(
      (await db.query("SELECT id FROM moderation_delete_intents WHERE id='z-success'")).rows,
      [],
    );
    assert.deepEqual(
      (await db.query('SELECT count(*)::int AS n FROM message_retention_candidates')).rows[0],
      { n: 500 },
    );
  });

  it('discovers ended legacy receipts in bounded pages and wakes their policy without charging quota', async () => {
    await receipt('legacy-ambiguous', 'AMBIGUOUS', true, true, false);
    await receipt('legacy-success', 'SUCCEEDED', true, true, false);
    await db.exec(`UPDATE message_retention_candidates SET outcome_code=NULL,status='cancelled';
      UPDATE message_retention_policies SET enabled=FALSE,next_run_at=NULL;`);
    const cursor = await discoverRetentionReceipts(adapter as never, null, new Date());
    assert.ok(cursor);
    assert.deepEqual(
      (
        await db.query(
          'SELECT outcome_code,reconcile_after IS NOT NULL AS scheduled FROM message_retention_candidates ORDER BY message_id',
        )
      ).rows,
      [
        { outcome_code: 'reconciliation', scheduled: true },
        { outcome_code: 'reconciliation', scheduled: true },
      ],
    );
    assert.deepEqual(
      (
        await db.query(
          'SELECT next_run_at IS NOT NULL AS scheduled,pending_count FROM message_retention_policies',
        )
      ).rows,
      [{ scheduled: true, pending_count: 0 }],
    );
    assert.equal((await snapshot()).quota_count, 0);
    await purgeRetentionPage(adapter as never, null);
    assert.equal(
      (await snapshot()).candidates,
      2,
      'GC must wait for receipt reconciliation, including known success',
    );
  });

  it('preserves a legacy cancelled success until the bounded discovery pass reaches it', async () => {
    await receipt('legacy-success', 'SUCCEEDED', true, true, false);
    await db.exec("UPDATE message_retention_candidates SET status='cancelled',outcome_code=NULL");
    await purgeRetentionPage(adapter as never, null);
    assert.equal((await snapshot()).candidates, 1);
    assert.equal(
      (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM moderation_delete_intents'))
        .rows[0]!.n,
      1,
    );
  });
});
