ALTER TABLE "chat_settings"
  ADD COLUMN "link_bot_button_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "link_bot_button_url" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "duplicate_bot_button_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "duplicate_bot_button_url" TEXT NOT NULL DEFAULT '';
