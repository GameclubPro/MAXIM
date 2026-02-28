ALTER TABLE "chat_settings"
  ADD COLUMN "voice_messages_enabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "message_limits_bot_message_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "message_limits_bot_button_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "message_limits_bot_button_url" TEXT NOT NULL DEFAULT '';
