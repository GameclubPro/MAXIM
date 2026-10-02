SET lock_timeout = '5s';
SET statement_timeout = '30s';

-- FLAG: Diagnostic evidence only; no access writer or send guard reads this table.
-- The new empty table has no FK cascade: removing a binding must not erase SLA failures.
CREATE TABLE "publisher_access_refresh_obligations" (
  "publisher_bot_id" TEXT NOT NULL,
  "chat_id" TEXT NOT NULL,
  "proof_checked_at" TIMESTAMP(3) NOT NULL,
  "required_before" TIMESTAMP(3) NOT NULL,
  "observed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "cohort" TEXT NOT NULL,
  "resolution" TEXT NOT NULL DEFAULT 'pending',
  "committed_at" TIMESTAMP(3),
  CONSTRAINT "publisher_refresh_obligations_pkey" PRIMARY KEY
    ("publisher_bot_id", "chat_id", "proof_checked_at", "required_before"),
  CONSTRAINT "publisher_refresh_obligations_cohort_check" CHECK
    ("cohort" IN ('legacy', 'separated')),
  CONSTRAINT "publisher_refresh_obligations_resolution_check" CHECK
    (("resolution" = 'pending' AND "committed_at" IS NULL)
      OR ("resolution" IN ('confirmed', 'denied') AND "committed_at" IS NOT NULL))
);
CREATE INDEX "publisher_refresh_obligations_deadline_idx"
  ON "publisher_access_refresh_obligations" ("publisher_bot_id", "required_before");
CREATE INDEX "publisher_refresh_obligations_retention_idx"
  ON "publisher_access_refresh_obligations" ("required_before");
