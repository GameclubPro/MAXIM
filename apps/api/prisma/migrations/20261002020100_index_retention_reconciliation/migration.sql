SET lock_timeout = '5s';
SET statement_timeout = '10min';

-- FLAG: Existing accepted work may fill the table; never hold its write lock for index builds.
CREATE INDEX CONCURRENTLY "message_retention_candidates_chat_reconcile_idx"
  ON "message_retention_candidates" ("chat_id", "reconcile_after", "message_id")
  WHERE "reconcile_after" IS NOT NULL;
CREATE INDEX CONCURRENTLY "message_retention_candidates_outcome_idx"
  ON "message_retention_candidates" ("chat_id", "outcome_code", "message_id");
CREATE INDEX CONCURRENTLY "message_retention_candidates_shadow_source_idx"
  ON "message_retention_candidates" ("chat_id", "status", "shadow_only", "source_at", "message_id");

RESET statement_timeout;
RESET lock_timeout;
