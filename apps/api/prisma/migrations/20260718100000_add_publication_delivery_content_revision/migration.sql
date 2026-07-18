ALTER TABLE "managed_broadcast_deliveries"
ADD COLUMN "content_revision_id" TEXT;

-- Old API roles remain live while production migrations run. Populate the new
-- column for their writes until every role is recreated with the new client.
CREATE OR REPLACE FUNCTION "set_publication_delivery_content_revision"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  execution_occurrence_id TEXT;
  execution_content_revision_id TEXT;
BEGIN
  IF NEW."publication_occurrence_id" IS NULL THEN
    SELECT
      broadcast."publication_occurrence_id",
      broadcast."publication_content_revision_id"
    INTO execution_occurrence_id, execution_content_revision_id
    FROM "managed_broadcasts" AS broadcast
    WHERE broadcast."id" = NEW."broadcast_id"
      AND broadcast."publication_occurrence_id" IS NOT NULL;

    IF execution_occurrence_id IS NOT NULL THEN
      NEW."publication_occurrence_id" := execution_occurrence_id;
      NEW."content_revision_id" := execution_content_revision_id;
    END IF;
  END IF;

  IF NEW."content_revision_id" IS NULL
    AND NEW."publication_occurrence_id" IS NOT NULL THEN
    SELECT occurrence."content_revision_id"
    INTO NEW."content_revision_id"
    FROM "publication_occurrences" AS occurrence
    WHERE occurrence."id" = NEW."publication_occurrence_id";
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "managed_broadcast_deliveries_content_revision_fill"
BEFORE INSERT OR UPDATE OF "broadcast_id", "publication_occurrence_id"
ON "managed_broadcast_deliveries"
FOR EACH ROW
EXECUTE FUNCTION "set_publication_delivery_content_revision"();

-- Earlier publication recovery could recreate a delivery through the legacy
-- broadcast helper without either publication attribution column.
UPDATE "managed_broadcast_deliveries" AS delivery
SET
  "publication_occurrence_id" = broadcast."publication_occurrence_id",
  "content_revision_id" = broadcast."publication_content_revision_id"
FROM "managed_broadcasts" AS broadcast
WHERE delivery."broadcast_id" = broadcast."id"
  AND delivery."publication_occurrence_id" IS NULL
  AND broadcast."publication_occurrence_id" IS NOT NULL
  AND broadcast."publication_content_revision_id" IS NOT NULL;

UPDATE "managed_broadcast_deliveries" AS delivery
SET "content_revision_id" = occurrence."content_revision_id"
FROM "publication_occurrences" AS occurrence
WHERE delivery."publication_occurrence_id" = occurrence."id"
  AND delivery."content_revision_id" IS NULL;

-- SENT and AMBIGUOUS deliveries may intentionally retain an older revision
-- after a latest-content retry. Only unsent rows must match the execution
-- broadcast revision exactly.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "managed_broadcast_deliveries" AS delivery
    INNER JOIN "managed_broadcasts" AS broadcast
      ON broadcast."id" = delivery."broadcast_id"
    WHERE broadcast."publication_occurrence_id" IS NOT NULL
      AND (
        delivery."publication_occurrence_id" IS DISTINCT FROM
          broadcast."publication_occurrence_id"
        OR delivery."content_revision_id" IS NULL
        OR (
          delivery."status" IN (
            'PENDING'::"ManagedBroadcastDeliveryStatus",
            'SENDING'::"ManagedBroadcastDeliveryStatus"
          )
          AND delivery."content_revision_id" IS DISTINCT FROM
            broadcast."publication_content_revision_id"
        )
      )
  ) THEN
    RAISE EXCEPTION 'Publication delivery attribution backfill is incomplete';
  END IF;
END;
$$;

-- FLAG: Prisma executes this multi-statement migration in one transaction. Keep
-- this index non-concurrent; CONCURRENTLY would abort the entire migration.
CREATE INDEX IF NOT EXISTS "managed_broadcast_deliveries_content_revision_idx"
ON "managed_broadcast_deliveries"("content_revision_id");

ALTER TABLE "managed_broadcast_deliveries"
ADD CONSTRAINT "managed_broadcast_deliveries_content_revision_id_fkey"
FOREIGN KEY ("content_revision_id")
REFERENCES "publication_content_revisions"("id")
ON DELETE SET NULL
ON UPDATE CASCADE
NOT VALID;

ALTER TABLE "managed_broadcast_deliveries"
VALIDATE CONSTRAINT "managed_broadcast_deliveries_content_revision_id_fkey";
