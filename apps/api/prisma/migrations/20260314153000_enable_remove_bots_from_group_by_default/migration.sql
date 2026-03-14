ALTER TABLE "chat_settings"
ALTER COLUMN "remove_bots_from_group_enabled" SET DEFAULT true;

UPDATE "chat_settings"
SET "remove_bots_from_group_enabled" = true
WHERE "remove_bots_from_group_enabled" = false;
