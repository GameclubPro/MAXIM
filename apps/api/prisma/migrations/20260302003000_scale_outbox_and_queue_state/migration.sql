-- Add new QUEUED state for webhook outbox/state-machine flow.
ALTER TYPE "WebhookStatus" ADD VALUE IF NOT EXISTS 'QUEUED';

ALTER TABLE "webhook_events"
  ADD COLUMN IF NOT EXISTS "queued_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "enqueue_attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "next_enqueue_at" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "webhook_events_status_next_enqueue_at_created_at_idx"
  ON "webhook_events"("status", "next_enqueue_at", "created_at");

CREATE INDEX IF NOT EXISTS "violations_chat_id_user_id_rule_code_created_at_idx"
  ON "violations"("chat_id", "user_id", "rule_code", "created_at");

CREATE INDEX IF NOT EXISTS "moderation_events_chat_id_user_id_action_created_at_idx"
  ON "moderation_events"("chat_id", "user_id", "action", "created_at" DESC);
