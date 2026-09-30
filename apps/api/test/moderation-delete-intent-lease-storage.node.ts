import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { PGlite as EmbeddedPostgres } from '@electric-sql/pglite';
import { Client } from 'pg';
import { checkOrRenewDeleteIntentLease } from '../src/moderation/moderation-delete-intent-lease';
import type { Prisma } from '../src/prisma/prisma-client';

const { PGlite } = createRequire(require.resolve('@prisma/dev'))(
  '@electric-sql/pglite',
) as typeof import('@electric-sql/pglite');
const url = process.env.MAXIM_TEST_POSTGRES_URL;
if (
  url &&
  (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname) ||
    !new URL(url).pathname.includes('race_test'))
)
  throw new Error('Lease SQL tests require a local disposable race_test database');

describe('delete-intent lease PostgreSQL fences and physical no-op checks', () => {
  let db: EmbeddedPostgres;
  let client: Client | null = null;
  const schema = `lease_test_${randomUUID().replaceAll('-', '')}`;
  const adapter = {
    $queryRaw: async <T>(query: Prisma.Sql): Promise<T> =>
      (await db.query(query.text, query.values)).rows as T,
  };
  const input = { intentId: 'intent', leaseToken: 'owner', leaseMs: 60_000, minimumRemainingMs: 0 };
  const check = async (extra = {}) => {
    const result = await checkOrRenewDeleteIntentLease(adapter, { ...input, ...extra });
    return { owned: result.owned, renewed: result.renewed };
  };
  const row = async () =>
    (
      await db.query<{ identity: string; expiry: string }>(
        'SELECT xmin::text || ctid::text AS identity, lease_expires_at::text AS expiry FROM moderation_delete_intents',
      )
    ).rows[0];

  before(async () => {
    if (url) {
      client = new Client({
        connectionString: url,
        statement_timeout: 5_000,
        connectionTimeoutMillis: 3_000,
      });
      await client.connect();
      await client.query(`CREATE SCHEMA "${schema}"; SET search_path TO "${schema}"`);
      db = {
        exec: async (sql: string) => {
          await client!.query(sql);
          return [];
        },
        query: async (sql: string, values?: unknown[]) => {
          const result = await client!.query(sql, values);
          return { rows: result.rows, affectedRows: result.rowCount };
        },
        close: async () => {
          await client!.query(`DROP SCHEMA "${schema}" CASCADE`);
          await client!.end();
        },
      } as unknown as EmbeddedPostgres;
    } else db = new PGlite();
    await db.exec(`
      CREATE TYPE "ModerationDeleteIntentStatus" AS ENUM ('IN_PROGRESS', 'PENDING');
      CREATE TABLE moderation_delete_intents (
        id TEXT PRIMARY KEY, status "ModerationDeleteIntentStatus" NOT NULL,
        lease_token TEXT, lease_expires_at TIMESTAMP(3)
      );
    `);
  });
  beforeEach(async () => {
    await db.exec(`TRUNCATE moderation_delete_intents;
      INSERT INTO moderation_delete_intents VALUES ('intent', 'IN_PROGRESS', 'owner',
        (clock_timestamp() AT TIME ZONE 'UTC') + INTERVAL '60 seconds');`);
  });
  after(async () => {
    await db?.close();
  });

  it('checks a healthy lease 100 times without changing its tuple or deadline', async () => {
    const before = await row();
    for (let n = 0; n < 100; n++) assert.deepEqual(await check(), { owned: true, renewed: false });
    assert.deepEqual(await row(), before);
  });
  it('renews a short valid lease once and subsequent checks remain physical reads', async () => {
    await db.exec(
      "UPDATE moderation_delete_intents SET lease_expires_at = (clock_timestamp() AT TIME ZONE 'UTC') + INTERVAL '10 seconds'",
    );
    const old = await row();
    assert.deepEqual(await check(), { owned: true, renewed: true });
    const renewed = await row();
    assert.notEqual(renewed.identity, old.identity);
    assert.notEqual(renewed.expiry, old.expiry);
    for (let n = 0; n < 10; n++) assert.deepEqual(await check(), { owned: true, renewed: false });
    assert.deepEqual(await row(), renewed);
  });
  for (const invalid of ['expired', 'stolen', 'terminal', 'missing'])
    it(`does not authorize or renew a ${invalid} lease`, async () => {
      if (invalid === 'expired')
        await db.exec(
          "UPDATE moderation_delete_intents SET lease_expires_at = (clock_timestamp() AT TIME ZONE 'UTC') - INTERVAL '1 millisecond'",
        );
      if (invalid === 'stolen')
        await db.exec("UPDATE moderation_delete_intents SET lease_token = 'new-owner'");
      if (invalid === 'terminal')
        await db.exec("UPDATE moderation_delete_intents SET status = 'PENDING'");
      if (invalid === 'missing') await db.exec('DELETE FROM moderation_delete_intents');
      const before = await row();
      assert.deepEqual(await check(), { owned: false, renewed: false });
      assert.deepEqual(await row(), before);
    });
  it('budgets a long dispatch even when it exceeds the nominal heartbeat duration', async () => {
    assert.deepEqual(await check({ minimumRemainingMs: 120_000 }), { owned: true, renewed: true });
    const remaining = (
      await db.query<{ ms: number }>(
        "SELECT EXTRACT(EPOCH FROM (lease_expires_at - (clock_timestamp() AT TIME ZONE 'UTC'))) * 1000 AS ms FROM moderation_delete_intents",
      )
    ).rows[0].ms;
    assert.ok(Number(remaining) > 120_000);
    const before = await row();
    assert.deepEqual(await check(), { owned: true, renewed: false });
    assert.deepEqual(await row(), before);
  });
  it('uses the server wall clock when an existing transaction has an old start time', async () => {
    await db.exec(
      "BEGIN; UPDATE moderation_delete_intents SET lease_expires_at = (clock_timestamp() AT TIME ZONE 'UTC') - INTERVAL '1 millisecond'",
    );
    try {
      assert.deepEqual(await check(), { owned: false, renewed: false });
    } finally {
      await db.exec('ROLLBACK');
    }
  });
  for (const forcedHashJoin of [false, true])
    it(
      `never revives a lease that expires behind an unchanged row lock (hash join: ${forcedHashJoin})`,
      { skip: !url },
      async () => {
        const locker = new Client({ connectionString: url, statement_timeout: 5_000 });
        await locker.connect();
        await locker.query(`SET search_path TO "${schema}"; BEGIN`);
        try {
          if (forcedHashJoin)
            await db.exec('SET enable_nestloop = off; SET enable_mergejoin = off');
          await db.exec(
            "UPDATE moderation_delete_intents SET lease_expires_at = (clock_timestamp() AT TIME ZONE 'UTC') + INTERVAL '300 milliseconds'",
          );
          const before = await row();
          await locker.query(
            "SELECT id FROM moderation_delete_intents WHERE id = 'intent' FOR UPDATE",
          );
          const pending = check({ leaseMs: 1_000 });
          await new Promise((resolve) => setTimeout(resolve, 600));
          await locker.query('COMMIT');
          assert.deepEqual(await pending, { owned: false, renewed: false });
          assert.deepEqual(await row(), before);
        } finally {
          await locker.query('ROLLBACK');
          await locker.end();
          await db.exec('RESET enable_nestloop; RESET enable_mergejoin');
        }
      },
    );
  it('rejects an ownership response whose remaining budget was consumed in transit', async () => {
    const delayed = {
      $queryRaw: async <T>(): Promise<T> => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return [{ renewed: false, remainingMs: 5 }] as T;
      },
    };
    assert.deepEqual(await checkOrRenewDeleteIntentLease(delayed, input), {
      owned: false,
      renewed: false,
      remainingBudgetMs: 0,
      proofUntilMonotonicMs: 0,
    });
  });
});
