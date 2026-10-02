BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
-- FLAG: Schedule metadata never grants access or rewrites existing bindings.
ALTER TABLE "publisher_entity_bindings"
  ADD COLUMN "roster_checked_at" TIMESTAMP(3),
  ADD COLUMN "roster_refresh_after" TIMESTAMP(3);
COMMIT;
