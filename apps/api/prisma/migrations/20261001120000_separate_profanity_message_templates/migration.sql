-- FLAG: Additive template separation preserves the existing profanity copy before commercial edits.
ALTER TABLE "chat_settings"
  ADD COLUMN "profanity_bot_message_text" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "profanity_warn_message_text" TEXT NOT NULL DEFAULT '';

UPDATE "chat_settings"
SET "profanity_bot_message_text" = "text_filters_bot_message_text",
    "profanity_warn_message_text" = "text_filters_warn_message_text"
WHERE "text_filters_bot_message_text" <> '' OR "text_filters_warn_message_text" <> '';
