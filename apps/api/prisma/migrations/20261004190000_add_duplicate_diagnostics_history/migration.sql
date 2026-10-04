SET lock_timeout = '5s';
SET statement_timeout = '30s';

-- FLAG: This empty projection indexes observations only. No history backfill, content,
-- new action authority, or indexes over existing large tables belong in this migration.
CREATE TABLE "duplicate_diagnostics_history" (
  "intent_id" TEXT NOT NULL PRIMARY KEY,
  "chat_id" TEXT NOT NULL,
  "intent_created_at" TIMESTAMP(3) NOT NULL,
  "registered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "duplicate_diagnostics_history_intent_id_fkey"
    FOREIGN KEY ("intent_id") REFERENCES "moderation_delete_intents"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "duplicate_diagnostics_history_chat_created_id_idx"
  ON "duplicate_diagnostics_history" ("chat_id", "intent_created_at" DESC, "intent_id" DESC);

-- FLAG: Exact-intent lookup supports both old and new writers atomically. Replay does
-- not renew this registration; the projection contains no moderation permissions.
CREATE FUNCTION "record_duplicate_diagnostics_history"() RETURNS TRIGGER LANGUAGE plpgsql
  SET lock_timeout = '25ms' AS $$
BEGIN
  IF NEW."rule_code" = 'DUPLICATE_DELETE' THEN
    INSERT INTO "duplicate_diagnostics_history" ("intent_id", "chat_id", "intent_created_at")
      SELECT "id", "chat_id", "created_at" FROM "moderation_delete_intents" WHERE "id" = NEW."intent_id"
      ON CONFLICT ("intent_id") DO NOTHING;
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- FLAG: Optional observer lock waits fail within 25 ms; the function-scoped setting
  -- restores the caller's timeout. Whole-transaction cancellations still propagate.
  RETURN NEW;
END;
$$;
CREATE TRIGGER "duplicate_diagnostics_history_reason_insert"
  AFTER INSERT OR UPDATE OF "rule_code", "intent_id" ON "moderation_delete_intent_reasons"
  FOR EACH ROW EXECUTE FUNCTION "record_duplicate_diagnostics_history"();

RESET statement_timeout;
RESET lock_timeout;
