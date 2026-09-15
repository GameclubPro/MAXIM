import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
try {
  await db.exec(`
    CREATE TABLE vk_parsing_sources (id text PRIMARY KEY);
    CREATE TABLE vk_parsing_settings (id text PRIMARY KEY);
    CREATE TABLE vk_parsing_posts (id text PRIMARY KEY);
    INSERT INTO vk_parsing_posts VALUES ('post-1'), ('post-2');
  `);
  await db.exec(readFileSync(process.argv[2], 'utf8'));
  await db.query(
    `INSERT INTO vk_bot_reviews (id, post_id, recipient_user_id, updated_at) VALUES ('review-1', 'post-1', '17', now())`,
  );
  await assert.rejects(
    db.query(
      `INSERT INTO vk_bot_reviews (id, post_id, recipient_user_id, updated_at) VALUES ('review-2', 'post-1', '17', now())`,
    ),
    /unique/u,
  );
  await db.query(
    `INSERT INTO vk_bot_reviews (id, post_id, recipient_user_id, updated_at) VALUES ('review-2', 'post-2', '17', now())`,
  );
  const first = await db.query(
    `UPDATE vk_bot_reviews SET status = 'REJECTED' WHERE id = 'review-1' AND status = 'PENDING' AND revision = 1 RETURNING id`,
  );
  const second = await db.query(
    `UPDATE vk_bot_reviews SET status = 'APPROVED' WHERE id = 'review-1' AND status = 'PENDING' AND revision = 1 RETURNING id`,
  );
  assert.equal(first.rows.length, 1);
  assert.equal(second.rows.length, 0);
  const independent = await db.query(`SELECT status FROM vk_bot_reviews WHERE id = 'review-2'`);
  assert.equal(independent.rows[0].status, 'PENDING');
  await assert.rejects(
    db.query(`UPDATE vk_bot_reviews SET delivery_state = 'UNKNOWN' WHERE id = 'review-2'`),
    /check/u,
  );
  await assert.rejects(
    db.query(`INSERT INTO vk_bot_review_inboxes VALUES ('publik_bot', '17', '-1', now())`),
    /check/u,
  );
  await db.query(`INSERT INTO vk_bot_review_inboxes VALUES ('publik_bot', '17', '42', now())`);
  await db.query(`INSERT INTO vk_bot_review_inboxes VALUES ('other_bot', '17', '99', now())`);
  const inboxes = await db.query(`SELECT count(*)::int AS count FROM vk_bot_review_inboxes`);
  assert.equal(inboxes.rows[0].count, 2);
  await db.exec('SET enable_seqscan = off');
  const plan = await db.query(
    `EXPLAIN SELECT id FROM vk_bot_reviews WHERE delivery_state = 'QUEUED' AND next_attempt_at <= now() ORDER BY next_attempt_at, id LIMIT 10`,
  );
  assert.match(JSON.stringify(plan.rows), /vk_bot_reviews_due_idx/u);
  console.log(JSON.stringify({ ok: true }));
} finally {
  await db.close();
}
