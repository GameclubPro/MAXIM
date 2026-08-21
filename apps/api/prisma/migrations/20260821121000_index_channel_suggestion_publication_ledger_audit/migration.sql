CREATE INDEX CONCURRENTLY IF NOT EXISTS "max_action_ledger_suggestion_publish_updated_id_idx"
ON "max_action_ledger"("updated_at", "id")
WHERE "action_type" = 'SEND_MESSAGE'
  AND "source_tag" = 'suggestion_delivery'
  AND "job_id" LIKE 'channel-suggestion:publish:v1:%';
