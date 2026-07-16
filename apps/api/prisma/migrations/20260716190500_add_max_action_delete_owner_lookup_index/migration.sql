-- max_action_ledger is write-heavy in production; avoid blocking action enqueue/worker updates.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "max_action_ledger_delete_owner_lookup_idx"
ON "max_action_ledger"("chat_id", "action_type", "message_id", "status");
