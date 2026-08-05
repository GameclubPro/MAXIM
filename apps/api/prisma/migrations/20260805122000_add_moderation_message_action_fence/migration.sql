ALTER TABLE "moderation_violation_message_claims"
ADD COLUMN "message_action_key" TEXT;

CREATE UNIQUE INDEX CONCURRENTLY "moderation_violation_message_claims_message_action_key_key"
ON "moderation_violation_message_claims"("message_action_key");

CREATE INDEX CONCURRENTLY "moderation_events_chat_message_idx"
ON "moderation_events"("chat_id", "message_id");
