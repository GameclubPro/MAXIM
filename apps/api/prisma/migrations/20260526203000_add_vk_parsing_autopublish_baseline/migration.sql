ALTER TABLE "vk_parsing_settings"
  ADD COLUMN IF NOT EXISTS "auto_publish_enabled_at" TIMESTAMP(3);

UPDATE "vk_parsing_settings"
SET "auto_publish_enabled_at" = NOW()
WHERE "auto_publish_enabled" = true
  AND "auto_publish_enabled_at" IS NULL;
