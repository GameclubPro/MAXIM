CREATE TYPE "ChatCatalogKind" AS ENUM (
  'MANAGED',
  'PRIVATE_DIRECT',
  'CONTEXT_ONLY',
  'UNKNOWN'
);

CREATE TYPE "ChatBotAccessState" AS ENUM (
  'UNKNOWN',
  'CONFIRMED_OWNER',
  'CONFIRMED_ADMIN',
  'CONFIRMED_MEMBER',
  'DENIED',
  'LOST',
  'STALE'
);

ALTER TABLE "chats"
  ADD COLUMN IF NOT EXISTS "catalog_kind" "ChatCatalogKind" NOT NULL DEFAULT 'UNKNOWN';

ALTER TABLE "chat_bot_memberships"
  ADD COLUMN IF NOT EXISTS "bot_access_state" "ChatBotAccessState" NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN IF NOT EXISTS "bot_access_checked_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "bot_access_expires_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "bot_access_source" TEXT,
  ADD COLUMN IF NOT EXISTS "bot_access_last_error_code" TEXT,
  ADD COLUMN IF NOT EXISTS "permissions_hash" TEXT;

CREATE TABLE IF NOT EXISTS "managed_entity_admin_members" (
  "chat_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "observed_by_bot_id" TEXT NOT NULL,
  "entity_type" "ChatEntityType" NOT NULL DEFAULT 'CHAT',
  "role" "ManagedEntityAccessRole" NOT NULL DEFAULT 'ADMIN',
  "permissions" JSONB NOT NULL DEFAULT '[]',
  "display_name" TEXT,
  "checked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMP(3),
  "source" TEXT NOT NULL DEFAULT 'unknown',
  "source_version" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "managed_entity_admin_members_pkey" PRIMARY KEY ("chat_id", "user_id", "observed_by_bot_id")
);

ALTER TABLE "managed_entity_admin_members"
  ADD CONSTRAINT "managed_entity_admin_members_chat_id_fkey"
  FOREIGN KEY ("chat_id") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "chats_catalog_kind_entity_type_idx"
  ON "chats"("catalog_kind", "entity_type");

CREATE INDEX IF NOT EXISTS "chat_bot_memberships_chat_access_state_checked_idx"
  ON "chat_bot_memberships"("chat_id", "bot_access_state", "bot_access_checked_at" DESC);

CREATE INDEX IF NOT EXISTS "chat_bot_memberships_bot_access_state_checked_idx"
  ON "chat_bot_memberships"("bot_id", "bot_access_state", "bot_access_checked_at" DESC);

CREATE INDEX IF NOT EXISTS "managed_entity_admin_members_user_type_checked_idx"
  ON "managed_entity_admin_members"("user_id", "entity_type", "checked_at" DESC);

CREATE INDEX IF NOT EXISTS "managed_entity_admin_members_chat_checked_idx"
  ON "managed_entity_admin_members"("chat_id", "checked_at" DESC);

CREATE INDEX IF NOT EXISTS "managed_entity_admin_members_bot_checked_idx"
  ON "managed_entity_admin_members"("observed_by_bot_id", "checked_at" DESC);

UPDATE "chats" chat
SET "catalog_kind" = CASE
  WHEN chat."entity_type" = 'CHANNEL' THEN 'MANAGED'::"ChatCatalogKind"
  WHEN chat."entity_type" = 'CHAT' AND chat."id" ~ '^[0-9]+$' THEN 'PRIVATE_DIRECT'::"ChatCatalogKind"
  WHEN EXISTS (
    SELECT 1
    FROM "managed_entity_access_edges" edge
    WHERE edge."chat_id" = chat."id"
      AND edge."state" = 'GRANTED'
  ) THEN 'MANAGED'::"ChatCatalogKind"
  WHEN EXISTS (
    SELECT 1
    FROM "chat_admin_allowlist" allowlist
    WHERE allowlist."chat_id" = chat."id"
  ) THEN 'MANAGED'::"ChatCatalogKind"
  WHEN EXISTS (
    SELECT 1
    FROM "chat_bot_memberships" membership
    WHERE membership."chat_id" = chat."id"
      AND membership."status" = 'ACTIVE'
      AND (
        COALESCE((membership."permissions_snapshot" ->> 'isAdmin')::boolean, false)
        OR COALESCE((membership."permissions_snapshot" ->> 'isOwner')::boolean, false)
      )
  ) THEN 'MANAGED'::"ChatCatalogKind"
  WHEN EXISTS (
    SELECT 1
    FROM "chat_bot_memberships" membership
    WHERE membership."chat_id" = chat."id"
      AND membership."status" = 'ACTIVE'
  ) THEN 'CONTEXT_ONLY'::"ChatCatalogKind"
  WHEN EXISTS (
    SELECT 1
    FROM "managed_bot_chat_catalog" catalog
    WHERE catalog."chat_id" = chat."id"
      AND catalog."status" = 'ACTIVE'
  ) THEN 'CONTEXT_ONLY'::"ChatCatalogKind"
  ELSE 'UNKNOWN'::"ChatCatalogKind"
