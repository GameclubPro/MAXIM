ALTER TABLE "chat_settings"
  DROP COLUMN IF EXISTS "profanity_level",
  DROP COLUMN IF EXISTS "caps_threshold",
  DROP COLUMN IF EXISTS "flood_window_sec",
  DROP COLUMN IF EXISTS "flood_max_messages",
  DROP COLUMN IF EXISTS "duplicate_window_sec",
  DROP COLUMN IF EXISTS "duplicate_max_count",
  DROP COLUMN IF EXISTS "commercial_ads_repeat_window_sec",
  DROP COLUMN IF EXISTS "commercial_ads_low_confidence_log_enabled",
  DROP COLUMN IF EXISTS "commercial_ads_warn_first_enabled",
  DROP COLUMN IF EXISTS "repeat_ban_window_days",
  DROP COLUMN IF EXISTS "log_retention_days";
