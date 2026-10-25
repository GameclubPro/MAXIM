CREATE INDEX CONCURRENTLY IF NOT EXISTS "managed_giveaways_eraser_bootstrap_idx"
  ON "managed_giveaways" ("source_chat_id", "id");
