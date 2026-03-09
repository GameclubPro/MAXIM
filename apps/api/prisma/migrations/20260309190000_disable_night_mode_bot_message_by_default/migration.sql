ALTER TABLE "chat_settings"
  ALTER COLUMN "night_mode_bot_message_enabled" SET DEFAULT false;

UPDATE "chat_settings"
SET
  "night_mode_bot_message_enabled" = false,
  "night_mode_bot_button_enabled" = false,
  "night_mode_rules_button_enabled" = false
WHERE "night_mode_enabled" = false;

UPDATE "chat_settings"
SET
  "night_mode_bot_button_enabled" = false,
  "night_mode_rules_button_enabled" = false
WHERE "night_mode_bot_message_enabled" = false
  AND (
    "night_mode_bot_button_enabled" = true
    OR "night_mode_rules_button_enabled" = true
  );
