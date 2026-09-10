CREATE INDEX CONCURRENTLY "audit_logs_publisher_suggestion_status_created_idx"
ON "audit_logs" (("payload"->>'reviewStatus'), "created_at", "id")
WHERE "action" = 'PUBLISHER_CHANNEL_DIALOG_SUGGESTION';
