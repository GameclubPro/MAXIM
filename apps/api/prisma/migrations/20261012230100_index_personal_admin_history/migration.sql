SET lock_timeout = '5s';
SET statement_timeout = '1800s';
CREATE INDEX CONCURRENTLY "managed_entity_access_edges_user_demand_idx"
ON "managed_entity_access_edges" ("user_id", "chat_id", "bot_id");
RESET statement_timeout;
RESET lock_timeout;
