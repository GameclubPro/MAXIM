ALTER TABLE "chat_settings"
  ADD COLUMN IF NOT EXISTS "real_estate_topic_filter_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "auto_market_topic_filter_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "thematic_filters_bot_message_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "thematic_filters_warn_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "thematic_filters_ban_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "thematic_filters_kick_enabled" BOOLEAN NOT NULL DEFAULT false;
