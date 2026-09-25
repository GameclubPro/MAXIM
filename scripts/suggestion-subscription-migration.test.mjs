import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { PGlite } = createRequire(require.resolve('@prisma/dev'))('@electric-sql/pglite');
const migration = readFileSync(
  new URL(
    '../apps/api/prisma/migrations/20260925120000_add_suggestion_subscription/migration.sql',
    import.meta.url,
  ),
  'utf8',
);

test('suggestion migration preserves old settings and uses indexes at 20,000-author scale', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE channel_settings (chat_id TEXT PRIMARY KEY);
      CREATE TABLE publisher_entity_settings (chat_id TEXT PRIMARY KEY);
      CREATE TABLE managed_broadcast_deliveries (id TEXT PRIMARY KEY);
      CREATE TABLE moderation_delete_intents (id TEXT PRIMARY KEY);
      INSERT INTO channel_settings VALUES ('old');
      INSERT INTO publisher_entity_settings VALUES ('old');
      INSERT INTO managed_broadcast_deliveries VALUES ('old');
      INSERT INTO moderation_delete_intents VALUES ('old');
    `);
    await db.exec(migration);
    assert.deepEqual(
      (
        await db.query(
          'SELECT post_suggestions_require_subscription, post_suggestions_delete_on_unsubscribe FROM channel_settings',
        )
      ).rows,
      [
        {
          post_suggestions_require_subscription: false,
          post_suggestions_delete_on_unsubscribe: false,
        },
      ],
    );
    assert.deepEqual(
      (
        await db.query(
          'SELECT channel_suggestions_require_subscription, channel_suggestions_delete_on_unsubscribe FROM publisher_entity_settings',
        )
      ).rows,
      [
        {
          channel_suggestions_require_subscription: false,
          channel_suggestions_delete_on_unsubscribe: false,
        },
      ],
    );
    assert.equal(
      (await db.query('SELECT suggestion_subscription_id FROM moderation_delete_intents')).rows[0]
        .suggestion_subscription_id,
      null,
    );
    await db.exec(`
      INSERT INTO suggestion_subscription_watches (id, chat_id, author_user_id, profile, bot_id, next_check_at)
      SELECT 'watch-' || i, '-channel-' || i, 'author-' || i, CASE WHEN i % 2 = 0 THEN 'moderation' ELSE 'publisher' END,
        'bot', CURRENT_TIMESTAMP + INTERVAL '6 hours' FROM generate_series(1, 20000) i;
      UPDATE suggestion_subscription_watches SET next_check_at = CURRENT_TIMESTAMP - INTERVAL '1 minute' WHERE id = 'watch-2';
      INSERT INTO suggestion_subscription_publications (id, watch_id, message_id)
      SELECT 'post-' || i, 'watch-' || i, 'mid-' || i FROM generate_series(1, 20000) i;
      ANALYZE suggestion_subscription_watches;
      ANALYZE suggestion_subscription_publications;
    `);
    const due =
      await db.query(`EXPLAIN SELECT * FROM suggestion_subscription_watches WHERE profile = 'moderation'
      AND next_check_at <= CURRENT_TIMESTAMP ORDER BY next_check_at, id LIMIT 25`);
    assert.match(JSON.stringify(due.rows), /suggestion_subscription_watch_due_idx/u);
    const author = await db.query(
      `EXPLAIN SELECT id FROM suggestion_subscription_watches WHERE chat_id = '-channel-2' AND author_user_id = 'author-2'`,
    );
    assert.match(JSON.stringify(author.rows), /suggestion_subscription_watch_owner_key/u);
    const posts = await db.query(
      `EXPLAIN SELECT id FROM suggestion_subscription_publications WHERE watch_id = 'watch-2' AND deleted_at IS NULL AND id > 'post-1' ORDER BY id LIMIT 10`,
    );
    assert.match(JSON.stringify(posts.rows), /suggestion_subscription_publications_watch_idx/u);
    await db.exec(
      `UPDATE suggestion_subscription_watches SET revision = revision + 1, checked_at = NULL, missing_since = NULL WHERE id = 'watch-2'`,
    );
    const stale = await db.query(
      `UPDATE suggestion_subscription_watches SET missing_since = CURRENT_TIMESTAMP WHERE id = 'watch-2' AND revision = 0 RETURNING id`,
    );
    assert.equal(stale.rows.length, 0);
    await assert.rejects(
      db.exec(
        `INSERT INTO suggestion_subscription_watches (id, chat_id, author_user_id, profile, bot_id) VALUES ('duplicate', '-channel-2', 'author-2', 'moderation', 'bot')`,
      ),
      { code: '23505' },
    );
  } finally {
    await db.close();
  }
});
