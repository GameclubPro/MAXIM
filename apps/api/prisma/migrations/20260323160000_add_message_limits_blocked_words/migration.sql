ALTER TABLE "chat_settings"
  ADD COLUMN IF NOT EXISTS "message_limits_blocked_words" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
