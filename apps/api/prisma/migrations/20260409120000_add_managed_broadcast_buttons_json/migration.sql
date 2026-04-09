ALTER TABLE "managed_broadcasts"
ADD COLUMN IF NOT EXISTS "buttons" JSONB NOT NULL DEFAULT '[]'::jsonb;

UPDATE "managed_broadcasts"
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
WHERE "button_enabled" = true
  AND btrim("button_url") <> ''
  AND COALESCE(jsonb_array_length("buttons"), 0) = 0;
