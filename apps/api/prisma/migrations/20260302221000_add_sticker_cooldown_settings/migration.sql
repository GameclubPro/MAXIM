ALTER TABLE "chat_settings"
ADD COLUMN "sticker_message_cooldown_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "sticker_message_cooldown_minutes" INTEGER NOT NULL DEFAULT 5;
