-- FLAG: Deleting a retained webhook body must never erase logical execution authority.
-- Completed claims remain compact tombstones; pending/leased authority is pinned by runtime.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';
LOCK TABLE "webhook_execution_claims" IN ACCESS EXCLUSIVE MODE;
LOCK TABLE "webhook_events" IN SHARE ROW EXCLUSIVE MODE;
-- FLAG: The live validated FK proves the same existing references. Preserve that
-- proof under both table locks; NOT VALID avoids rescanning tens of millions of
-- historical claims while still checking every new or changed reference.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint original
    WHERE original.conrelid = 'webhook_execution_claims'::regclass
      AND original.confrelid = 'webhook_events'::regclass
      AND original.conname = 'webhook_execution_claims_webhook_event_id_fkey'
      AND original.contype = 'f' AND original.convalidated
      AND original.confupdtype = 'c' AND original.confdeltype = 'c'
      AND original.confmatchtype = 's'
      AND NOT original.condeferrable AND NOT original.condeferred
      AND original.conkey = ARRAY[(
        SELECT attnum FROM pg_attribute
        WHERE attrelid = original.conrelid AND attname = 'webhook_event_id'
          AND NOT attisdropped
      )]::smallint[]
      AND original.confkey = ARRAY[(
        SELECT attnum FROM pg_attribute
        WHERE attrelid = original.confrelid AND attname = 'id'
          AND NOT attisdropped
      )]::smallint[]
  ) THEN
    RAISE EXCEPTION 'Multibot tombstone migration requires the exact validated original webhook foreign key';
  END IF;
END $$;
ALTER TABLE "webhook_execution_claims" ALTER COLUMN "webhook_event_id" DROP NOT NULL;
ALTER TABLE "webhook_execution_claims"
  DROP CONSTRAINT "webhook_execution_claims_webhook_event_id_fkey",
  ADD CONSTRAINT "webhook_execution_claims_webhook_event_id_fkey"
    FOREIGN KEY ("webhook_event_id") REFERENCES "webhook_events"("id")
    ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
COMMIT;
