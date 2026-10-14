-- FLAG: Add only scheduling metadata. Preserve every existing permission, receipt and lease.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE "managed_broadcast_deliveries"
  ADD COLUMN "next_attempt_at" TIMESTAMP(3),
  ADD COLUMN "wait_reason" TEXT,
  ADD COLUMN "capacity_deferral_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "rate_limit_deferral_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "first_deferred_at" TIMESTAMP(3),
  ADD COLUMN "last_deferred_at" TIMESTAMP(3);
ALTER TABLE "publication_occurrences" ADD COLUMN "retry_expires_at" TIMESTAMP(3),
  ADD COLUMN "delivery_deadline_at" TIMESTAMP(3);
COMMIT;
