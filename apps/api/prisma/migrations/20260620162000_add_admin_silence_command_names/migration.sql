ALTER TABLE "chat_settings"
  ADD COLUMN IF NOT EXISTS "admin_silence_command_name" TEXT NOT NULL DEFAULT 'тишина',
  ADD COLUMN IF NOT EXISTS "admin_open_chat_command_name" TEXT NOT NULL DEFAULT 'тишина выкл';
