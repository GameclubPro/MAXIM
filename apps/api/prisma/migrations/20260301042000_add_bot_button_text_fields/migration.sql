ALTER TABLE "chat_settings"
  ADD COLUMN IF NOT EXISTS "message_limits_bot_button_text" TEXT NOT NULL DEFAULT 'Открыть',
  ADD COLUMN IF NOT EXISTS "link_bot_button_text" TEXT NOT NULL DEFAULT 'Открыть',
  ADD COLUMN IF NOT EXISTS "duplicate_bot_button_text" TEXT NOT NULL DEFAULT 'Открыть';
