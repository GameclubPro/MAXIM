ALTER TABLE "channel_settings"
ADD COLUMN "post_signature_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "post_signature_text" TEXT NOT NULL DEFAULT 'Подписаться на канал';

INSERT INTO "channel_settings" (
  "id",
  "chat_id",
  "post_signature_enabled",
  "post_signature_text",
  "updated_at"
)
SELECT
  'vk-signature-' || md5(vps."chat_id"),
  vps."chat_id",
  vps."append_channel_link_enabled",
  CASE
    WHEN BTRIM(vps."channel_link_text") = '' THEN 'Подписаться на канал'
    ELSE vps."channel_link_text"
  END,
  CURRENT_TIMESTAMP
FROM "vk_parsing_settings" AS vps
INNER JOIN "chats" AS c
  ON c."id" = vps."chat_id"
  AND c."entity_type" = 'CHANNEL'
ON CONFLICT ("chat_id") DO UPDATE
SET
  "post_signature_enabled" = EXCLUDED."post_signature_enabled",
  "post_signature_text" = EXCLUDED."post_signature_text",
  "updated_at" = CURRENT_TIMESTAMP;
