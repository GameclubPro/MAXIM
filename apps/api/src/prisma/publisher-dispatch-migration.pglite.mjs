import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const migrationPaths = process.argv.slice(2);
if (migrationPaths.length !== 8 && migrationPaths.length !== 11) {
  throw new Error('Exactly eight expand or eleven contract publisher migration paths are required');
}
const contractApplied = migrationPaths.length === 11;

const db = new PGlite();
try {
  await db.exec(`
    CREATE TYPE "ChatBotMembershipStatus" AS ENUM ('ACTIVE', 'LEFT');
    CREATE TYPE "ChatEntityType" AS ENUM ('CHAT', 'CHANNEL');
    CREATE TYPE "ChatBotAccessState" AS ENUM (
      'UNKNOWN',
      'CONFIRMED_MEMBER',
      'CONFIRMED_ADMIN',
      'CONFIRMED_OWNER',
      'DENIED',
      'LOST'
    );

    CREATE TABLE "chats" (
      "id" TEXT PRIMARY KEY,
      "entity_type" "ChatEntityType" NOT NULL DEFAULT 'CHAT'
    );
    CREATE TABLE "managed_bot_chat_catalog" (
      "bot_id" TEXT NOT NULL,
      "chat_id" TEXT NOT NULL REFERENCES "chats"("id"),
      "entity_type" "ChatEntityType" NOT NULL DEFAULT 'CHAT',
      "status" TEXT NOT NULL DEFAULT 'ACTIVE',
      PRIMARY KEY ("bot_id", "chat_id")
    );
    CREATE TABLE "chat_settings" (
      "chat_id" TEXT PRIMARY KEY REFERENCES "chats"("id"),
      "comments_enabled" BOOLEAN NOT NULL DEFAULT false,
      "comments_admins_enabled" BOOLEAN NOT NULL DEFAULT false,
      "comments_chat_broadcasts_enabled" BOOLEAN NOT NULL DEFAULT false
    );
    CREATE TABLE "publications" ("id" TEXT PRIMARY KEY);
    CREATE TABLE "publication_occurrences" (
      "id" TEXT PRIMARY KEY,
      "publication_id" TEXT NOT NULL REFERENCES "publications"("id"),
      "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
      "scheduled_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE "managed_broadcasts" (
      "id" TEXT PRIMARY KEY,
      "publication_occurrence_id" TEXT REFERENCES "publication_occurrences"("id"),
      "status" TEXT NOT NULL DEFAULT 'ACTIVE',
      "next_send_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "locked_at" TIMESTAMP(3)
    );
    CREATE TABLE "managed_broadcast_deliveries" (
      "id" TEXT PRIMARY KEY,
      "broadcast_id" TEXT NOT NULL REFERENCES "managed_broadcasts"("id"),
      "publication_occurrence_id" TEXT REFERENCES "publication_occurrences"("id"),
      "bot_id" TEXT,
      "status" TEXT NOT NULL DEFAULT 'PENDING',
      "locked_at" TIMESTAMP(3)
    );
    CREATE TABLE "vk_parsing_settings" (
      "id" TEXT PRIMARY KEY,
      "chat_id" TEXT NOT NULL REFERENCES "chats"("id")
    );
    CREATE UNIQUE INDEX "vk_parsing_settings_chat_id_key"
      ON "vk_parsing_settings" ("chat_id");
    CREATE TABLE "vk_parsing_sources" (
      "id" TEXT PRIMARY KEY,
      "chat_id" TEXT NOT NULL REFERENCES "chats"("id"),
      "wall_owner_id" INTEGER NOT NULL,
      "status" TEXT NOT NULL DEFAULT 'ACTIVE'
    );
    CREATE UNIQUE INDEX "vk_parsing_sources_chat_wall_owner_key"
      ON "vk_parsing_sources" ("chat_id", "wall_owner_id");
    CREATE TABLE "vk_parsing_posts" (
      "id" TEXT PRIMARY KEY,
      "source_id" TEXT REFERENCES "vk_parsing_sources"("id"),
      "chat_id" TEXT NOT NULL REFERENCES "chats"("id"),
      "vk_owner_id" INTEGER NOT NULL,
      "vk_post_id" INTEGER NOT NULL,
      "vk_published_at" TIMESTAMP(3),
      "status" TEXT NOT NULL DEFAULT 'NEW',
      "published_message_id" TEXT,
      "publish_idempotency_key" TEXT,
      "publish_scheduled_at" TIMESTAMP(3),
      "publish_locked_at" TIMESTAMP(3)
    );
    CREATE UNIQUE INDEX "vk_parsing_posts_chat_vk_post_key"
      ON "vk_parsing_posts" ("chat_id", "vk_owner_id", "vk_post_id");

    INSERT INTO "chats" ("id") VALUES ('chat-legacy'), ('chat-publik');
    INSERT INTO "chat_settings" (
      "chat_id", "comments_enabled", "comments_admins_enabled",
      "comments_chat_broadcasts_enabled"
    ) VALUES ('chat-publik', true, true, true);
    INSERT INTO "publications" ("id") VALUES ('publication-legacy');
    INSERT INTO "publication_occurrences" ("id", "publication_id")
    VALUES ('occurrence-legacy', 'publication-legacy');
    INSERT INTO "managed_broadcasts" ("id", "publication_occurrence_id")
    VALUES ('broadcast-legacy', 'occurrence-legacy');
    INSERT INTO "managed_broadcast_deliveries" (
      "id", "broadcast_id", "publication_occurrence_id"
    ) VALUES ('delivery-legacy', 'broadcast-legacy', 'occurrence-legacy');
    INSERT INTO "vk_parsing_settings" ("id", "chat_id")
    VALUES ('settings-legacy', 'chat-legacy');
    INSERT INTO "vk_parsing_sources" ("id", "chat_id", "wall_owner_id")
    VALUES ('source-legacy', 'chat-legacy', -1);
    INSERT INTO "vk_parsing_posts" (
      "id", "source_id", "chat_id", "vk_owner_id", "vk_post_id"
    ) VALUES
      ('vk-legacy', 'source-legacy', 'chat-legacy', -1, 1),
      ('vk-publik', 'source-legacy', 'chat-legacy', -1, 2),
      ('vk-publisher-owned', 'source-legacy', 'chat-legacy', -1, 3);
  `);

  async function applyMigration(migrationPath) {
    // PGlite wraps exec() in a transaction, while production applies concurrent-index migrations
    // as standalone statements. Index concurrency is covered by the static migration guard; this
    // behavioral fixture exercises the otherwise identical schema, constraints, and triggers.
    const migration = (await readFile(migrationPath, 'utf8')).replaceAll(
      ' INDEX CONCURRENTLY ',
      ' INDEX ',
    );
    await db.exec(migration);
  }

  for (const migrationPath of migrationPaths.slice(0, 5)) {
    await applyMigration(migrationPath);
  }
  await db.exec(`
    INSERT INTO "publisher_entity_bindings" (
      "chat_id", "publisher_bot_id", "updated_at"
    ) VALUES ('chat-publik', 'publisher-bot', CURRENT_TIMESTAMP);
    INSERT INTO "managed_bot_chat_catalog" (
      "bot_id", "chat_id", "entity_type", "status"
    ) VALUES ('publisher-bot', 'chat-publik', 'CHAT', 'ACTIVE');
    INSERT INTO "managed_entity_publication_policies" (
      "chat_id", "publik_enabled", "suggestions_via_publik", "updated_at"
    ) VALUES ('chat-publik', true, true, CURRENT_TIMESTAMP);
  `);
  for (const migrationPath of migrationPaths.slice(5)) {
    await applyMigration(migrationPath);
  }

  const legacy = await db.query(`
    SELECT "dispatch_profile", "required_bot_id"
    FROM "publications"
    WHERE "id" = 'publication-legacy'
  `);
  assert.deepEqual(legacy.rows[0], {
    dispatch_profile: 'LEGACY_ROUTED',
    required_bot_id: null,
  });
  const publisherSettings = await db.query(`
    SELECT
      "chat_comments_enabled",
      "chat_comments_admins_enabled",
      "chat_comments_posts_enabled",
      "channel_suggestions_enabled",
      "revision"
    FROM "publisher_entity_settings"
    WHERE "chat_id" = 'chat-publik'
  `);
  assert.deepEqual(publisherSettings.rows[0], {
    chat_comments_enabled: false,
    chat_comments_admins_enabled: false,
    chat_comments_posts_enabled: false,
    channel_suggestions_enabled: false,
    revision: 0,
  });

  for (const [table, id] of [
    ['vk_parsing_settings', 'settings-legacy'],
    ['vk_parsing_sources', 'source-legacy'],
    ['vk_parsing_posts', 'vk-legacy'],
  ]) {
    const owner = await db.query(
      `SELECT "owner_profile", "owner_bot_id" FROM "${table}" WHERE "id" = $1`,
      [id],
    );
    assert.deepEqual(owner.rows[0], { owner_profile: 'MAJOR', owner_bot_id: '' });
  }

  const insertPublisherSettings = () =>
    db.query(
      `INSERT INTO "vk_parsing_settings" (
         "id", "chat_id", "owner_profile", "owner_bot_id"
       ) VALUES ('settings-publisher', 'chat-legacy', 'PUBLISHER', 'publisher-bot')`,
    );
  const insertPublisherSource = () =>
    db.query(
      `INSERT INTO "vk_parsing_sources" (
         "id", "chat_id", "wall_owner_id", "owner_profile", "owner_bot_id"
       ) VALUES ('source-publisher', 'chat-legacy', -1, 'PUBLISHER', 'publisher-bot')`,
    );
  const insertPublisherPost = (sourceId) =>
    db.query(
      `INSERT INTO "vk_parsing_posts" (
         "id", "source_id", "chat_id", "vk_owner_id", "vk_post_id",
         "owner_profile", "owner_bot_id"
       ) VALUES (
         'vk-publisher-scope', $1, 'chat-legacy', -1, 1,
         'PUBLISHER', 'publisher-bot'
       )`,
      [sourceId],
    );
  if (contractApplied) {
    await insertPublisherSettings();
    await insertPublisherSource();
    await insertPublisherPost('source-publisher');
  } else {
    await assert.rejects(insertPublisherSettings(), /vk_parsing_settings_chat_id_key/u);
    await assert.rejects(insertPublisherSource(), /vk_parsing_sources_chat_wall_owner_key/u);
    await assert.rejects(
      insertPublisherPost('source-legacy'),
      /vk_parsing_posts_chat_vk_post_key/u,
    );
  }
  await assert.rejects(
    db.query(
      `INSERT INTO "vk_parsing_sources" (
         "id", "chat_id", "wall_owner_id", "owner_profile", "owner_bot_id"
       ) VALUES ('source-invalid', 'chat-legacy', -2, 'PUBLISHER', '')`,
    ),
    /vk_parsing_sources_owner_scope_check/u,
  );
  await assert.rejects(
    db.query(
      `INSERT INTO "vk_parsing_settings" (
         "id", "chat_id", "owner_profile", "owner_bot_id"
       ) VALUES ('settings-invalid', 'chat-publik', 'MAJOR', 'publisher-bot')`,
    ),
    /vk_parsing_settings_owner_scope_check/u,
  );

  const validContext = JSON.stringify({
    version: 1,
    dialogBotId: 'main-bot',
    buttons: [[{ type: 'link', text: 'Комментарии', url: 'https://max.ru/main-bot?start=x' }]],
    reference: null,
  });
  const publisherOwnedContext = JSON.stringify({
    version: 1,
    dialogBotId: 'publisher-bot',
    buttons: [
      [{ type: 'link', text: 'Комментарии', url: 'https://max.ru/publisher-bot?startapp=x' }],
    ],
    reference: null,
  });
  await db.query(
    `INSERT INTO "publications" ("id", "dispatch_profile", "required_bot_id")
     VALUES ('publication-publik', 'PUBLIK_V1', 'publisher-bot')`,
  );
  await db.query(
    `INSERT INTO "publication_occurrences" (
       "id", "publication_id", "dispatch_profile", "required_bot_id"
     ) VALUES ('occurrence-publik', 'publication-publik', 'LEGACY_ROUTED', NULL)`,
  );
  await db.query(
    `INSERT INTO "managed_broadcasts" (
       "id", "publication_occurrence_id", "dispatch_profile", "required_bot_id"
     ) VALUES ('broadcast-publik', 'occurrence-publik', 'LEGACY_ROUTED', NULL)`,
  );
  await db.query(
    `INSERT INTO "managed_broadcast_deliveries" (
       "id", "broadcast_id", "publication_occurrence_id", "dispatch_profile",
       "required_bot_id", "dialog_bot_id", "publisher_dialog_context",
       "publication_policy_revision"
     ) VALUES (
       'delivery-publik', 'broadcast-publik', NULL, 'LEGACY_ROUTED', NULL,
       'main-bot', $1::JSONB, 0
     )`,
    [validContext],
  );
  await db.query(
    `INSERT INTO "managed_broadcast_deliveries" (
       "id", "broadcast_id", "publication_occurrence_id", "dispatch_profile",
       "required_bot_id", "dialog_bot_id", "publisher_dialog_context",
       "publication_policy_revision"
     ) VALUES (
       'delivery-publisher-owned', 'broadcast-publik', NULL, 'LEGACY_ROUTED', NULL,
       'publisher-bot', $1::JSONB, 0
     )`,
    [publisherOwnedContext],
  );

  for (const [table, id] of [
    ['publication_occurrences', 'occurrence-publik'],
    ['managed_broadcasts', 'broadcast-publik'],
    ['managed_broadcast_deliveries', 'delivery-publik'],
  ]) {
    const route = await db.query(
      `SELECT "dispatch_profile", "required_bot_id"
       FROM "${table}"
       WHERE "id" = $1`,
      [id],
    );
    assert.deepEqual(route.rows[0], {
      dispatch_profile: 'PUBLIK_V1',
      required_bot_id: 'publisher-bot',
    });
  }

  await assert.rejects(
    db.query(
      `UPDATE "publications"
       SET "dispatch_profile" = 'LEGACY_ROUTED', "required_bot_id" = NULL
       WHERE "id" = 'publication-publik'`,
    ),
    /publication dispatch route is immutable/u,
  );
  await assert.rejects(
    db.query(
      `UPDATE "publication_occurrences"
       SET "publication_id" = 'publication-legacy'
       WHERE "id" = 'occurrence-publik'`,
    ),
    /publication occurrence parent is immutable/u,
  );
  await assert.rejects(
    db.query(
      `UPDATE "managed_broadcasts"
       SET "publication_occurrence_id" = 'occurrence-legacy'
       WHERE "id" = 'broadcast-publik'`,
    ),
    /managed broadcast publication occurrence is immutable/u,
  );

  await db.query(
    `UPDATE "publication_occurrences"
     SET "dispatch_profile" = 'LEGACY_ROUTED', "required_bot_id" = NULL
     WHERE "id" = 'occurrence-publik'`,
  );
  await db.query(
    `UPDATE "managed_broadcasts"
     SET "dispatch_profile" = 'LEGACY_ROUTED', "required_bot_id" = NULL
     WHERE "id" = 'broadcast-publik'`,
  );
  await db.query(
    `UPDATE "managed_broadcast_deliveries"
     SET "dispatch_profile" = 'LEGACY_ROUTED', "required_bot_id" = NULL
     WHERE "id" = 'delivery-publik'`,
  );
  const preservedDelivery = await db.query(`
    SELECT "dispatch_profile", "required_bot_id"
    FROM "managed_broadcast_deliveries"
    WHERE "id" = 'delivery-publik'
  `);
  assert.deepEqual(preservedDelivery.rows[0], {
    dispatch_profile: 'PUBLIK_V1',
    required_bot_id: 'publisher-bot',
  });
  const publisherOwnedDelivery = await db.query(`
    SELECT "dispatch_profile", "required_bot_id", "dialog_bot_id"
    FROM "managed_broadcast_deliveries"
    WHERE "id" = 'delivery-publisher-owned'
  `);
  assert.deepEqual(publisherOwnedDelivery.rows[0], {
    dispatch_profile: 'PUBLIK_V1',
    required_bot_id: 'publisher-bot',
    dialog_bot_id: 'publisher-bot',
  });

  await assert.rejects(
    db.query(
      `UPDATE "managed_broadcast_deliveries"
       SET "dialog_bot_id" = 'other-main',
           "publisher_dialog_context" = $1::JSONB
       WHERE "id" = 'delivery-publik'`,
      [
        JSON.stringify({
          version: 1,
          dialogBotId: 'other-main',
          buttons: [],
          reference: null,
        }),
      ],
    ),
    /publication delivery route is immutable/u,
  );

  const contextChecks = await db.query(
    `SELECT
       "is_valid_publisher_dialog_context"($1::JSONB, 'main-bot') AS "valid",
       "is_valid_publisher_dialog_context"($2::JSONB, 'main-bot') AS "string_version",
       "is_valid_publisher_dialog_context"($3::JSONB, 'main-bot') AS "empty_row",
       "is_valid_publisher_dialog_context"($4::JSONB, 'main-bot') AS "object_row",
       "is_valid_publisher_dialog_context"($1::JSONB, 'other-main') AS "wrong_bot",
       "is_valid_publisher_dialog_context"($5::JSONB, 'main-bot') AS "oversized"`,
    [
      validContext,
      JSON.stringify({ version: '1', dialogBotId: 'main-bot', buttons: [] }),
      JSON.stringify({ version: 1, dialogBotId: 'main-bot', buttons: [[]] }),
      JSON.stringify({ version: 1, dialogBotId: 'main-bot', buttons: [{}] }),
      JSON.stringify({
        version: 1,
        dialogBotId: 'main-bot',
        buttons: [],
        padding: 'x'.repeat(66_000),
      }),
    ],
  );
  assert.deepEqual(contextChecks.rows[0], {
    valid: true,
    string_version: false,
    empty_row: false,
    object_row: false,
    wrong_bot: false,
    oversized: false,
  });

  await db.query(
    `UPDATE "vk_parsing_posts"
     SET "dispatch_profile" = 'PUBLIK_V1',
         "required_bot_id" = 'publisher-bot',
         "dialog_bot_id" = 'main-bot',
         "publish_dialog_context" = $1::JSONB,
         "publication_policy_revision" = 0,
         "publish_actor_user_id" = 'admin-1',
         "publish_idempotency_key" = 'vk-intent-1'
     WHERE "id" = 'vk-publik'`,
    [validContext],
  );
  await db.query(
    `UPDATE "vk_parsing_posts"
     SET "dispatch_profile" = 'PUBLIK_V1',
         "required_bot_id" = 'publisher-bot',
         "dialog_bot_id" = 'publisher-bot',
         "publish_dialog_context" = $1::JSONB,
         "publication_policy_revision" = 0,
         "publish_actor_user_id" = 'admin-1',
         "publish_idempotency_key" = 'vk-publisher-owned-intent-1'
     WHERE "id" = 'vk-publisher-owned'`,
    [publisherOwnedContext],
  );
  const publisherOwnedVkRoute = await db.query(`
    SELECT "dispatch_profile", "required_bot_id", "dialog_bot_id"
    FROM "vk_parsing_posts"
    WHERE "id" = 'vk-publisher-owned'
  `);
  assert.deepEqual(publisherOwnedVkRoute.rows[0], {
    dispatch_profile: 'PUBLIK_V1',
    required_bot_id: 'publisher-bot',
    dialog_bot_id: 'publisher-bot',
  });
  await assert.rejects(
    db.query(
      `UPDATE "vk_parsing_posts"
       SET "required_bot_id" = 'other-publisher'
       WHERE "id" = 'vk-publik'`,
    ),
    /active VK publish intent route is immutable/u,
  );

  await assert.rejects(
    db.query(
      `UPDATE "vk_parsing_posts"
       SET "publish_actor_user_id" = 'admin-2'
       WHERE "id" = 'vk-publisher-owned'`,
    ),
    /active VK publish intent route is immutable/u,
  );

  await db.exec('BEGIN');
  try {
    await db.query(
      `UPDATE "vk_parsing_posts"
       SET "publish_idempotency_key" = NULL
       WHERE "id" = 'vk-publisher-owned'
         AND "publish_idempotency_key" = 'vk-publisher-owned-intent-1'`,
    );
    await db.query(
      `UPDATE "vk_parsing_posts"
       SET "publish_idempotency_key" = 'vk-publisher-owned-manual-intent-2',
           "publish_actor_user_id" = 'admin-2'
       WHERE "id" = 'vk-publisher-owned'
         AND "publish_idempotency_key" IS NULL`,
    );
    await db.exec('COMMIT');
  } catch (error) {
    await db.exec('ROLLBACK');
    throw error;
  }
  const replacedVkIntent = await db.query(`
    SELECT "publish_idempotency_key", "publish_actor_user_id"
    FROM "vk_parsing_posts"
    WHERE "id" = 'vk-publisher-owned'
  `);
  assert.deepEqual(replacedVkIntent.rows[0], {
    publish_idempotency_key: 'vk-publisher-owned-manual-intent-2',
    publish_actor_user_id: 'admin-2',
  });

  await db.exec('BEGIN');
  try {
    await db.query(
      `UPDATE "vk_parsing_posts"
       SET "publish_idempotency_key" = NULL
       WHERE "id" = 'vk-publisher-owned'
         AND "publish_idempotency_key" = 'vk-publisher-owned-manual-intent-2'`,
    );
    await assert.rejects(
      db.query(
        `UPDATE "vk_parsing_posts"
         SET "publish_idempotency_key" = 'vk-publisher-owned-invalid-intent',
             "publish_actor_user_id" = ''
         WHERE "id" = 'vk-publisher-owned'
           AND "publish_idempotency_key" IS NULL`,
      ),
      /vk_parsing_posts_publish_actor_user_id_check/u,
    );
  } finally {
    await db.exec('ROLLBACK');
  }
  const rolledBackVkIntent = await db.query(`
    SELECT "publish_idempotency_key", "publish_actor_user_id"
    FROM "vk_parsing_posts"
    WHERE "id" = 'vk-publisher-owned'
  `);
  assert.deepEqual(rolledBackVkIntent.rows[0], replacedVkIntent.rows[0]);

  await db.query(
    `UPDATE "vk_parsing_posts"
     SET "published_message_id" = 'message-1',
         "published_bot_id" = 'publisher-bot',
         "publish_idempotency_key" = NULL
     WHERE "id" = 'vk-publik'`,
  );
  await assert.rejects(
    db.query(
      `UPDATE "vk_parsing_posts"
       SET "dispatch_profile" = 'LEGACY_ROUTED',
           "required_bot_id" = NULL,
           "dialog_bot_id" = NULL,
           "publish_dialog_context" = NULL,
           "publication_policy_revision" = NULL
       WHERE "id" = 'vk-publik'`,
    ),
    /active VK publish intent route is immutable/u,
  );
  await assert.rejects(
    db.query(
      `UPDATE "vk_parsing_posts"
       SET "published_bot_id" = 'other-publisher'
       WHERE "id" = 'vk-publik'`,
    ),
    /published VK bot provenance is immutable/u,
  );

  await db.query(
    `UPDATE "vk_parsing_posts"
     SET "rollback_queued_at" = CURRENT_TIMESTAMP,
         "rollback_idempotency_key" = 'vk-rollback-1'
     WHERE "id" = 'vk-publik'`,
  );
  await db.query(
    `UPDATE "vk_parsing_posts"
     SET "rollback_locked_at" = CURRENT_TIMESTAMP,
         "rollback_deleted_at" = CURRENT_TIMESTAMP
     WHERE "id" = 'vk-publik'`,
  );
  const rollback = await db.query(`
    SELECT "rollback_idempotency_key", "rollback_deleted_at" IS NOT NULL AS "deleted"
    FROM "vk_parsing_posts"
    WHERE "id" = 'vk-publik'
  `);
  assert.deepEqual(rollback.rows[0], {
    rollback_idempotency_key: 'vk-rollback-1',
    deleted: true,
  });

  process.stdout.write(`${JSON.stringify({ ok: true })}\n`);
} finally {
  await db.close();
}
