ALTER TABLE "chat_settings"
ADD COLUMN "night_mode_open_message_enabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "night_mode_open_message_text" TEXT NOT NULL DEFAULT '';
