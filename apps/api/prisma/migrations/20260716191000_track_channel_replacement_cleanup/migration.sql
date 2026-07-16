BEGIN;

ALTER TABLE "channel_auto_post_attach_markers"
ADD COLUMN "original_deleted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "cleanup_intent_id" TEXT,
ADD COLUMN "replacement_send_started_at" TIMESTAMP(3);

ALTER TABLE "chat_auto_comment_attach_markers"
ADD COLUMN "cleanup_intent_id" TEXT,
ADD COLUMN "replacement_send_started_at" TIMESTAMP(3);

ALTER TABLE "chat_rules"
ADD COLUMN "publish_operation_id" TEXT,
ADD COLUMN "publish_operation_bot_id" TEXT,
ADD COLUMN "publish_send_started_at" TIMESTAMP(3),
ADD COLUMN "pending_cleanup_message_id" TEXT,
ADD COLUMN "pending_cleanup_bot_id" TEXT,
ADD COLUMN "pending_cleanup_intent_id" TEXT,
ADD COLUMN "pending_cleanup_kind" TEXT;

-- Legacy chat flags were set before DELETE required an explicit { success: true } response.
UPDATE "chat_auto_comment_attach_markers"
SET "original_deleted" = false
WHERE "original_deleted" = true
  AND "delivery_mode" = 'replace_with_bot_message'
  AND "replacement_message_id" IS NOT NULL;

ALTER TABLE "channel_auto_post_attach_markers"
ADD CONSTRAINT "channel_auto_post_attach_markers_cleanup_intent_id_fkey"
FOREIGN KEY ("cleanup_intent_id") REFERENCES "moderation_delete_intents"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "chat_auto_comment_attach_markers"
ADD CONSTRAINT "chat_auto_comment_attach_markers_cleanup_intent_id_fkey"
FOREIGN KEY ("cleanup_intent_id") REFERENCES "moderation_delete_intents"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "chat_rules"
ADD CONSTRAINT "chat_rules_pending_cleanup_intent_id_fkey"
FOREIGN KEY ("pending_cleanup_intent_id") REFERENCES "moderation_delete_intents"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
