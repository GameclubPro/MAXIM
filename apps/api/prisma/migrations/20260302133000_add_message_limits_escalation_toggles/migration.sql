ALTER TABLE "chat_settings"
  ADD COLUMN IF NOT EXISTS "message_limits_warn_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "message_limits_ban_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "message_limits_kick_enabled" BOOLEAN NOT NULL DEFAULT false;
