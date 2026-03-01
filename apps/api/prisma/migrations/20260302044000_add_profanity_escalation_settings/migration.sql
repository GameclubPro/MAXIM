ALTER TABLE "chat_settings"
  ADD COLUMN "profanity_bot_message_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "profanity_warn_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "profanity_ban_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "profanity_kick_enabled" BOOLEAN NOT NULL DEFAULT false;

UPDATE "chat_settings"
SET
  "profanity_bot_message_enabled" = "text_filters_bot_message_enabled",
  "profanity_warn_enabled" = "text_filters_warn_enabled",
  "profanity_ban_enabled" = "text_filters_ban_enabled",
  "profanity_kick_enabled" = "text_filters_kick_enabled";
