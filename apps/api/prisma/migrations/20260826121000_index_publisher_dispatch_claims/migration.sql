CREATE INDEX CONCURRENTLY "publication_occurrences_dispatch_status_scheduled_idx"
ON "publication_occurrences"("dispatch_profile", "status", "scheduled_at");

CREATE INDEX CONCURRENTLY "managed_broadcasts_dispatch_status_due_lock_idx"
ON "managed_broadcasts"("dispatch_profile", "status", "next_send_at", "locked_at");

CREATE INDEX CONCURRENTLY "managed_broadcast_deliveries_dispatch_status_locked_idx"
ON "managed_broadcast_deliveries"("dispatch_profile", "status", "locked_at");
