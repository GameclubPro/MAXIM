ALTER TABLE "chat_settings"
  ADD COLUMN IF NOT EXISTS "greeting_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "greeting_bot_message_enabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "greeting_bot_message_text" TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "greeting_bot_button_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "greeting_bot_button_url" TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "greeting_bot_button_text" TEXT NOT NULL DEFAULT 'Открыть';
