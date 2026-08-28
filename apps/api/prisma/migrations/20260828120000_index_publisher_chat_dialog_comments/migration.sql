CREATE INDEX CONCURRENTLY IF NOT EXISTS "audit_logs_publisher_chat_comment_thread_created_idx"
ON "audit_logs"("chat_id", (("payload"->>'threadId')), "created_at" DESC)
WHERE "action" = 'PUBLISHER_CHAT_DIALOG_COMMENT';
