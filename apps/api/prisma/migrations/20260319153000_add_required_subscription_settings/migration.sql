ALTER TABLE "chat_settings"
  ADD COLUMN "required_subscription_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "required_subscription_channel_ids" JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN "required_subscription_bot_message_text" TEXT NOT NULL DEFAULT '';
