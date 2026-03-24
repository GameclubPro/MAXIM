ALTER TABLE "chat_settings"
  ADD COLUMN IF NOT EXISTS "night_mode_comments_enabled" BOOLEAN NOT NULL DEFAULT false;
