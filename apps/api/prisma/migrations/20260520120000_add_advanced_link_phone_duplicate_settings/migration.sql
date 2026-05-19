CREATE TYPE "DuplicateDetectionPreset" AS ENUM ('STANDARD', 'STRICT', 'CUSTOM');

ALTER TABLE "chat_settings"
  ADD COLUMN "duplicate_detection_preset" "DuplicateDetectionPreset" NOT NULL DEFAULT 'STANDARD',
  ADD COLUMN "duplicate_ignore_links_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "duplicate_ignore_phones_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "duplicate_near_match_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "link_escalation_window_hours" INTEGER NOT NULL DEFAULT 24,
  ADD COLUMN "link_warn_max_count" INTEGER NOT NULL DEFAULT 2,
  ADD COLUMN "link_mute_max_count" INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN "link_ban_max_count" INTEGER NOT NULL DEFAULT 4,
  ADD COLUMN "phone_numbers_bot_message_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "phone_numbers_bot_message_text" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "phone_numbers_warn_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "phone_numbers_mute_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "phone_numbers_mute_duration_hours" INTEGER NOT NULL DEFAULT 6,
  ADD COLUMN "phone_numbers_ban_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "phone_numbers_escalation_window_hours" INTEGER NOT NULL DEFAULT 12,
  ADD COLUMN "phone_numbers_warn_max_count" INTEGER NOT NULL DEFAULT 2,
  ADD COLUMN "phone_numbers_mute_max_count" INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN "phone_numbers_ban_max_count" INTEGER NOT NULL DEFAULT 4,
  ADD COLUMN "phone_numbers_admin_contact_button_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "phone_numbers_admin_contact_button_url" TEXT NOT NULL DEFAULT '';
