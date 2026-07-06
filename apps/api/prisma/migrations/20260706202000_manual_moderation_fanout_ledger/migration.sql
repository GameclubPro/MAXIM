DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type
    WHERE typname = 'ManualModerationFanoutLedgerStatus'
  ) THEN
    CREATE TYPE "ManualModerationFanoutLedgerStatus" AS ENUM (
      'IN_PROGRESS',
      'SUCCEEDED',
      'SKIPPED',
      'AMBIGUOUS',
      'FAILED_RETRYABLE',
      'FAILED_TERMINAL'
    );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "manual_moderation_fanout_ledger" (
  "id" TEXT NOT NULL,
  "operation_key" TEXT NOT NULL,
  "job_id" TEXT,
  "root_intent_key" TEXT,
  "source_kind" TEXT NOT NULL,
  "operation" TEXT NOT NULL,
  "source_chat_id" TEXT NOT NULL,
  "target_chat_id" TEXT NOT NULL,
  "target_user_id" TEXT NOT NULL,
  "actor_user_id" TEXT NOT NULL,
  "logical_action" TEXT NOT NULL,
  "execution_mode" TEXT,
  "bot_id" TEXT,
  "status" "ManualModerationFanoutLedgerStatus" NOT NULL DEFAULT 'IN_PROGRESS',
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "moderation_event_id" TEXT,
  "audit_log_id" TEXT,
  "remote_message_id" TEXT,
  "last_error" TEXT,
  "last_status_code" INTEGER,
  "last_error_code" TEXT,
  "metadata" JSONB,
  "terminal" BOOLEAN NOT NULL DEFAULT FALSE,
  "locked_at" TIMESTAMP(3),
  "lock_token" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "manual_moderation_fanout_ledger_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "manual_moderation_fanout_ledger_operation_key_key"
ON "manual_moderation_fanout_ledger"("operation_key");

CREATE INDEX IF NOT EXISTS "manual_mod_fanout_ledger_status_locked_idx"
ON "manual_moderation_fanout_ledger"("status", "locked_at");

CREATE INDEX IF NOT EXISTS "manual_mod_fanout_ledger_source_user_created_idx"
ON "manual_moderation_fanout_ledger"("source_chat_id", "target_user_id", "created_at");

CREATE INDEX IF NOT EXISTS "manual_mod_fanout_ledger_target_action_created_idx"
ON "manual_moderation_fanout_ledger"("target_chat_id", "target_user_id", "logical_action", "created_at");

CREATE INDEX IF NOT EXISTS "manual_mod_fanout_ledger_job_operation_target_idx"
ON "manual_moderation_fanout_ledger"("job_id", "operation", "target_chat_id");

CREATE INDEX IF NOT EXISTS "manual_mod_fanout_ledger_root_operation_target_idx"
ON "manual_moderation_fanout_ledger"("root_intent_key", "operation", "target_chat_id");

ALTER TABLE "manual_moderation_fanout_ledger"
  ADD CONSTRAINT "manual_moderation_fanout_ledger_attempt_count_check"
  CHECK ("attempt_count" >= 0) NOT VALID;

ALTER TABLE "manual_moderation_fanout_ledger"
  ADD CONSTRAINT "manual_moderation_fanout_ledger_operation_key_check"
  CHECK (BTRIM("operation_key") <> '') NOT VALID;

ALTER TABLE "manual_moderation_fanout_ledger"
  ADD CONSTRAINT "manual_moderation_fanout_ledger_lock_check"
  CHECK ("status" <> 'IN_PROGRESS' OR "locked_at" IS NOT NULL) NOT VALID;

ALTER TABLE "manual_moderation_fanout_ledger"
  VALIDATE CONSTRAINT "manual_moderation_fanout_ledger_attempt_count_check";

ALTER TABLE "manual_moderation_fanout_ledger"
  VALIDATE CONSTRAINT "manual_moderation_fanout_ledger_operation_key_check";

ALTER TABLE "manual_moderation_fanout_ledger"
  VALIDATE CONSTRAINT "manual_moderation_fanout_ledger_lock_check";
