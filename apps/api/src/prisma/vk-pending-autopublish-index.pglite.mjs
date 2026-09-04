import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const [migrationPath] = process.argv.slice(2);
if (!migrationPath) {
  throw new Error('The pending VK autopublish index migration path is required');
}

const db = new PGlite();
try {
  await db.exec(`
    CREATE TABLE "vk_parsing_posts" (
      "id" TEXT PRIMARY KEY,
      "source_id" TEXT NOT NULL,
      "status" TEXT NOT NULL DEFAULT 'NEW',
      "vk_published_at" TIMESTAMP(3),
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "publish_schedule_fingerprint" TEXT,
      "publish_queued_at" TIMESTAMP(3),
      "publish_scheduled_at" TIMESTAMP(3),
      "publish_locked_at" TIMESTAMP(3),
      "publish_attempt_count" INTEGER NOT NULL DEFAULT 0,
      "publish_idempotency_key" TEXT,
      "publish_reason" TEXT,
      "publish_cancelled_at" TIMESTAMP(3),
      "publish_cancelled_by_user_id" TEXT,
      "publish_actor_user_id" TEXT,
      "dispatch_blocker_code" TEXT,
      "dispatch_blocked_at" TIMESTAMP(3)
    );

    INSERT INTO "vk_parsing_posts" (
      "id", "source_id", "vk_published_at", "created_at"
    )
    SELECT
      'history-' || LPAD(series::TEXT, 6, '0'),
      'source-1',
      TIMESTAMP '2026-01-01 00:00:00' + series * INTERVAL '1 minute',
      TIMESTAMP '2026-01-01 00:00:00' + series * INTERVAL '1 minute'
    FROM GENERATE_SERIES(1, 10000) series;

    INSERT INTO "vk_parsing_posts" (
      "id", "source_id", "vk_published_at", "created_at",
      "publish_schedule_fingerprint"
    )
    SELECT
      'pending-' || LPAD(series::TEXT, 6, '0'),
      'source-1',
      TIMESTAMP '2026-09-04 10:00:00' + series * INTERVAL '1 minute',
      TIMESTAMP '2026-09-04 10:00:00' + series * INTERVAL '1 minute',
      'pending:v1'
    FROM GENERATE_SERIES(1, 150) series;

    INSERT INTO "vk_parsing_posts" (
      "id", "source_id", "vk_published_at", "created_at",
      "publish_schedule_fingerprint"
    ) VALUES (
      'pending-policy-lock-race',
      'source-1',
      TIMESTAMP '2026-09-04 09:30:00',
      TIMESTAMP '2026-09-04 08:30:00',
      'pending:v1'
    );
  `);

  const migration = (await readFile(migrationPath, 'utf8')).replace(
    ' INDEX CONCURRENTLY ',
    ' INDEX ',
  );
  await db.exec(migration);
  await db.exec('ANALYZE "vk_parsing_posts"; SET enable_seqscan = off;');

  const pendingQuery = `
    SELECT "id"
    FROM "vk_parsing_posts"
    WHERE "source_id" = 'source-1'
      AND "status" = 'NEW'
      AND "publish_schedule_fingerprint" IS NOT NULL
      AND "publish_queued_at" IS NULL
      AND "publish_scheduled_at" IS NULL
      AND "publish_locked_at" IS NULL
      AND "publish_attempt_count" = 0
      AND "publish_idempotency_key" IS NULL
      AND "publish_reason" IS NULL
      AND "publish_cancelled_at" IS NULL
      AND "publish_cancelled_by_user_id" IS NULL
      AND "publish_actor_user_id" IS NULL
      AND "dispatch_blocker_code" IS NULL
      AND "dispatch_blocked_at" IS NULL
      AND "vk_published_at" >= TIMESTAMP '2026-09-04 09:00:00'
    ORDER BY "vk_published_at" ASC, "created_at" ASC, "id" ASC
    LIMIT 100
  `;
  const plan = await db.query(`EXPLAIN (FORMAT JSON, COSTS FALSE) ${pendingQuery}`);
  assert.match(JSON.stringify(plan.rows), /vk_parsing_posts_pending_autopublish_recovery_idx/u);

  const pending = await db.query(pendingQuery);
  assert.equal(pending.rows.length, 100);
  assert.equal(pending.rows[0]?.id, 'pending-policy-lock-race');

  process.stdout.write(`${JSON.stringify({ ok: true })}\n`);
} finally {
  await db.close();
}
