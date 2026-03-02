ALTER TABLE "chat_settings"
  ADD COLUMN IF NOT EXISTS "global_cross_chat_spam_enabled" BOOLEAN NOT NULL DEFAULT false;
