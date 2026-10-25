CREATE INDEX CONCURRENTLY IF NOT EXISTS "moderation_delete_intents_eraser_holds_idx"
  ON "moderation_delete_intents" ("chat_id", "id") WHERE "retention_owned" = TRUE;
