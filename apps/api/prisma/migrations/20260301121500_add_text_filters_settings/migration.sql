ALTER TABLE "chat_settings"
  ADD COLUMN IF NOT EXISTS "russian_profanity_filter_enabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "commercial_ads_filter_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "text_filters_bot_message_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "text_filters_bot_button_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "text_filters_bot_button_url" TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "text_filters_bot_button_text" TEXT NOT NULL DEFAULT 'Открыть';
