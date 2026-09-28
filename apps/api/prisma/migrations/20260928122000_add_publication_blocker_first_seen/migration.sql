BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE "publication_occurrences" ADD COLUMN "dispatch_first_blocked_at" TIMESTAMP(3);
COMMIT;
