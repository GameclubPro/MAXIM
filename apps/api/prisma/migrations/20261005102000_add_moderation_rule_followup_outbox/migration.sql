SET lock_timeout = '5s';
SET statement_timeout = '1800s';
-- FLAG: Empty durable outbox. Never backfill authority from historical DELETEs.
CREATE TABLE "moderation_rule_followups" (
  "id" TEXT NOT NULL,
  "intent_id" TEXT NOT NULL,
  "reason_key" TEXT NOT NULL,
  "chat_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "message_id" TEXT NOT NULL,
  "rule_code" TEXT NOT NULL,
  "source_at" TIMESTAMP(3) NOT NULL,
  "deadline_at" TIMESTAMP(3) NOT NULL,
  "policy_sha256" TEXT NOT NULL,
  "envelope" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'WAITING_DELETE',
  "action_plan" JSONB,
  "effects" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lease_token" TEXT,
  "lease_expires_at" TIMESTAMP(3),
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "last_error" TEXT,
  "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "moderation_rule_followups_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "moderation_rule_followups_intent_id_fkey" FOREIGN KEY ("intent_id")
    REFERENCES "moderation_delete_intents"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "moderation_rule_followups_version_deadline_check" CHECK (
    jsonb_typeof("envelope") = 'object' AND ("envelope"->>'version' = '1') IS TRUE
    AND "policy_sha256" ~ '^[a-f0-9]{64}$' AND "source_at" > TIMESTAMP '1970-01-01'
    AND (("lease_token" IS NULL AND "lease_expires_at" IS NULL) OR ("lease_token" IS NOT NULL AND "lease_expires_at" IS NOT NULL))
    AND jsonb_typeof("effects") = 'object' AND octet_length("effects"::text) <= 16384
    AND ("action_plan" IS NULL OR (jsonb_typeof("action_plan") = 'object' AND octet_length("action_plan"::text) <= 16384))
    AND "deadline_at" = "source_at" + INTERVAL '5 minutes'
    AND "status" IN ('WAITING_DELETE', 'READY', 'IN_PROGRESS', 'RETRYABLE', 'COMPLETED', 'CANCELLED', 'AMBIGUOUS', 'EXPIRED')
    AND octet_length("envelope"::text) <= 16384
  )
);
CREATE UNIQUE INDEX "moderation_rule_followups_intent_reason_key" ON "moderation_rule_followups"("intent_id", "reason_key");
CREATE INDEX "moderation_rule_followups_due_idx" ON "moderation_rule_followups"("status", "next_attempt_at", "id");
CREATE INDEX "moderation_rule_followups_lease_idx" ON "moderation_rule_followups"("status", "lease_expires_at", "id");
CREATE INDEX "moderation_rule_followups_deadline_idx" ON "moderation_rule_followups"("status", "deadline_at", "id");
CREATE INDEX "moderation_rule_followups_intent_status_idx" ON "moderation_rule_followups"("intent_id", "status");
CREATE INDEX "moderation_rule_followups_unstarted_deadline_idx" ON "moderation_rule_followups"("status", "deadline_at", "id")
  WHERE COALESCE("effects"->>'phase', 'UNSTARTED') = 'UNSTARTED';
RESET statement_timeout;
RESET lock_timeout;
