-- No history backfill: runtime derives NULL keys only in bounded active-work batches.
SET lock_timeout = '5s';
SET statement_timeout = '1800s';
-- FLAG: An existing index after an interrupted build requires reviewed recovery;
-- never mark this migration complete by skipping a possibly invalid index.
CREATE INDEX CONCURRENTLY "webhook_events_semantic_order_idx"
  ON "webhook_events" ("semantic_key", "created_at", "id")
  WHERE "semantic_key" IS NOT NULL;
RESET statement_timeout;
RESET lock_timeout;
