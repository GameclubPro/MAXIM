ALTER TABLE "chat_settings"
  ADD COLUMN IF NOT EXISTS "required_subscription_duration_days" INTEGER NOT NULL DEFAULT 7,
  ADD COLUMN IF NOT EXISTS "required_subscription_expires_at" TEXT NOT NULL DEFAULT '';
