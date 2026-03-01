ALTER TABLE "chat_settings"
  ADD COLUMN IF NOT EXISTS "link_warn_message_text" TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "text_filters_warn_message_text" TEXT NOT NULL DEFAULT '';
