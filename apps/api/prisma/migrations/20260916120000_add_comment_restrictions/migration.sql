BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE "comment_restrictions" (
  "profile" TEXT NOT NULL CHECK ("profile" IN ('moderation', 'publisher')),
  "entity_type" "ChatEntityType" NOT NULL,
  "chat_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "display_name" TEXT,
  "kind" TEXT CHECK ("kind" IN ('MUTE', 'BAN')),
  "expires_at" TIMESTAMPTZ(3),
  "reason" TEXT NOT NULL DEFAULT '',
  "revision" INTEGER NOT NULL DEFAULT 0 CHECK ("revision" >= 0),
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "comment_restrictions_pkey" PRIMARY KEY ("profile", "entity_type", "chat_id", "user_id"),
  CONSTRAINT "comment_restrictions_duration_check" CHECK (
    CASE WHEN "kind" = 'MUTE' THEN "expires_at" IS NOT NULL ELSE "expires_at" IS NULL END
  )
);

COMMIT;
