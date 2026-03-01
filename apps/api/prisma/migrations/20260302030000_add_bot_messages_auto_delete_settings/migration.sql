ALTER TABLE "chat_settings"
  ADD COLUMN IF NOT EXISTS "delete_bot_messages_enabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "delete_bot_messages_delay_minutes" INTEGER NOT NULL DEFAULT 2;
