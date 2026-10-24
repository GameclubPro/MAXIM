-- FLAG: Match Prisma's existing ON UPDATE CASCADE contract without rewriting history.
-- Replace and validate all three keys atomically; no rows or identifiers are changed.
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';

ALTER TABLE "stats_authorities"
  DROP CONSTRAINT "stats_authorities_entity_id_fkey",
  ADD CONSTRAINT "stats_authorities_entity_id_fkey"
    FOREIGN KEY ("entity_id") REFERENCES "stats_entities"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "stats_measurements"
  DROP CONSTRAINT "stats_measurements_entity_id_fkey",
  ADD CONSTRAINT "stats_measurements_entity_id_fkey"
    FOREIGN KEY ("entity_id") REFERENCES "stats_entities"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "stats_changes"
  DROP CONSTRAINT "stats_changes_entity_id_fkey",
  ADD CONSTRAINT "stats_changes_entity_id_fkey"
    FOREIGN KEY ("entity_id") REFERENCES "stats_entities"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
COMMIT;
