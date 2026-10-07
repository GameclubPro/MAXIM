-- FLAG: Exact source inventory must not scan an unrelated participant history.
-- This existing-table index is built concurrently, outside a transaction.
CREATE INDEX CONCURRENTLY "spammer_observations_chat_message_id_idx"
  ON "spammer_observations"("chat_id", "message_id", "id");
