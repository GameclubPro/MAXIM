ALTER TABLE "chat_settings"
ADD COLUMN "night_mode_open_message_enabled" BOOLEAN NOT NULL DEFAULT true;

UPDATE "chat_settings"
SET "night_mode_open_message_enabled" = true
WHERE "night_mode_open_message_enabled" IS DISTINCT FROM true;
