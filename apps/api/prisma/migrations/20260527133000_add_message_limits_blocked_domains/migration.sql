ALTER TABLE "chat_settings"
  ADD COLUMN "message_limits_blocked_domains" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
