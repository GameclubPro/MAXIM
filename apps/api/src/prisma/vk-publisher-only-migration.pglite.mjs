import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const [migrationPath] = process.argv.slice(2);
if (!migrationPath) {
  throw new Error('The Publisher-only VK migration path is required');
}

const db = new PGlite();
try {
  await db.exec(`
    CREATE TYPE "VkParsingOwnerProfile" AS ENUM ('MAJOR', 'PUBLISHER');

    CREATE TABLE "vk_parsing_settings" (
      "id" TEXT PRIMARY KEY,
      "owner_profile" "VkParsingOwnerProfile" NOT NULL DEFAULT 'MAJOR',
      "owner_bot_id" TEXT NOT NULL DEFAULT '',
      CONSTRAINT "vk_parsing_settings_owner_scope_check" CHECK (
        ("owner_profile" = 'MAJOR' AND "owner_bot_id" = '')
        OR ("owner_profile" = 'PUBLISHER' AND BTRIM("owner_bot_id") <> '')
      )
    );
    CREATE TABLE "vk_parsing_sources" (
      "id" TEXT PRIMARY KEY,
      "owner_profile" "VkParsingOwnerProfile" NOT NULL DEFAULT 'MAJOR',
      "owner_bot_id" TEXT NOT NULL DEFAULT '',
      CONSTRAINT "vk_parsing_sources_owner_scope_check" CHECK (
        ("owner_profile" = 'MAJOR' AND "owner_bot_id" = '')
        OR ("owner_profile" = 'PUBLISHER' AND BTRIM("owner_bot_id") <> '')
      )
    );
    CREATE TABLE "vk_parsing_posts" (
      "id" TEXT PRIMARY KEY,
      "source_id" TEXT NOT NULL REFERENCES "vk_parsing_sources"("id") ON DELETE CASCADE,
      "owner_profile" "VkParsingOwnerProfile" NOT NULL DEFAULT 'MAJOR',
      "owner_bot_id" TEXT NOT NULL DEFAULT '',
      CONSTRAINT "vk_parsing_posts_owner_scope_check" CHECK (
        ("owner_profile" = 'MAJOR' AND "owner_bot_id" = '')
        OR ("owner_profile" = 'PUBLISHER' AND BTRIM("owner_bot_id") <> '')
      )
    );

    INSERT INTO "vk_parsing_settings" ("id") VALUES ('settings-major');
    INSERT INTO "vk_parsing_settings" (
      "id", "owner_profile", "owner_bot_id"
    ) VALUES ('settings-publisher', 'PUBLISHER', 'publisher-bot');

    INSERT INTO "vk_parsing_sources" ("id") VALUES ('source-major');
    INSERT INTO "vk_parsing_sources" (
      "id", "owner_profile", "owner_bot_id"
    ) VALUES ('source-publisher', 'PUBLISHER', 'publisher-bot');

    INSERT INTO "vk_parsing_posts" ("id", "source_id")
    VALUES ('post-major-under-major', 'source-major');
    INSERT INTO "vk_parsing_posts" (
      "id", "source_id", "owner_profile", "owner_bot_id"
    ) VALUES (
      'post-publisher-under-major', 'source-major', 'PUBLISHER', 'publisher-bot'
    );
    INSERT INTO "vk_parsing_posts" ("id", "source_id")
    VALUES ('post-major-under-publisher', 'source-publisher');
    INSERT INTO "vk_parsing_posts" (
      "id", "source_id", "owner_profile", "owner_bot_id"
    ) VALUES (
      'post-publisher-under-publisher', 'source-publisher', 'PUBLISHER', 'publisher-bot'
    );
  `);

  await db.exec(await readFile(migrationPath, 'utf8'));

  for (const [table, expectedIds] of [
    ['vk_parsing_settings', ['settings-publisher']],
    ['vk_parsing_sources', ['source-publisher']],
    ['vk_parsing_posts', ['post-publisher-under-publisher']],
  ]) {
    const rows = await db.query(`SELECT "id" FROM "${table}" ORDER BY "id"`);
    assert.deepEqual(
      rows.rows.map((row) => row.id),
      expectedIds,
    );
  }

  const defaults = await db.query(`
    SELECT "table_name", "column_name"
    FROM "information_schema"."columns"
    WHERE "table_name" IN ('vk_parsing_settings', 'vk_parsing_sources', 'vk_parsing_posts')
      AND "column_name" IN ('owner_profile', 'owner_bot_id')
      AND "column_default" IS NOT NULL
  `);
  assert.deepEqual(defaults.rows, []);

  const constraints = await db.query(`
    SELECT "conname", "convalidated", pg_get_constraintdef("oid") AS "definition"
    FROM "pg_constraint"
    WHERE "conname" IN (
      'vk_parsing_settings_owner_scope_check',
      'vk_parsing_sources_owner_scope_check',
      'vk_parsing_posts_owner_scope_check'
    )
    ORDER BY "conname"
  `);
  assert.equal(constraints.rows.length, 3);
  for (const constraint of constraints.rows) {
    assert.equal(constraint.convalidated, true);
    assert.match(constraint.definition, /PUBLISHER/u);
    assert.doesNotMatch(constraint.definition, /MAJOR/u);
  }

  for (const statement of [
    `INSERT INTO "vk_parsing_settings" (
       "id", "owner_profile", "owner_bot_id"
     ) VALUES ('settings-major-rejected', 'MAJOR', '')`,
    `INSERT INTO "vk_parsing_sources" (
       "id", "owner_profile", "owner_bot_id"
     ) VALUES ('source-major-rejected', 'MAJOR', '')`,
    `INSERT INTO "vk_parsing_posts" (
       "id", "source_id", "owner_profile", "owner_bot_id"
     ) VALUES ('post-major-rejected', 'source-publisher', 'MAJOR', '')`,
  ]) {
    await assert.rejects(db.exec(statement), /owner_scope_check/u);
  }

  await db.exec(`
    INSERT INTO "vk_parsing_settings" (
      "id", "owner_profile", "owner_bot_id"
    ) VALUES ('settings-publisher-new', 'PUBLISHER', 'publisher-bot');
    INSERT INTO "vk_parsing_sources" (
      "id", "owner_profile", "owner_bot_id"
    ) VALUES ('source-publisher-new', 'PUBLISHER', 'publisher-bot');
    INSERT INTO "vk_parsing_posts" (
      "id", "source_id", "owner_profile", "owner_bot_id"
    ) VALUES (
      'post-publisher-new', 'source-publisher-new', 'PUBLISHER', 'publisher-bot'
    );
  `);

  process.stdout.write(`${JSON.stringify({ ok: true })}\n`);
} finally {
  await db.close();
}
