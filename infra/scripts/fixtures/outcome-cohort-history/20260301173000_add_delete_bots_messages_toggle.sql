ALTER TABLE "chat_settings"
  ADD COLUMN IF NOT EXISTS "delete_bots_messages_enabled" BOOLEAN NOT NULL DEFAULT false;
