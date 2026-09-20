import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

// Prisma's pinned development database supplies PostgreSQL without a Docker daemon.
const require = createRequire(import.meta.url);
const { PGlite } = createRequire(require.resolve('@prisma/dev'))('@electric-sql/pglite');
const migration = readFileSync(
  new URL(
    '../apps/api/prisma/migrations/20260920190000_add_message_retention/migration.sql',
    import.meta.url,
  ),
  'utf8',
);

test('message retention additive migration, quotas and indexed 20,000-chat schedule', async () => {
  const db = new PGlite();
  try {
    await db.exec(
      "CREATE TABLE moderation_delete_intents (id TEXT PRIMARY KEY); INSERT INTO moderation_delete_intents VALUES ('existing');",
    );
    await db.exec(migration);
    assert.deepEqual(
      (await db.query('SELECT retention_owned FROM moderation_delete_intents')).rows,
      [{ retention_owned: false }],
    );
    assert.equal(
      (await db.query('SELECT count(*)::int AS n FROM message_retention_quotas')).rows[0].n,
      32,
    );
    await db.exec(`INSERT INTO message_retention_policies (chat_id, activation_id, quota_shard, enabled, next_run_at)
      SELECT '-' || i, 'activation', i % 32, TRUE, CURRENT_TIMESTAMP + INTERVAL '2 days'
      FROM generate_series(1, 20000) i;
      UPDATE message_retention_policies SET next_run_at = CURRENT_TIMESTAMP - INTERVAL '1 minute' WHERE chat_id = '-100';
      ANALYZE message_retention_policies;`);
    const plan = await db.query(
      'EXPLAIN SELECT chat_id FROM message_retention_policies WHERE next_run_at <= CURRENT_TIMESTAMP ORDER BY next_run_at, chat_id LIMIT 100',
    );
    assert.match(JSON.stringify(plan.rows), /message_retention_policies_due_idx/u);
    assert.deepEqual(
      (
        await db.query(
          'SELECT chat_id FROM message_retention_policies WHERE next_run_at <= CURRENT_TIMESTAMP ORDER BY next_run_at, chat_id LIMIT 100',
        )
      ).rows,
      [{ chat_id: '-100' }],
    );
    await assert.rejects(
      db.exec("UPDATE message_retention_policies SET hours = 12 WHERE chat_id = '-100'"),
      { code: '23514' },
    );
    await assert.rejects(
      db.exec('UPDATE message_retention_quotas SET pending_count = 62501 WHERE shard = 0'),
      { code: '23514' },
    );
    await assert.rejects(
      db.exec("UPDATE message_retention_policies SET pending_count = -1 WHERE chat_id = '-100'"),
      { code: '23514' },
    );
    await db.query(
      `INSERT INTO message_retention_candidates (chat_id, message_id, author_id, origin_bot_id, source_at, activation_id)
      VALUES ($1, $2, $3, $4, $5, $6)`,
      ['-100', 'm1', 'u1', 'b1', new Date('2026-09-19T00:00:00Z'), 'activation'],
    );
    await db.query(
      `INSERT INTO message_retention_candidates (chat_id, message_id, author_id, origin_bot_id, source_at, activation_id)
      VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (chat_id, message_id) DO NOTHING`,
      ['-100', 'm1', 'u1', 'b2', new Date('2026-09-20T00:00:00Z'), 'activation'],
    );
    assert.equal(
      (await db.query('SELECT count(*)::int AS n FROM message_retention_candidates')).rows[0].n,
      1,
    );
    assert.equal(
      (await db.query('SELECT origin_bot_id FROM message_retention_candidates')).rows[0]
        .origin_bot_id,
      'b1',
    );
  } finally {
    await db.close();
  }
});
