-- CreateEnum
CREATE TYPE "MaxActionLedgerStatus" AS ENUM (
  'ENQUEUED',
  'IN_PROGRESS',
  'SUCCEEDED',
  'SKIPPED',
  'AMBIGUOUS',
  'FAILED_RETRYABLE',
  'FAILED_TERMINAL'
);

-- CreateTable
CREATE TABLE "max_action_ledger" (
  "id" TEXT NOT NULL,
  "job_id" TEXT NOT NULL,
  "action_type" TEXT NOT NULL,
  "chat_id" TEXT NOT NULL,
  "bot_id" TEXT,
  "message_id" TEXT,
  "user_id" TEXT,
  "source_tag" TEXT,
  "traffic_class" TEXT,
  "action_health_lane" TEXT,
  "status" "MaxActionLedgerStatus" NOT NULL DEFAULT 'ENQUEUED',
  "ambiguous" BOOLEAN NOT NULL DEFAULT false,
  "terminal" BOOLEAN NOT NULL DEFAULT false,
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "last_status_code" INTEGER,
  "last_error_code" TEXT,
  "last_error" TEXT,
  "metadata" JSONB,
  "enqueued_at" TIMESTAMP(3),
  "first_attempt_at" TIMESTAMP(3),
  "last_attempt_at" TIMESTAMP(3),
  "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "max_action_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "max_action_ledger_job_id_key" ON "max_action_ledger"("job_id");

-- CreateIndex
CREATE INDEX "max_action_ledger_status_terminal_updated_idx" ON "max_action_ledger"("status", "terminal", "updated_at");

-- CreateIndex
CREATE INDEX "max_action_ledger_chat_action_updated_idx" ON "max_action_ledger"("chat_id", "action_type", "updated_at");

-- CreateIndex
CREATE INDEX "max_action_ledger_bot_status_updated_idx" ON "max_action_ledger"("bot_id", "status", "updated_at");

-- CreateIndex
CREATE INDEX "max_action_ledger_chat_user_action_updated_idx" ON "max_action_ledger"("chat_id", "user_id", "action_type", "updated_at");
