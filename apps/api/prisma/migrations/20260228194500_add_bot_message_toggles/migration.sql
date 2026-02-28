ALTER TABLE "chat_settings"
ADD COLUMN "link_bot_message_enabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "duplicate_bot_message_enabled" BOOLEAN NOT NULL DEFAULT false;
