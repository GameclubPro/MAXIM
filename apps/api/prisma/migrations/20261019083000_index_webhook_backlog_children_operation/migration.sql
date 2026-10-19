-- FLAG: Build this additive retained-history index online before any cancellation stop.
-- Do not use IF NOT EXISTS: an interrupted or mismatched index must fail for reviewed repair.
SET lock_timeout = '5s';
SET statement_timeout = '600s';
SET maintenance_work_mem = '128MB';
SET max_parallel_maintenance_workers = 0;
SET temp_file_limit = '512MB';
CREATE INDEX CONCURRENTLY "webhook_backlog_children_operation_idx"
ON "public"."webhook_backlog_children" ("cancellation_id", "kind", "child_key");
RESET temp_file_limit;
RESET max_parallel_maintenance_workers;
RESET maintenance_work_mem;
RESET statement_timeout;
RESET lock_timeout;
