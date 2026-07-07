CREATE INDEX CONCURRENTLY IF NOT EXISTS "audit_logs_channel_suggestion_pending_review_created_idx"
ON "audit_logs"("created_at", "id")
WHERE "action" = 'CHANNEL_DIALOG_SUGGESTION'
  AND COALESCE(NULLIF("payload"->>'reviewStatus', ''), 'pending') = 'pending';
