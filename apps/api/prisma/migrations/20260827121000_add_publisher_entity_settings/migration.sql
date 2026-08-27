CREATE TABLE "publisher_entity_settings" (
  "chat_id" TEXT NOT NULL,
  "chat_comments_enabled" BOOLEAN NOT NULL DEFAULT false,
  "chat_comments_admins_enabled" BOOLEAN NOT NULL DEFAULT false,
  "chat_comments_posts_enabled" BOOLEAN NOT NULL DEFAULT false,
  "channel_suggestions_enabled" BOOLEAN NOT NULL DEFAULT false,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "updated_by_user_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "publisher_entity_settings_pkey" PRIMARY KEY ("chat_id"),
  CONSTRAINT "publisher_entity_settings_revision_check" CHECK ("revision" >= 0),
  CONSTRAINT "publisher_entity_settings_actor_check"
    CHECK ("updated_by_user_id" IS NULL OR BTRIM("updated_by_user_id") <> '')
);

ALTER TABLE "publisher_entity_settings"
  ADD CONSTRAINT "publisher_entity_settings_chat_id_fkey"
  FOREIGN KEY ("chat_id") REFERENCES "chats"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed independent defaults only for exact active Publik catalog bindings. Major module settings
-- are intentionally not copied into the Publisher-owned settings domain.
INSERT INTO "publisher_entity_settings" (
  "chat_id",
  "chat_comments_enabled",
  "chat_comments_admins_enabled",
  "chat_comments_posts_enabled",
  "channel_suggestions_enabled",
  "revision",
  "updated_by_user_id",
  "created_at",
  "updated_at"
)
SELECT
  binding."chat_id",
  false,
  false,
  false,
  false,
  0,
  NULL,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "publisher_entity_bindings" AS binding
INNER JOIN "chats" AS chat
  ON chat."id" = binding."chat_id"
INNER JOIN "managed_bot_chat_catalog" AS catalog
  ON catalog."chat_id" = binding."chat_id"
  AND catalog."bot_id" = binding."publisher_bot_id"
  AND catalog."entity_type" = chat."entity_type"
  AND catalog."status" = 'ACTIVE'
WHERE binding."status" = 'ACTIVE'::"ChatBotMembershipStatus"
ON CONFLICT ("chat_id") DO NOTHING;
