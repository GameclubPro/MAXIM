ALTER TABLE "chat_settings"
  ADD COLUMN IF NOT EXISTS "message_count_limit_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "message_count_limit_messages" INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS "message_count_limit_window_hours" INTEGER NOT NULL DEFAULT 1;
