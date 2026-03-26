ALTER TABLE "chat_settings"
  ADD COLUMN "duplicate_mute_duration_hours" INTEGER NOT NULL DEFAULT 6,
  ADD COLUMN "link_mute_duration_hours" INTEGER NOT NULL DEFAULT 6,
  ADD COLUMN "message_limits_mute_duration_hours" INTEGER NOT NULL DEFAULT 6,
  ADD COLUMN "profanity_mute_duration_hours" INTEGER NOT NULL DEFAULT 6,
  ADD COLUMN "required_subscription_mute_duration_hours" INTEGER NOT NULL DEFAULT 6,
  ADD COLUMN "text_filters_mute_duration_hours" INTEGER NOT NULL DEFAULT 6,
  ADD COLUMN "thematic_filters_mute_duration_hours" INTEGER NOT NULL DEFAULT 6;

UPDATE "chat_settings"
SET
  "duplicate_mute_duration_hours" = "mute_duration_hours",
  "link_mute_duration_hours" = "mute_duration_hours",
  "message_limits_mute_duration_hours" = "mute_duration_hours",
  "profanity_mute_duration_hours" = "mute_duration_hours",
  "required_subscription_mute_duration_hours" = "mute_duration_hours",
  "text_filters_mute_duration_hours" = "mute_duration_hours",
  "thematic_filters_mute_duration_hours" = "mute_duration_hours";
