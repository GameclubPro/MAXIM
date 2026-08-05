CREATE INDEX CONCURRENTLY "moderation_violation_claims_chat_message_type_idx"
ON "moderation_violation_message_claims"("chat_id", "message_id", "update_type");
