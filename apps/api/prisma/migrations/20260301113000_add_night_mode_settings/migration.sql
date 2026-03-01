ALTER TABLE "chat_settings"
  ADD COLUMN IF NOT EXISTS "night_mode_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "night_mode_start_time_minutes" INTEGER NOT NULL DEFAULT 1380,
  ADD COLUMN IF NOT EXISTS "night_mode_end_time_minutes" INTEGER NOT NULL DEFAULT 480,
  ADD COLUMN IF NOT EXISTS "night_mode_timezone" TEXT NOT NULL DEFAULT 'Europe/Moscow',
  ADD COLUMN IF NOT EXISTS "night_mode_bot_message_enabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "night_mode_bot_button_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "night_mode_bot_button_url" TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "night_mode_bot_button_text" TEXT NOT NULL DEFAULT 'Открыть';
