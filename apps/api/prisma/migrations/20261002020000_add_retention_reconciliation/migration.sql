BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- FLAG: Additive receipt metadata does not rearm old activations or backfill message history.
ALTER TABLE "message_retention_candidates"
  ADD COLUMN "outcome_code" TEXT,
  ADD COLUMN "reconcile_after" TIMESTAMP(3);

COMMIT;
