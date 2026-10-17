-- FLAG: Prepare this retained-history index online before pausing application workers.
-- The fixed supervised runner preserves failed receipts and partial indexes on interruption.
SET lock_timeout = '5s';
SET statement_timeout = '600s';
SET maintenance_work_mem = '128MB';
SET max_parallel_maintenance_workers = 0;
SET temp_file_limit = '512MB';
CREATE INDEX CONCURRENTLY "managed_broadcast_deliveries_dispatch_status_created_id_idx"
ON "public"."managed_broadcast_deliveries" ("dispatch_profile", "status", "created_at", "id");
RESET temp_file_limit;
RESET max_parallel_maintenance_workers;
RESET maintenance_work_mem;
RESET statement_timeout;
RESET lock_timeout;
