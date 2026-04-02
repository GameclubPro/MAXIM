ALTER TABLE "channel_settings"
ALTER COLUMN "comments_enabled" SET DEFAULT false;

UPDATE "channel_settings" AS cs
SET "comments_enabled" = false
WHERE cs."comments_enabled" = true
  AND NOT EXISTS (
    SELECT 1
    FROM "audit_logs" AS al
    WHERE al."chat_id" = cs."chat_id"
      AND al."action" = 'UPDATE_CHANNEL_SETTINGS'
      AND lower(COALESCE(al."payload" ->> 'commentsEnabled', 'false')) = 'true'
  );
