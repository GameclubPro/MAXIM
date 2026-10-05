SET lock_timeout = '5s';
SET statement_timeout = '1800s';
-- FLAG: A partial build retains its failed migration receipt and exact index state.
-- Existing names must fail rather than silently accept an invalid concurrent index.
CREATE INDEX CONCURRENTLY "webhook_events_status_created_at_id_idx"
ON "webhook_events" ("status", "created_at", "id");

CREATE INDEX CONCURRENTLY "webhook_events_semantic_replay_fence_idx"
ON "webhook_events" ("semantic_key", "id")
WHERE "semantic_key" IS NOT NULL AND (
  "status" IN ('RECEIVED'::"WebhookStatus", 'QUEUED'::"WebhookStatus")
   OR ("status" = 'FAILED'::"WebhookStatus" AND "next_enqueue_at" IS NOT NULL)
   OR "timeout_quarantine_expires_at" IS NOT NULL
   OR COALESCE("error_message", '') ILIKE '%ambiguous%'
   OR COALESCE("error_message", '') LIKE 'WEBHOOK_HOT_PATH_TIMEOUT%QUARANTINED%'
);
RESET statement_timeout;
RESET lock_timeout;
