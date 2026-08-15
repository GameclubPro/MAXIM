CREATE INDEX CONCURRENTLY IF NOT EXISTS "moderation_delete_intents_completed_id_idx"
ON "moderation_delete_intents"("completed_at" DESC, "id" DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS "max_action_ledger_terminal_completed_id_idx"
ON "max_action_ledger"("terminal", "completed_at" DESC, "id" DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS "moderation_delete_intents_expiry_no_mutation_idx"
ON "moderation_delete_intents"("retry_until_at", "created_at", "id")
WHERE "status" IN ('PENDING', 'RETRYABLE', 'WAITING_CAPABILITY', 'AMBIGUOUS', 'IN_PROGRESS')
  AND "remote_delete_succeeded_at" IS NULL
  AND "remote_delete_succeeded_bot_id" IS NULL
  AND "delete_dispatch_started_at" IS NULL
  AND "delete_dispatch_started_bot_id" IS NULL;
