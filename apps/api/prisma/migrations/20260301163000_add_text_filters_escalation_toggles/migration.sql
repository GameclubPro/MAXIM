ALTER TABLE "chat_settings"
  ADD COLUMN IF NOT EXISTS "text_filters_warn_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "text_filters_ban_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "text_filters_kick_enabled" BOOLEAN NOT NULL DEFAULT false;