END;

WITH snapshot_backfill AS (
  SELECT
    "id",
    CASE
      WHEN "status" = 'REMOVED' THEN 'LOST'::"ChatBotAccessState"
      WHEN "permissions_snapshot" IS NULL THEN 'UNKNOWN'::"ChatBotAccessState"
      WHEN COALESCE(("permissions_snapshot" ->> 'isOwner')::boolean, false) THEN 'CONFIRMED_OWNER'::"ChatBotAccessState"
      WHEN COALESCE(("permissions_snapshot" ->> 'isAdmin')::boolean, false) THEN 'CONFIRMED_ADMIN'::"ChatBotAccessState"
      ELSE 'CONFIRMED_MEMBER'::"ChatBotAccessState"
    END AS "next_state",
    CASE
      WHEN "permissions_snapshot" IS NOT NULL
        AND "permissions_snapshot" ->> 'checkedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
        THEN ("permissions_snapshot" ->> 'checkedAt')::timestamp
      WHEN "permissions_snapshot" IS NOT NULL THEN "updated_at"
      ELSE NULL
    END AS "checked_at",
    CASE
      WHEN "permissions_snapshot" IS NOT NULL THEN md5("permissions_snapshot"::text)
      ELSE NULL
    END AS "permissions_hash"
  FROM "chat_bot_memberships"
)
UPDATE "chat_bot_memberships" membership
SET
  "bot_access_state" = snapshot_backfill."next_state",
  "bot_access_checked_at" = snapshot_backfill."checked_at",
  "bot_access_expires_at" = CASE
    WHEN snapshot_backfill."checked_at" IS NOT NULL
      THEN snapshot_backfill."checked_at" + interval '15 minutes'
    ELSE NULL
  END,
  "bot_access_source" = CASE
    WHEN snapshot_backfill."next_state" = 'LOST' THEN 'membership_removed_backfill'
    WHEN snapshot_backfill."checked_at" IS NOT NULL THEN 'permissions_snapshot_backfill'
    ELSE 'unknown_backfill'
  END,
  "permissions_hash" = snapshot_backfill."permissions_hash"
FROM snapshot_backfill
WHERE membership."id" = snapshot_backfill."id";

WITH observed_bot AS (
  SELECT
    chat."id" AS "chat_id",
    COALESCE(
      NULLIF(chat."primary_bot_id", ''),
      NULLIF(chat."bot_id", ''),
      (
        SELECT membership."bot_id"
        FROM "chat_bot_memberships" membership
        WHERE membership."chat_id" = chat."id"
          AND membership."status" = 'ACTIVE'
        ORDER BY
          CASE membership."role" WHEN 'PRIMARY' THEN 0 ELSE 1 END,
          membership."updated_at" DESC
        LIMIT 1
      )
    ) AS "bot_id"
  FROM "chats" chat
)
INSERT INTO "managed_entity_admin_members" (
  "chat_id",
  "user_id",
  "observed_by_bot_id",
  "entity_type",
  "role",
  "permissions",
  "checked_at",
  "source",
  "created_at",
  "updated_at"
)
SELECT
  allowlist."chat_id",
  allowlist."user_id",
  observed_bot."bot_id",
  chat."entity_type",
  'ADMIN'::"ManagedEntityAccessRole",
  '[]'::jsonb,
  allowlist."created_at",
  'chat_admin_allowlist_backfill',
  allowlist."created_at",
  CURRENT_TIMESTAMP
FROM "chat_admin_allowlist" allowlist
JOIN "chats" chat ON chat."id" = allowlist."chat_id"
JOIN observed_bot ON observed_bot."chat_id" = allowlist."chat_id"
WHERE observed_bot."bot_id" IS NOT NULL
ON CONFLICT ("chat_id", "user_id", "observed_by_bot_id") DO UPDATE
SET
  "entity_type" = EXCLUDED."entity_type",
  "role" = EXCLUDED."role",
  "checked_at" = GREATEST(
    "managed_entity_admin_members"."checked_at",
    EXCLUDED."checked_at"
  ),
  "source" = EXCLUDED."source",
  "updated_at" = CURRENT_TIMESTAMP;
