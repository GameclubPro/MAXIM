ALTER TABLE "publisher_entity_settings"
  ADD COLUMN "channel_comments_enabled" BOOLEAN NOT NULL DEFAULT false;

CREATE TYPE "ChannelPostSignaturePresentation" AS ENUM ('SIGNATURE', 'BUTTON');

ALTER TABLE "channel_settings"
  ADD COLUMN "post_signature_presentation" "ChannelPostSignaturePresentation"
  NOT NULL DEFAULT 'SIGNATURE';

-- Migrate only the established advertising CTA. Every other existing signature keeps its
-- previous presentation, including incomplete or custom link configurations.
UPDATE "channel_settings"
SET
  "post_signature_presentation" = 'BUTTON'::"ChannelPostSignaturePresentation",
  "post_signature_text" = '📞 Заказать рекламу'
WHERE "post_signature_enabled" = true
  AND BTRIM("post_signature_url") <> ''
  AND CHAR_LENGTH(BTRIM("post_signature_text")) <= 32
  AND LOWER(BTRIM("post_signature_text")) IN (
    'заказать рекламу',
    '📞 заказать рекламу',
    '📞заказать рекламу'
  );

-- Initialize only channels that were already connected to the exact active Publisher bot
-- and had Major comments explicitly enabled. This is a one-time copy: the two settings
-- remain independently owned after this migration.
INSERT INTO "publisher_entity_settings" (
  "chat_id",
  "channel_comments_enabled",
  "revision",
  "updated_by_user_id",
  "created_at",
  "updated_at"
)
SELECT
  chat."id",
  true,
  0,
  NULL,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "chats" AS chat
INNER JOIN "channel_settings" AS major_settings
  ON major_settings."chat_id" = chat."id"
  AND major_settings."comments_enabled" = true
INNER JOIN "publisher_entity_bindings" AS binding
  ON binding."chat_id" = chat."id"
  AND binding."status" = 'ACTIVE'::"ChatBotMembershipStatus"
INNER JOIN "managed_bot_chat_catalog" AS catalog
  ON catalog."chat_id" = chat."id"
  AND catalog."bot_id" = binding."publisher_bot_id"
  AND catalog."entity_type" = chat."entity_type"
  AND catalog."status" = 'ACTIVE'
LEFT JOIN "managed_entity_publication_policies" AS policy
  ON policy."chat_id" = chat."id"
WHERE chat."entity_type" = 'CHANNEL'::"ChatEntityType"
  AND (policy."chat_id" IS NULL OR policy."publik_enabled" = true)
ON CONFLICT ("chat_id") DO UPDATE
SET "channel_comments_enabled" = EXCLUDED."channel_comments_enabled";

CREATE INDEX CONCURRENTLY "audit_logs_publisher_suggestion_pending_retention_idx"
ON "audit_logs" ("created_at", "id")
WHERE "action" = 'PUBLISHER_CHANNEL_DIALOG_SUGGESTION'
  AND "payload"->>'type' = 'suggest'
  AND "payload"->>'reviewStatus' = 'pending'
  AND "payload"->>'reviewClaimToken' IS NULL;
