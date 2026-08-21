CREATE INDEX CONCURRENTLY IF NOT EXISTS "audit_logs_channel_suggestion_publishing_review_created_idx"
ON "audit_logs"("created_at", "id")
WHERE "action" = 'CHANNEL_DIALOG_SUGGESTION'
  AND "payload"->>'type' = 'suggest'
  AND "payload"->>'reviewStatus' = 'publishing';
