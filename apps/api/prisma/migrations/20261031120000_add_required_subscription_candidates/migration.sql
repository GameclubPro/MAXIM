SET lock_timeout = '5s';
SET statement_timeout = '1800s';
-- FLAG: Empty owner table only. No historical violation, notice or DELETE is adopted.
CREATE TABLE "required_subscription_candidates" (
  "id" TEXT NOT NULL,
  "chat_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "message_id" TEXT NOT NULL,
  "source_at" TIMESTAMP(3) NOT NULL,
  "deadline_at" TIMESTAMP(3) NOT NULL,
  "policy_sha256" TEXT NOT NULL,
  "source" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'WAITING_CHECK',
  "frozen_plan" JSONB,
  "claim_id" TEXT,
  "effects" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lease_token" TEXT,
  "lease_expires_at" TIMESTAMP(3),
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "last_error" TEXT,
  "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "required_subscription_candidates_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "required_subscription_candidates_chat_id_fkey" FOREIGN KEY ("chat_id")
    REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "required_subscription_candidates_authority_check" CHECK (
    jsonb_typeof("source") = 'object' AND ("source"->>'version' = '1') IS TRUE
    AND "policy_sha256" ~ '^[a-f0-9]{64}$' AND "source_at" > TIMESTAMP '1970-01-01'
    AND "deadline_at" = "source_at" + INTERVAL '5 minutes'
    AND octet_length("source"::text) <= 16384
    AND (("lease_token" IS NULL AND "lease_expires_at" IS NULL) OR ("lease_token" IS NOT NULL AND "lease_expires_at" IS NOT NULL))
    AND ("status" = 'RUNNING') = ("lease_token" IS NOT NULL)
    AND "status" IN ('WAITING_CHECK', 'RUNNING', 'UNKNOWN', 'DONE', 'NO_ACTION', 'EXPIRED')
    AND "attempt_count" >= 0 AND jsonb_typeof("effects") = 'object' AND octet_length("effects"::text) <= 16384
    AND (("frozen_plan" IS NULL AND "claim_id" IS NULL) OR
      ("claim_id" IS NOT NULL AND "frozen_plan" IS NOT NULL AND jsonb_typeof("frozen_plan") = 'object' AND octet_length("frozen_plan"::text) <= 131072))
  )
);
CREATE UNIQUE INDEX "required_subscription_candidates_claim_key" ON "required_subscription_candidates"("claim_id");
CREATE INDEX "required_subscription_candidates_due_idx" ON "required_subscription_candidates"("status", "next_attempt_at", "id");
CREATE INDEX "required_subscription_candidates_lease_idx" ON "required_subscription_candidates"("status", "lease_expires_at", "id");
CREATE INDEX "required_subscription_candidates_deadline_idx" ON "required_subscription_candidates"("status", "deadline_at", "id");
RESET statement_timeout;
RESET lock_timeout;
