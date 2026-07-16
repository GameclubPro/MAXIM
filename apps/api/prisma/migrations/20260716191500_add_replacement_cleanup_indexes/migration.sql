CREATE INDEX CONCURRENTLY IF NOT EXISTS "channel_auto_post_cleanup_recovery_idx"
ON "channel_auto_post_attach_markers"(
  "original_deleted",
  "status",
  "cleanup_intent_id",
  "updated_at"
);

CREATE INDEX CONCURRENTLY IF NOT EXISTS "chat_auto_comment_cleanup_recovery_idx"
ON "chat_auto_comment_attach_markers"(
  "original_deleted",
  "status",
  "cleanup_intent_id",
  "updated_at"
);

CREATE INDEX CONCURRENTLY IF NOT EXISTS "chat_rules_publish_send_fence_idx"
ON "chat_rules"("publish_send_started_at");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "chat_rules_pending_cleanup_idx"
ON "chat_rules"("pending_cleanup_message_id", "pending_cleanup_intent_id", "updated_at");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "channel_auto_post_cleanup_intent_idx"
ON "channel_auto_post_attach_markers"("cleanup_intent_id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "chat_auto_comment_cleanup_intent_idx"
ON "chat_auto_comment_attach_markers"("cleanup_intent_id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "chat_rules_pending_cleanup_intent_idx"
ON "chat_rules"("pending_cleanup_intent_id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "audit_logs_rules_cleanup_recovery_idx"
ON "audit_logs"("created_at", "id")
WHERE "action" = 'PUBLISH_CHAT_RULES'
  AND "payload"->>'previousCleanupOutcome' IN ('failed', 'accepted', 'owned');
