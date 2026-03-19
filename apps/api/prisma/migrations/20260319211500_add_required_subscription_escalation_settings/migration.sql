ALTER TABLE "chat_settings"
  ADD COLUMN "required_subscription_bot_message_enabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "required_subscription_warn_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "required_subscription_warn_message_text" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "required_subscription_ban_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "required_subscription_kick_enabled" BOOLEAN NOT NULL DEFAULT false;
