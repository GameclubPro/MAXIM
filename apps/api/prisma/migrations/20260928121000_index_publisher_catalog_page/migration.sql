SET lock_timeout = '5s';
SET statement_timeout = '120s';
CREATE INDEX CONCURRENTLY IF NOT EXISTS "managed_entity_access_edges_publisher_page_idx"
  ON "managed_entity_access_edges" ("user_id", "bot_id", "state", "chat_id");
