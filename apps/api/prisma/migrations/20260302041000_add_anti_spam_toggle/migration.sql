ALTER TABLE "chat_settings"
  ADD COLUMN IF NOT EXISTS "anti_spam_enabled" BOOLEAN NOT NULL DEFAULT true;
