ALTER TYPE "SanctionAction" ADD VALUE IF NOT EXISTS 'MUTE' BEFORE 'KICK';

ALTER TABLE "chat_settings" RENAME COLUMN "duplicate_kick_enabled" TO "duplicate_mute_enabled";
ALTER TABLE "chat_settings" RENAME COLUMN "duplicate_kick_window_sec" TO "duplicate_mute_window_sec";
ALTER TABLE "chat_settings" RENAME COLUMN "duplicate_kick_max_count" TO "duplicate_mute_max_count";
ALTER TABLE "chat_settings" RENAME COLUMN "required_subscription_kick_enabled" TO "required_subscription_mute_enabled";
ALTER TABLE "chat_settings" RENAME COLUMN "message_limits_kick_enabled" TO "message_limits_mute_enabled";
ALTER TABLE "chat_settings" RENAME COLUMN "profanity_kick_enabled" TO "profanity_mute_enabled";
ALTER TABLE "chat_settings" RENAME COLUMN "text_filters_kick_enabled" TO "text_filters_mute_enabled";
ALTER TABLE "chat_settings" RENAME COLUMN "thematic_filters_kick_enabled" TO "thematic_filters_mute_enabled";
ALTER TABLE "chat_settings" RENAME COLUMN "link_kick_enabled" TO "link_mute_enabled";
ALTER TABLE "chat_settings" RENAME COLUMN "ban_duration_hours" TO "mute_duration_hours";
