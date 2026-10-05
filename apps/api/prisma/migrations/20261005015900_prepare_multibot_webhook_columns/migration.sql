-- FLAG: Online preparation adds only nullable receipt metadata; the legacy effects
-- cutoff remains the successful later 20261005020000 migration after quiescence.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE "webhook_events" ADD COLUMN "semantic_key" TEXT;
ALTER TABLE "webhook_events" ADD COLUMN "execution_deadline_at" TIMESTAMP(3);
COMMIT;
-- No history backfill: runtime derives NULL keys only in bounded active-work batches.
