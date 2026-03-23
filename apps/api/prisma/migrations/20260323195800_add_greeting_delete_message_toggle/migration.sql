ALTER TABLE "chat_settings"
  ADD COLUMN IF NOT EXISTS "greeting_delete_bot_message_enabled" BOOLEAN NOT NULL DEFAULT false;
