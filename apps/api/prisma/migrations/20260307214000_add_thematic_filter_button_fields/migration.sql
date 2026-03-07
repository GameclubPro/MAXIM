ALTER TABLE "chat_settings"
ADD COLUMN "thematic_filters_bot_button_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "thematic_filters_bot_button_url" TEXT NOT NULL DEFAULT '',
ADD COLUMN "thematic_filters_bot_button_text" TEXT NOT NULL DEFAULT 'Открыть';
