ALTER TABLE "chat_settings"
  ADD COLUMN IF NOT EXISTS "required_subscription_button_text" TEXT NOT NULL DEFAULT '';
