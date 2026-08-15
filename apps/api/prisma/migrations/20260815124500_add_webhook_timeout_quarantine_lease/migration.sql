ALTER TABLE "webhook_events"
ADD COLUMN IF NOT EXISTS "timeout_quarantine_expires_at" TIMESTAMP(3);

CREATE INDEX CONCURRENTLY IF NOT EXISTS "webhook_events_live_timeout_quarantine_idx"
ON "webhook_events"("timeout_quarantine_expires_at", "id")
WHERE "status" = 'FAILED'
  AND LEFT(COALESCE("error_message", ''), 37) = 'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:'
  AND "timeout_quarantine_expires_at" IS NOT NULL;
