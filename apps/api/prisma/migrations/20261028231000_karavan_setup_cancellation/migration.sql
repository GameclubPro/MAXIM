BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE "karavan_marketplace_connection_operations"
  DROP CONSTRAINT "karavan_marketplace_operation_state_check",
  ADD CONSTRAINT "karavan_marketplace_operation_state_check" CHECK ("state" IN ('pending','partial','complete','unknown','rejected','cancelled')) NOT VALID;
COMMIT;
