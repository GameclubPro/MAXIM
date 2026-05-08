CREATE TYPE "ManagedEntityAccessState" AS ENUM ('GRANTED', 'USER_DENIED', 'BOT_DENIED');

CREATE TYPE "ManagedEntityAccessRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER', 'UNKNOWN');

CREATE TABLE "managed_entity_access_edges" (
  "chat_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "bot_id" TEXT NOT NULL,
  "entity_type" "ChatEntityType" NOT NULL DEFAULT 'CHAT',
  "state" "ManagedEntityAccessState" NOT NULL,
  "user_role" "ManagedEntityAccessRole" NOT NULL DEFAULT 'UNKNOWN',
  "bot_role" "ManagedEntityAccessRole" NOT NULL DEFAULT 'UNKNOWN',
  "checked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMP(3),
  "denied_reason" TEXT,
  "source" TEXT NOT NULL DEFAULT 'unknown',
  "source_version" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "managed_entity_access_edges_pkey" PRIMARY KEY ("chat_id", "user_id", "bot_id")
);

ALTER TABLE "managed_entity_access_edges"
  ADD CONSTRAINT "managed_entity_access_edges_chat_id_fkey"
  FOREIGN KEY ("chat_id") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "managed_entity_access_edges_user_visible_idx"
  ON "managed_entity_access_edges"("user_id", "entity_type", "state", "expires_at", "checked_at" DESC);

CREATE INDEX "managed_entity_access_edges_chat_state_idx"
  ON "managed_entity_access_edges"("chat_id", "state", "checked_at" DESC);

CREATE INDEX "managed_entity_access_edges_bot_state_idx"
  ON "managed_entity_access_edges"("bot_id", "state", "checked_at" DESC);

WITH known_chat_bots AS (
  SELECT
    c.id AS chat_id,
    c.entity_type,
    NULLIF(c.primary_bot_id, '') AS bot_id
  FROM "chats" c
  WHERE NULLIF(c.primary_bot_id, '') IS NOT NULL

  UNION

  SELECT
    c.id AS chat_id,
    c.entity_type,
    NULLIF(c.bot_id, '') AS bot_id
  FROM "chats" c
  WHERE NULLIF(c.bot_id, '') IS NOT NULL

  UNION

  SELECT
    cbm.chat_id,
    c.entity_type,
    NULLIF(cbm.bot_id, '') AS bot_id
  FROM "chat_bot_memberships" cbm
  JOIN "chats" c ON c.id = cbm.chat_id
  WHERE cbm.status = 'ACTIVE'
    AND NULLIF(cbm.bot_id, '') IS NOT NULL
)
INSERT INTO "managed_entity_access_edges" (
  "chat_id",
  "user_id",
  "bot_id",
  "entity_type",
  "state",
  "user_role",
  "bot_role",
  "checked_at",
  "source"
)
SELECT DISTINCT
  allowlist.chat_id,
  allowlist.user_id,
  known_chat_bots.bot_id,
  known_chat_bots.entity_type,
  'GRANTED'::"ManagedEntityAccessState",
  'ADMIN'::"ManagedEntityAccessRole",
  'ADMIN'::"ManagedEntityAccessRole",
  COALESCE(allowlist.created_at, CURRENT_TIMESTAMP),
  'chat_admin_allowlist_backfill'
FROM "chat_admin_allowlist" allowlist
JOIN known_chat_bots ON known_chat_bots.chat_id = allowlist.chat_id
WHERE known_chat_bots.bot_id IS NOT NULL
ON CONFLICT ("chat_id", "user_id", "bot_id") DO NOTHING;
