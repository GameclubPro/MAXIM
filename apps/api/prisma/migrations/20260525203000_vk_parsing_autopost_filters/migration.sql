CREATE TABLE IF NOT EXISTS "vk_parsing_settings" (
  "id" TEXT NOT NULL,
  "chat_id" TEXT NOT NULL,
  "auto_publish_enabled" BOOLEAN NOT NULL DEFAULT false,
  "strip_links_enabled" BOOLEAN NOT NULL DEFAULT false,
  "skip_ads_enabled" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "vk_parsing_settings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "vk_parsing_settings_chat_id_fkey"
    FOREIGN KEY ("chat_id") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "vk_parsing_settings_chat_id_key"
  ON "vk_parsing_settings"("chat_id");

ALTER TABLE "vk_parsing_posts"
  ADD COLUMN IF NOT EXISTS "auto_published_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "auto_publish_error" TEXT,
  ADD COLUMN IF NOT EXISTS "skipped_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "skip_reason" TEXT;

CREATE INDEX IF NOT EXISTS "vk_parsing_posts_status_skip_reason_idx"
  ON "vk_parsing_posts"("status", "skip_reason");
