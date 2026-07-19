CREATE INDEX CONCURRENTLY IF NOT EXISTS "violations_created_at_idx"
ON "violations"("created_at");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "webhook_events_retention_completed_created_id_idx"
ON "webhook_events"("created_at", "id")
WHERE "status" IN ('PROCESSED'::"WebhookStatus", 'DUPLICATE'::"WebhookStatus");
