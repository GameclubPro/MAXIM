ALTER TABLE "chat_settings"
  ALTER COLUMN "admin_ban_all_command_name" SET DEFAULT 'Бан!';

UPDATE "chat_settings"
SET "admin_ban_all_command_name" = 'Бан!'
WHERE "admin_ban_all_command_name" = 'БАН';
