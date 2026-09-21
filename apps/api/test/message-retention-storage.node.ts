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
import { captureRetentionMessage } from '../src/message-retention/message-retention-capture';
import { purgeRetentionPage } from '../src/message-retention/message-retention-purge';
import { Prisma } from '../src/prisma/prisma-client';

const { PGlite } = createRequire(require.resolve('@prisma/dev'))(
  '@electric-sql/pglite',
) as typeof import('@electric-sql/pglite');
const migration = readFileSync(
  resolve(__dirname, '../prisma/migrations/20260920190000_add_message_retention/migration.sql'),
  'utf8',
);
const postgresUrl = process.env.MAXIM_TEST_POSTGRES_URL;
if (postgresUrl && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(postgresUrl).hostname))
  throw new Error('Retention SQL tests require a local disposable database');

describe('retention PostgreSQL statements', () => {
  let db: EmbeddedPostgres;
  let calls: number;
  let postgres: Client | null = null;
  const schema = `retention_test_${randomUUID().replaceAll('-', '')}`;
  const input = () => ({
    chatId: '-1',
    messageId: 'm1',
    authorId: 'u1',
    originBotId: 'bot1',
    sourceAt: new Date(),
  });
  const adapter = {
    $queryRaw: async (query: Prisma.Sql) => {
      calls++;
      return (
        await db.query(
          query.text,
          query.values.map((v) => (v instanceof Date ? v.toISOString() : v)),
        )
      ).rows;
    },
    $executeRaw: async (query: Prisma.Sql) => {
      calls++;
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
  });
  beforeEach(async () => {
    calls = 0;
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
  it('admits in three statements and does not charge mirrored/replayed receipts twice', async () => {
    const message = input();
    await captureRetentionMessage(adapter as never, message, false);
    assert.equal(
      calls,
      3,
      JSON.stringify({
        source: message.sourceAt,
        clock: (
          await db.query(
            'SELECT CURRENT_TIMESTAMP::text AS now, capture_after::text FROM message_retention_policies',
          )
        ).rows,
      }),
    );
    assert.deepEqual(await snapshot(), {
      pending_count: 1,
      quota_count: 1,
      skipped_count: 0,
      candidates: 1,
    });
    calls = 0;
    await captureRetentionMessage(adapter as never, { ...message, originBotId: 'bot2' }, false);
    assert.equal(calls, 1);
    assert.deepEqual(await snapshot(), {
      pending_count: 1,
      quota_count: 1,
      skipped_count: 0,
      candidates: 1,
    });
  });
  it('rolls back admission and both quota changes together', async () => {
    await db.exec('SAVEPOINT before_capture');
    await captureRetentionMessage(adapter as never, input(), false);
    await db.exec('ROLLBACK TO SAVEPOINT before_capture');
    assert.deepEqual(await snapshot(), {
      pending_count: 0,
      quota_count: 0,
      skipped_count: 0,
      candidates: 0,
    });
  });
  it(
    'does not double-charge receipts that wait behind another PostgreSQL transaction',
    { skip: !postgresUrl },
    async () => {
      await db.exec('COMMIT');
      const first = new Client({ connectionString: postgresUrl, statement_timeout: 5000 });
      const second = new Client({ connectionString: postgresUrl, statement_timeout: 5000 });
      await first.connect();
      await second.connect();
      try {
        for (const connection of [first, second])
          await connection.query(`SET search_path TO "${schema}"; SET TIME ZONE 'UTC'; BEGIN`);
        const parameters = (query: Prisma.Sql) =>
          query.values.map((v) => (v instanceof Date ? v.toISOString() : v));
        const wrap = (connection: Client, observe = () => {}) => ({
          $queryRaw: async (query: Prisma.Sql) => {
            observe();
            return (await connection.query(query.text, parameters(query))).rows;
          },
          $executeRaw: async (query: Prisma.Sql) =>
            (await connection.query(query.text, parameters(query))).rowCount,
        });
        const message = input();
        await captureRetentionMessage(wrap(first) as never, message, false);
        let secondQuery = 0;
        let enteredLock!: () => void;
        const waiting = new Promise<void>((resolve) => {
          enteredLock = resolve;
        });
        const mirrored = captureRetentionMessage(
          wrap(second, () => {
            if (++secondQuery === 2) enteredLock();
          }) as never,
          message,
          false,
        );
        await waiting;
        await first.query('COMMIT');
        await mirrored;
        await second.query('COMMIT');
        assert.deepEqual(await snapshot(), {
          pending_count: 1,
          quota_count: 1,
          skipped_count: 0,
          candidates: 1,
        });
      } finally {
        await first.end();
        await second.end();
      }
    },
  );
  for (const reason of ['disabled', 'old', 'administrator', 'missing-chat'])
    it(`does not lock quotas for ${reason}`, async () => {
      const message = input();
      if (reason === 'disabled')
        await db.exec('UPDATE message_retention_policies SET enabled=FALSE');
      if (reason === 'old') message.sourceAt = new Date(0);
      if (reason === 'administrator')
        await db.exec(
          "INSERT INTO managed_entity_admin_members VALUES ('-1','u1','CHAT','ADMIN',CURRENT_TIMESTAMP + INTERVAL '1 hour')",
        );
      if (reason === 'missing-chat') await db.exec("DELETE FROM chats WHERE id='-1'");
      await captureRetentionMessage(adapter as never, message, false);
      assert.equal(calls, 1);
      assert.equal((await snapshot()).candidates, 0);
    });
  it('preserves the pause recovery clock and records only the first pause', async () => {
    await db.exec('UPDATE message_retention_quotas SET pending_count=50000 WHERE shard=0');
    assert.equal(await captureRetentionMessage(adapter as never, input(), false), true);
    await db.exec("UPDATE message_retention_policies SET healthy_since=TIMESTAMP '2026-09-01'");
    assert.equal(
      await captureRetentionMessage(adapter as never, { ...input(), messageId: 'm2' }, false),
      false,
    );
    assert.equal((await snapshot()).skipped_count, 2);
    assert.equal((await snapshot()).candidates, 0);
    assert.deepEqual((await db.query('SELECT count(*)::int AS n FROM audit_logs')).rows[0], {
      n: 1,
    });
    assert.deepEqual(
      (
        await db.query<{ healthy_since: Date }>(
          'SELECT healthy_since FROM message_retention_policies',
        )
      ).rows[0]!.healthy_since,
      new Date('2026-09-01Z'),
    );
  });
  it('marks shadow captures permanently non-executable', async () => {
    await captureRetentionMessage(adapter as never, input(), true);
    assert.deepEqual(
      (await db.query('SELECT shadow_only FROM message_retention_candidates')).rows[0],
      { shadow_only: true },
    );
  });

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
      `INSERT INTO message_retention_candidates(chat_id,message_id,author_id,origin_bot_id,source_at,activation_id,status,completed_at,intent_id)
      VALUES ('-1',$1,'u1','bot1',CURRENT_TIMESTAMP - INTERVAL '10 days','activation','cancelled',CURRENT_TIMESTAMP - INTERVAL '8 days',$1)`,
      [id],
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
});
