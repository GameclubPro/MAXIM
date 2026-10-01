-- Partial receipt index also supports legacy Start confirmations without a backfill.
-- Equality on remote_message_id proves the predicate even for a generic prepared plan.
SET lock_timeout = '5s';
SET statement_timeout = '120s';
CREATE INDEX CONCURRENTLY IF NOT EXISTS "max_action_ledger_send_receipt_lookup_idx"
  ON "max_action_ledger" ("chat_id", "source_tag", "remote_message_id")
  WHERE "remote_message_id" IS NOT NULL;
