UPDATE "chat_settings"
SET
  "thematic_codeword_enabled" = false,
  "thematic_codeword" = '',
  "thematic_filters_bot_message_enabled" = false,
  "thematic_filters_warn_enabled" = false,
  "thematic_filters_ban_enabled" = false,
  "thematic_filters_mute_enabled" = false,
  "thematic_filters_mute_duration_hours" = 6,
  "thematic_filters_admin_contact_button_enabled" = false,
  "thematic_filters_admin_contact_button_url" = '',
  "thematic_filters_bot_button_enabled" = false,
  "thematic_filters_bot_button_url" = '',
  "thematic_filters_bot_button_text" = 'Открыть',
  "thematic_filters_bot_buttons" = '[]'::jsonb,
  "thematic_filters_rules_button_enabled" = false
WHERE
  "thematic_codeword_enabled" IS DISTINCT FROM false
  OR "thematic_codeword" IS DISTINCT FROM ''
  OR "thematic_filters_bot_message_enabled" IS DISTINCT FROM false
  OR "thematic_filters_warn_enabled" IS DISTINCT FROM false
  OR "thematic_filters_ban_enabled" IS DISTINCT FROM false
  OR "thematic_filters_mute_enabled" IS DISTINCT FROM false
  OR "thematic_filters_mute_duration_hours" IS DISTINCT FROM 6
  OR "thematic_filters_admin_contact_button_enabled" IS DISTINCT FROM false
  OR "thematic_filters_admin_contact_button_url" IS DISTINCT FROM ''
  OR "thematic_filters_bot_button_enabled" IS DISTINCT FROM false
  OR "thematic_filters_bot_button_url" IS DISTINCT FROM ''
  OR "thematic_filters_bot_button_text" IS DISTINCT FROM 'Открыть'
  OR "thematic_filters_bot_buttons" IS DISTINCT FROM '[]'::jsonb
  OR "thematic_filters_rules_button_enabled" IS DISTINCT FROM false;
