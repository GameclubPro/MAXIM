CREATE INDEX CONCURRENTLY audit_logs_eraser_giveaway_bootstrap_idx
  ON audit_logs(chat_id, created_at, id) WHERE action = 'PUBLISH_GIVEAWAY';
CREATE INDEX CONCURRENTLY eraser_legacy_retirement_due_idx
  ON eraser_legacy_retirement(next_attempt_at, chat_id) WHERE completed_at IS NULL;
CREATE INDEX CONCURRENTLY message_retention_candidates_eraser_retirement_idx
  ON message_retention_candidates(chat_id, message_id) WHERE status IN ('pending', 'retry');
