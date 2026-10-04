SET lock_timeout = '5s';
SET statement_timeout = '30s';

-- FLAG: An obligation belongs to one immutable claim generation. It contains no
-- positive action authority and survives loss of the corresponding Redis job.
CREATE TABLE "message_duplicate_claim_cleanup" (
  "claim_id" TEXT NOT NULL,
  "claim_created_at" TIMESTAMP(3) NOT NULL,
  "event_timestamp_ms" BIGINT NOT NULL,
  "authorization_timestamp_ms" BIGINT NOT NULL,
  "deadline_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "message_duplicate_claim_cleanup_pkey" PRIMARY KEY ("claim_id"),
  CONSTRAINT "message_duplicate_claim_cleanup_claim_id_fkey" FOREIGN KEY ("claim_id")
    REFERENCES "moderation_violation_message_claims" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "message_duplicate_claim_cleanup_time_check" CHECK (
    "event_timestamp_ms" > 0 AND "authorization_timestamp_ms" > 0
  )
);
CREATE INDEX "message_duplicate_claim_cleanup_due_idx"
  ON "message_duplicate_claim_cleanup" ("deadline_at", "claim_id");
