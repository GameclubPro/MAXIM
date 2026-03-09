ALTER TABLE "chat_settings"
  ADD COLUMN IF NOT EXISTS "greeting_rules_button_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "link_rules_button_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "text_filters_rules_button_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "thematic_filters_rules_button_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "duplicate_rules_button_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "message_limits_rules_button_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "night_mode_rules_button_enabled" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "chat_rules" (
  "id" TEXT NOT NULL,
  "chat_id" TEXT NOT NULL,
  "text" TEXT NOT NULL DEFAULT '',
  "image_base64" TEXT NOT NULL DEFAULT '',
  "image_mime_type" TEXT NOT NULL DEFAULT '',
  "image_file_name" TEXT NOT NULL DEFAULT '',
  "published_message_id" TEXT,
  "published_url" TEXT,
  "published_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "chat_rules_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "chat_rules_chat_id_key" UNIQUE ("chat_id"),
  CONSTRAINT "chat_rules_chat_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
