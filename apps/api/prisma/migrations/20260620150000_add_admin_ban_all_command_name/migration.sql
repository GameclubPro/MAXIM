ALTER TABLE "chat_settings"
ADD COLUMN IF NOT EXISTS "admin_ban_all_command_name" TEXT NOT NULL DEFAULT 'БАН';
