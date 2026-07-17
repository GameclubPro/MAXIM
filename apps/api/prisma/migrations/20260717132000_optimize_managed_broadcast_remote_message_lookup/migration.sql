CREATE INDEX CONCURRENTLY IF NOT EXISTS "managed_broadcast_deliveries_target_remote_message_idx"
ON "managed_broadcast_deliveries"("target_chat_id", "remote_message_id");
