DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ChannelAutoPostAttachStatus') THEN
    CREATE TYPE "ChannelAutoPostAttachStatus" AS ENUM ('IN_PROGRESS', 'SUCCEEDED', 'SKIPPED');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "channel_auto_post_attach_markers" (
  "id" TEXT NOT NULL,
  "chat_id" TEXT NOT NULL,
  "message_id" TEXT NOT NULL,
  "status" "ChannelAutoPostAttachStatus" NOT NULL DEFAULT 'IN_PROGRESS',
  "lock_token" TEXT,
  "locked_at" TIMESTAMP(3),
  "bot_id" TEXT,
  "source" TEXT NOT NULL,
  "delivery_mode" TEXT,
  "link_type" TEXT,
  "replacement_message_id" TEXT,
  "published_url" TEXT,
  "last_error" TEXT,
  "last_status_code" INTEGER,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "channel_auto_post_attach_markers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "channel_auto_post_attach_markers_chat_message_key"
ON "channel_auto_post_attach_markers"("chat_id", "message_id");

CREATE INDEX IF NOT EXISTS "channel_auto_post_attach_markers_status_locked_at_idx"
ON "channel_auto_post_attach_markers"("status", "locked_at");

CREATE INDEX IF NOT EXISTS "channel_auto_post_attach_markers_chat_updated_idx"
ON "channel_auto_post_attach_markers"("chat_id", "updated_at" DESC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'channel_auto_post_attach_markers_chat_id_fkey'
  ) THEN
    ALTER TABLE "channel_auto_post_attach_markers"
    ADD CONSTRAINT "channel_auto_post_attach_markers_chat_id_fkey"
    FOREIGN KEY ("chat_id") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

UPDATE "channel_settings"
SET "auto_post_buttons_mode" = CASE
  WHEN "comments_enabled" = TRUE AND "post_suggestions_enabled" = TRUE THEN 'BOTH'::"ChannelAutoPostButtonsMode"
  WHEN "comments_enabled" = TRUE THEN 'COMMENTS'::"ChannelAutoPostButtonsMode"
  WHEN "post_suggestions_enabled" = TRUE THEN 'SUGGEST'::"ChannelAutoPostButtonsMode"
  ELSE 'OFF'::"ChannelAutoPostButtonsMode"
END
WHERE "auto_post_buttons_mode" = 'OFF'::"ChannelAutoPostButtonsMode"
  AND ("comments_enabled" = TRUE OR "post_suggestions_enabled" = TRUE);
