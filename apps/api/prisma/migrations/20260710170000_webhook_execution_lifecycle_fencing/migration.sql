DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'WebhookExecutionClaimStatus') THEN
    CREATE TYPE "WebhookExecutionClaimStatus" AS ENUM ('PENDING', 'READY', 'COMPLETED');
  END IF;
END $$;

ALTER TABLE "chat_bot_memberships"
  ADD COLUMN IF NOT EXISTS "lifecycle_event_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lifecycle_event_type" TEXT,
  ADD COLUMN IF NOT EXISTS "lifecycle_source" TEXT;

ALTER TABLE "chats"
  ADD COLUMN IF NOT EXISTS "routing_version" INTEGER NOT NULL DEFAULT 0;

-- Existing terminal/access-loss rows need a watermark before the new code starts
-- accepting lifecycle reactivation events. Otherwise a delayed legacy bot_added
-- could look newer only because lifecycle_event_at is NULL.
UPDATE "chat_bot_memberships"
SET
  "lifecycle_event_at" = GREATEST(
    "bot_access_checked_at",
    "last_webhook_at",
    "last_seen_at",
    "updated_at",
    "created_at"
  ),
  "lifecycle_event_type" = CASE
    WHEN "status" = 'REMOVED' THEN 'legacy_removed'
    ELSE 'legacy_access_loss'
  END,
  "lifecycle_source" = 'migration_backfill'
WHERE "lifecycle_event_at" IS NULL
  AND (
    "status" = 'REMOVED'
    OR "bot_access_state" IN ('DENIED', 'LOST')
  );

CREATE INDEX IF NOT EXISTS "chat_bot_memberships_chat_status_lifecycle_idx"
ON "chat_bot_memberships"("chat_id", "status", "lifecycle_event_at" DESC);

CREATE TABLE IF NOT EXISTS "webhook_execution_claims" (
  "id" TEXT NOT NULL,
  "kind" TEXT NOT NULL DEFAULT 'EXECUTION',
  "semantic_key" TEXT NOT NULL,
  "webhook_event_id" TEXT NOT NULL,
  "execution_bot_id" TEXT,
  "enforced" BOOLEAN NOT NULL DEFAULT false,
  "status" "WebhookExecutionClaimStatus" NOT NULL DEFAULT 'PENDING',
  "lease_token" TEXT,
  "lease_expires_at" TIMESTAMP(3),
  "prepared_at" TIMESTAMP(3),
  "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "webhook_execution_claims_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "webhook_execution_claims_webhook_event_id_fkey"
    FOREIGN KEY ("webhook_event_id") REFERENCES "webhook_events"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "webhook_execution_claims_kind_semantic_key"
ON "webhook_execution_claims"("kind", "semantic_key");

CREATE INDEX IF NOT EXISTS "webhook_execution_claims_event_kind_idx"
ON "webhook_execution_claims"("webhook_event_id", "kind");

CREATE INDEX IF NOT EXISTS "webhook_execution_claims_status_lease_idx"
ON "webhook_execution_claims"("status", "lease_expires_at");
