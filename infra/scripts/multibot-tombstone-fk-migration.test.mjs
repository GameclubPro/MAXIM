import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const migration = readFileSync(
  resolve(
    root,
    'apps/api/prisma/migrations/20261005020200_preserve_semantic_execution_tombstones/migration.sql',
  ),
  'utf8',
);
const nativePostgresUrl = process.env.MAXIM_TEST_POSTGRES_URL?.trim();

test('tombstone migration inherits exact validated reference proof without a history rescan', () => {
  assert.match(migration, /LOCK TABLE "webhook_execution_claims" IN ACCESS EXCLUSIVE MODE/u);
  assert.match(migration, /LOCK TABLE "webhook_events" IN SHARE ROW EXCLUSIVE MODE/u);
  assert.ok(migration.indexOf('original.convalidated') < migration.indexOf('DROP NOT NULL'));
  assert.match(migration, /original\.conkey = ARRAY/u);
  assert.match(migration, /original\.confkey = ARRAY/u);
  assert.match(migration, /ON DELETE SET NULL ON UPDATE CASCADE NOT VALID/u);
  assert.doesNotMatch(migration, /VALIDATE CONSTRAINT|UPDATE\s+pg_constraint/iu);
});

test(
  'native tombstone FK preserves authority, rejects new orphans and rejects unproven old constraints',
  { skip: !nativePostgresUrl, timeout: 30_000 },
  async () => {
    const address = new URL(nativePostgresUrl);
    assert.ok(
      ['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname) &&
        address.pathname.includes('race_test'),
      'Requires the disposable local PostgreSQL race_test database',
    );
    const { default: pg } = await import('pg');
    const client = new pg.Client({
      connectionString: nativePostgresUrl,
      connectionTimeoutMillis: 5_000,
      query_timeout: 10_000,
      options: '-c statement_timeout=10000 -c lock_timeout=3000 -c timezone=UTC',
    });
    const schemas = [];
    let connected = false;
    try {
      await client.connect();
      connected = true;
      for (const variant of ['valid', 'unvalidated', 'wrong-action', 'wrong-reference']) {
        const schemaName = `multibot_fk_${randomUUID().replaceAll('-', '')}`;
        schemas.push(schemaName);
        const schema = `"${schemaName}"`;
        await client.query(`CREATE SCHEMA ${schema}`);
        await client.query(`SET search_path TO ${schema}`);
        await client.query(`
          CREATE TABLE webhook_events (id text PRIMARY KEY, other_id text UNIQUE);
          CREATE TABLE webhook_execution_claims (id text PRIMARY KEY, webhook_event_id text NOT NULL);
          INSERT INTO webhook_events VALUES ('receipt', 'receipt');
          INSERT INTO webhook_execution_claims VALUES ('authority', 'receipt');
          ALTER TABLE webhook_execution_claims
          ADD CONSTRAINT webhook_execution_claims_webhook_event_id_fkey
          FOREIGN KEY (webhook_event_id) REFERENCES webhook_events(${variant === 'wrong-reference' ? 'other_id' : 'id'})
          ON DELETE ${variant === 'wrong-action' ? 'RESTRICT' : 'CASCADE'} ON UPDATE CASCADE
          ${variant === 'unvalidated' ? 'NOT VALID' : ''}
        `);
        if (variant !== 'valid') {
          await assert.rejects(
            client.query(migration),
            /exact validated original webhook foreign key/u,
          );
          await client.query('ROLLBACK');
          const nullable = await client.query(
            `SELECT attnotnull FROM pg_attribute
             WHERE attrelid = 'webhook_execution_claims'::regclass AND attname = 'webhook_event_id'`,
          );
          assert.equal(
            nullable.rows[0].attnotnull,
            true,
            `${variant} must leave the old schema intact`,
          );
          continue;
        }
        await client.query(migration);
        const constraint = await client.query(
          `SELECT convalidated, confdeltype, confupdtype FROM pg_constraint
           WHERE conrelid = 'webhook_execution_claims'::regclass
             AND conname = 'webhook_execution_claims_webhook_event_id_fkey'`,
        );
        assert.deepEqual(constraint.rows, [
          { convalidated: false, confdeltype: 'n', confupdtype: 'c' },
        ]);
        await assert.rejects(
          client.query("INSERT INTO webhook_execution_claims VALUES ('orphan', 'missing')"),
          (error) => error.code === '23503',
        );
        await client.query("DELETE FROM webhook_events WHERE id = 'receipt'");
        const tombstone = await client.query(
          'SELECT id, webhook_event_id FROM webhook_execution_claims',
        );
        assert.deepEqual(tombstone.rows, [{ id: 'authority', webhook_event_id: null }]);
      }
    } finally {
      try {
        if (connected) {
          await client.query('ROLLBACK');
          await client.query('SET search_path TO public');
          for (const schemaName of schemas)
            await client.query(`DROP SCHEMA "${schemaName}" CASCADE`);
        }
      } finally {
        await client.end();
      }
    }
  },
);
