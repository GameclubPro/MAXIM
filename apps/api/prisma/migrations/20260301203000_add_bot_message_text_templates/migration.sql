ALTER TABLE "chat_settings"
  ADD COLUMN IF NOT EXISTS "link_bot_message_text" TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "duplicate_bot_message_text" TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "message_limits_bot_message_text" TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "text_filters_bot_message_text" TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "night_mode_bot_message_text" TEXT NOT NULL DEFAULT '';
