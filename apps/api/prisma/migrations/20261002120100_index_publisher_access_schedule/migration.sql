SET lock_timeout = '5s';
SET statement_timeout = '120s';
-- FLAG: Keep writes available while building the bounded scheduler access paths.
CREATE INDEX CONCURRENTLY "publisher_bindings_expiry_idx"
  ON "publisher_entity_bindings" ("publisher_bot_id", "status", "bot_access_expires_at", "chat_id");
CREATE INDEX CONCURRENTLY "publisher_bindings_roster_due_idx"
  ON "publisher_entity_bindings" ("publisher_bot_id", "status", "roster_refresh_after", "chat_id");
RESET statement_timeout;
RESET lock_timeout;
