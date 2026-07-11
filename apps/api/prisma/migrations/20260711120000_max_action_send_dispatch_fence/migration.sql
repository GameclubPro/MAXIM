ALTER TABLE "max_action_ledger"
  ADD COLUMN IF NOT EXISTS "dispatch_token" TEXT,
  ADD COLUMN IF NOT EXISTS "dispatch_started_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "dispatch_bot_id" TEXT,
  ADD COLUMN IF NOT EXISTS "remote_message_id" TEXT;

UPDATE "max_action_ledger"
SET
  "status" = 'AMBIGUOUS',
  "ambiguous" = true,
  "terminal" = true,
  "completed_at" = COALESCE("completed_at", CURRENT_TIMESTAMP),
  "last_error_code" = COALESCE(
    "last_error_code",
    'ledger.dispatch_fence.legacy_unresolved'
  ),
  "last_error" = COALESCE(
    NULLIF("last_error", ''),
    'Legacy SEND_MESSAGE attempt predates the durable dispatch fence and requires manual review before retry.'
  )
WHERE
  "action_type" = 'SEND_MESSAGE'
  AND "remote_message_id" IS NULL
  AND (
    "status" = 'IN_PROGRESS'
    OR "attempt_count" > 0
    OR "first_attempt_at" IS NOT NULL
    OR "last_attempt_at" IS NOT NULL
  )
  AND (
    "terminal" = false
    OR "last_status_code" IN (408, 504)
    OR "last_status_code" >= 500
    OR lower(COALESCE("last_error", '')) ~
      '(timeout|timed out|econnreset|econnaborted|socket hang up|network|service unavailable)'
  );

CREATE INDEX IF NOT EXISTS "max_action_ledger_action_dispatch_started_idx"
ON "max_action_ledger"("action_type", "dispatch_started_at");
