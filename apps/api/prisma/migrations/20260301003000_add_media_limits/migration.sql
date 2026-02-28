ALTER TABLE "chat_settings"
  ADD COLUMN "photo_message_cooldown_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "photo_message_cooldown_hours" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "video_messages_enabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "file_messages_enabled" BOOLEAN NOT NULL DEFAULT true;
