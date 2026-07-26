ALTER TABLE "chat_settings"
  ALTER COLUMN "duplicate_warn_enabled" SET DEFAULT false,
  ALTER COLUMN "duplicate_mute_enabled" SET DEFAULT false,
  ALTER COLUMN "duplicate_ban_enabled" SET DEFAULT false,
  ALTER COLUMN "anti_duplicate_enabled" SET DEFAULT false,
  ALTER COLUMN "link_policy" SET DEFAULT 'ALERT_ONLY',
  ALTER COLUMN "required_subscription_bot_message_enabled" SET DEFAULT false,
  ALTER COLUMN "invitation_access_bot_message_enabled" SET DEFAULT false,
  ALTER COLUMN "comments_admins_enabled" SET DEFAULT false,
  ALTER COLUMN "delete_bot_messages_enabled" SET DEFAULT false,
  ALTER COLUMN "remove_bots_from_group_enabled" SET DEFAULT false,
  ALTER COLUMN "anti_spam_enabled" SET DEFAULT false,
  ALTER COLUMN "russian_profanity_filter_enabled" SET DEFAULT false,
  ALTER COLUMN "night_mode_open_message_enabled" SET DEFAULT false,
  ALTER COLUMN "link_bot_message_enabled" SET DEFAULT false,
  ALTER COLUMN "rules_attach_violations_enabled" SET DEFAULT false;

ALTER TABLE "channel_settings"
  ALTER COLUMN "comments_block_links_enabled" SET DEFAULT false,
  ALTER COLUMN "comments_anti_spam_enabled" SET DEFAULT false,
  ALTER COLUMN "comments_limit_two_in_row_enabled" SET DEFAULT false;
