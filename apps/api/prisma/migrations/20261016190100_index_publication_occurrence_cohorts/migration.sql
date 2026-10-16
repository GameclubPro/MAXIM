-- FLAG: Retained publication history remains writable during this additive index build.
SET lock_timeout = '5s';
SET statement_timeout = '1800s';
CREATE INDEX CONCURRENTLY "publication_occurrences_dispatch_status_created_id_idx"
ON "publication_occurrences" ("dispatch_profile", "status", "created_at", "id");
RESET statement_timeout;
RESET lock_timeout;
