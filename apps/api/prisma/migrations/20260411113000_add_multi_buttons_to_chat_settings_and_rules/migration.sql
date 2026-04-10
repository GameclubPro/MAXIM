ALTER TABLE "chat_settings"
ADD COLUMN IF NOT EXISTS "greeting_bot_buttons" JSONB NOT NULL DEFAULT '[]'::jsonb,
ADD COLUMN IF NOT EXISTS "message_limits_bot_buttons" JSONB NOT NULL DEFAULT '[]'::jsonb,
ADD COLUMN IF NOT EXISTS "text_filters_bot_buttons" JSONB NOT NULL DEFAULT '[]'::jsonb,
ADD COLUMN IF NOT EXISTS "thematic_filters_bot_buttons" JSONB NOT NULL DEFAULT '[]'::jsonb,
ADD COLUMN IF NOT EXISTS "night_mode_bot_buttons" JSONB NOT NULL DEFAULT '[]'::jsonb,
ADD COLUMN IF NOT EXISTS "link_bot_buttons" JSONB NOT NULL DEFAULT '[]'::jsonb,
ADD COLUMN IF NOT EXISTS "duplicate_bot_buttons" JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE "chat_rules"
ADD COLUMN IF NOT EXISTS "buttons" JSONB NOT NULL DEFAULT '[]'::jsonb;

UPDATE "chat_settings"
SET "greeting_bot_buttons" = jsonb_build_array(
  jsonb_build_object(
    'text',
    CASE
      WHEN btrim("greeting_bot_button_text") <> '' THEN "greeting_bot_button_text"
      ELSE 'Открыть'
    END,
    'url',
    "greeting_bot_button_url"
  )
)
WHERE btrim("greeting_bot_button_url") <> ''
  AND COALESCE(jsonb_array_length("greeting_bot_buttons"), 0) = 0;

UPDATE "chat_settings"
SET "message_limits_bot_buttons" = jsonb_build_array(
  jsonb_build_object(
    'text',
    CASE
      WHEN btrim("message_limits_bot_button_text") <> '' THEN "message_limits_bot_button_text"
      ELSE 'Открыть'
    END,
    'url',
    "message_limits_bot_button_url"
  )
)
WHERE btrim("message_limits_bot_button_url") <> ''
  AND COALESCE(jsonb_array_length("message_limits_bot_buttons"), 0) = 0;

UPDATE "chat_settings"
SET "text_filters_bot_buttons" = jsonb_build_array(
  jsonb_build_object(
    'text',
    CASE
      WHEN btrim("text_filters_bot_button_text") <> '' THEN "text_filters_bot_button_text"
      ELSE 'Открыть'
    END,
    'url',
    "text_filters_bot_button_url"
  )
)
WHERE btrim("text_filters_bot_button_url") <> ''
  AND COALESCE(jsonb_array_length("text_filters_bot_buttons"), 0) = 0;

UPDATE "chat_settings"
SET "thematic_filters_bot_buttons" = jsonb_build_array(
  jsonb_build_object(
    'text',
    CASE
      WHEN btrim("thematic_filters_bot_button_text") <> '' THEN "thematic_filters_bot_button_text"
      ELSE 'Открыть'
    END,
    'url',
    "thematic_filters_bot_button_url"
  )
)
WHERE btrim("thematic_filters_bot_button_url") <> ''
  AND COALESCE(jsonb_array_length("thematic_filters_bot_buttons"), 0) = 0;

UPDATE "chat_settings"
SET "night_mode_bot_buttons" = jsonb_build_array(
  jsonb_build_object(
    'text',
    CASE
      WHEN btrim("night_mode_bot_button_text") <> '' THEN "night_mode_bot_button_text"
      ELSE 'Открыть'
    END,
    'url',
    "night_mode_bot_button_url"
  )
)
WHERE btrim("night_mode_bot_button_url") <> ''
  AND COALESCE(jsonb_array_length("night_mode_bot_buttons"), 0) = 0;

UPDATE "chat_settings"
SET "link_bot_buttons" = jsonb_build_array(
  jsonb_build_object(
    'text',
    CASE
      WHEN btrim("link_bot_button_text") <> '' THEN "link_bot_button_text"
      ELSE 'Открыть'
    END,
    'url',
    "link_bot_button_url"
  )
)
WHERE btrim("link_bot_button_url") <> ''
  AND COALESCE(jsonb_array_length("link_bot_buttons"), 0) = 0;

UPDATE "chat_settings"
SET "duplicate_bot_buttons" = jsonb_build_array(
  jsonb_build_object(
    'text',
    CASE
      WHEN btrim("duplicate_bot_button_text") <> '' THEN "duplicate_bot_button_text"
      ELSE 'Открыть'
    END,
    'url',
    "duplicate_bot_button_url"
  )
)
WHERE btrim("duplicate_bot_button_url") <> ''
  AND COALESCE(jsonb_array_length("duplicate_bot_buttons"), 0) = 0;

UPDATE "chat_rules"
SET "buttons" = jsonb_build_array(
  jsonb_build_object(
    'text',
    CASE
      WHEN btrim("button_text") <> '' THEN "button_text"
      ELSE 'Открыть'
    END,
    'url',
    "button_url"
  )
)
WHERE btrim("button_url") <> ''
  AND COALESCE(jsonb_array_length("buttons"), 0) = 0;
