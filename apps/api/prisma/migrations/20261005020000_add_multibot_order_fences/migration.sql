-- FLAG: Record this effects cutoff only after old webhook ingress and consumers stop.
-- The large webhook columns/indexes were prepared online by the immutable earlier prefix.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE "webhook_execution_claims" ADD COLUMN "command_result" JSONB;
ALTER TABLE "webhook_execution_claims" ADD COLUMN "business_started_at" TIMESTAMP(3);
ALTER TABLE "chats"
  ADD COLUMN "chat_control_order_at" TIMESTAMP(3),
  ADD COLUMN "chat_control_order_key" TEXT,
  ADD COLUMN "rules_order_at" TIMESTAMP(3),
  ADD COLUMN "rules_order_key" TEXT;
COMMIT;
