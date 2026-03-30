ALTER TABLE "chats"
ADD COLUMN "primary_bot_id" TEXT;

CREATE TYPE "ChatBotMembershipRole" AS ENUM ('PRIMARY', 'STANDBY');

CREATE TYPE "ChatBotMembershipStatus" AS ENUM ('ACTIVE', 'REMOVED');

CREATE TABLE "chat_bot_memberships" (
  "id" TEXT NOT NULL,
  "chat_id" TEXT NOT NULL,
  "bot_id" TEXT NOT NULL,
  "role" "ChatBotMembershipRole" NOT NULL DEFAULT 'STANDBY',
  "status" "ChatBotMembershipStatus" NOT NULL DEFAULT 'ACTIVE',
  "capabilities" JSONB NOT NULL DEFAULT '[]',
  "permissions_snapshot" JSONB,
  "last_seen_at" TIMESTAMP(3),
  "last_webhook_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "chat_bot_memberships_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "chat_bot_memberships_chat_id_fkey"
    FOREIGN KEY ("chat_id") REFERENCES "chats"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "chat_bot_memberships_chat_id_bot_id_key"
ON "chat_bot_memberships"("chat_id", "bot_id");

CREATE INDEX "chat_bot_memberships_bot_id_role_status_idx"
ON "chat_bot_memberships"("bot_id", "role", "status");

CREATE INDEX "chat_bot_memberships_chat_id_status_idx"
ON "chat_bot_memberships"("chat_id", "status");

CREATE INDEX "chats_primary_bot_id_idx"
ON "chats"("primary_bot_id");

UPDATE "chats"
SET "primary_bot_id" = "bot_id"
WHERE "bot_id" IS NOT NULL
  AND "primary_bot_id" IS NULL;

INSERT INTO "chat_bot_memberships" (
  "id",
  "chat_id",
  "bot_id",
  "role",
  "status",
  "last_seen_at",
  "created_at",
  "updated_at"
)
SELECT
  CONCAT('cbm_', md5(CONCAT("id", ':', "bot_id"))),
  "id",
  "bot_id",
  'PRIMARY'::"ChatBotMembershipRole",
  'ACTIVE'::"ChatBotMembershipStatus",
  NOW(),
  NOW(),
  NOW()
FROM "chats"
WHERE "bot_id" IS NOT NULL
ON CONFLICT ("chat_id", "bot_id") DO UPDATE
SET
  "role" = EXCLUDED."role",
  "status" = EXCLUDED."status",
  "last_seen_at" = EXCLUDED."last_seen_at",
  "updated_at" = EXCLUDED."updated_at";
