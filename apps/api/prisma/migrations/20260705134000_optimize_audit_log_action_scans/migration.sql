CREATE INDEX CONCURRENTLY IF NOT EXISTS "audit_logs_action_created_at_idx"
ON "audit_logs"("action", "created_at" DESC);
