BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE "moderation_delete_intents" ADD COLUMN "retention_owned" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "message_retention_quotas" (
  "shard" INTEGER PRIMARY KEY CHECK ("shard" >= 0 AND "shard" < 32),
  "pending_count" INTEGER NOT NULL DEFAULT 0 CHECK ("pending_count" BETWEEN 0 AND 62500),
  "paused_at" TIMESTAMP(3),
  "healthy_since" TIMESTAMP(3)
);
INSERT INTO "message_retention_quotas" ("shard") SELECT generate_series(0, 31);

CREATE TABLE "message_retention_policies" (
  "chat_id" TEXT PRIMARY KEY,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "hours" INTEGER NOT NULL DEFAULT 48 CHECK ("hours" IN (24, 48)),
  "revision" INTEGER NOT NULL DEFAULT 0,
  "activation_id" TEXT NOT NULL,
  "enabled_at" TIMESTAMP(3),
  "capture_after" TIMESTAMP(3),
  "paused_at" TIMESTAMP(3),
  "healthy_since" TIMESTAMP(3),
  "quota_shard" INTEGER NOT NULL CHECK ("quota_shard" >= 0 AND "quota_shard" < 32),
  "pending_count" INTEGER NOT NULL DEFAULT 0 CHECK ("pending_count" BETWEEN 0 AND 50000),
  "deleted_count" INTEGER NOT NULL DEFAULT 0,
  "skipped_count" INTEGER NOT NULL DEFAULT 0,
  "next_run_at" TIMESTAMP(3),
  "last_status" TEXT NOT NULL DEFAULT 'off',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "message_retention_candidates" (
  "chat_id" TEXT NOT NULL,
  "message_id" TEXT NOT NULL,
  "author_id" TEXT NOT NULL,
  "origin_bot_id" TEXT NOT NULL,
  "source_at" TIMESTAMP(3) NOT NULL,
  "activation_id" TEXT NOT NULL,
  "shadow_only" BOOLEAN NOT NULL DEFAULT false,
  "status" TEXT NOT NULL DEFAULT 'pending' CHECK ("status" IN ('pending', 'retry', 'deleted', 'skipped', 'cancelled')),
  "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "intent_id" TEXT,
  "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "message_retention_candidates_pkey" PRIMARY KEY ("chat_id", "message_id"),
  CONSTRAINT "message_retention_candidates_chat_id_fkey" FOREIGN KEY ("chat_id")
    REFERENCES "message_retention_policies"("chat_id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "message_retention_policies_due_idx" ON "message_retention_policies" ("next_run_at", "chat_id");
CREATE INDEX "message_retention_candidates_source_idx" ON "message_retention_candidates" ("chat_id", "status", "source_at", "message_id");
CREATE INDEX "message_retention_candidates_activation_idx" ON "message_retention_candidates" ("chat_id", "status", "activation_id", "message_id");
CREATE INDEX "message_retention_candidates_retry_idx" ON "message_retention_candidates" ("chat_id", "status", "next_attempt_at", "message_id");
CREATE INDEX "message_retention_candidates_completed_idx" ON "message_retention_candidates" ("completed_at", "chat_id", "message_id");
COMMIT;
