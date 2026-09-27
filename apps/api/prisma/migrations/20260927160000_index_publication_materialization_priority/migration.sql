SET lock_timeout = '5s';
SET statement_timeout = '120s';

CREATE INDEX CONCURRENTLY "publication_occurrences_ready_dispatch_idx"
ON "publication_occurrences"("dispatch_profile", "status", "dispatch_blocker_code", "scheduled_at", "id");

CREATE INDEX CONCURRENTLY "publication_occurrences_blocked_dispatch_idx"
ON "publication_occurrences"("dispatch_profile", "status", "dispatch_blocked_at", "scheduled_at", "id");
