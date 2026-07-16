BEGIN;

CREATE TYPE "ModerationDeleteIntentStatus" AS ENUM (
  'OBSERVED',
  'PENDING',
  'IN_PROGRESS',
  'RETRYABLE',
  'WAITING_CAPABILITY',
  'AMBIGUOUS',
  'SUCCEEDED',
  'ALREADY_ABSENT',
  'EXPIRED',
  'FAILED_TERMINAL'
);

CREATE TABLE "moderation_delete_intents" (
  "id" TEXT NOT NULL,
  "chat_id" TEXT NOT NULL,
  "message_id" TEXT NOT NULL,
  "subject_user_id" TEXT,
  "source_message_at" TIMESTAMP(3),
  "entity_type" "ChatEntityType",
  "message_author_kind" TEXT,
  "origin_bot_id" TEXT,
  "routing_policy" TEXT NOT NULL DEFAULT 'origin_only',
  "status" "ModerationDeleteIntentStatus" NOT NULL DEFAULT 'PENDING',
  "execute_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "retry_until_at" TIMESTAMP(3) NOT NULL,
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "last_bot_id" TEXT,
  "succeeded_bot_id" TEXT,
  "delete_dispatch_started_at" TIMESTAMP(3),
  "delete_dispatch_started_bot_id" TEXT,
  "remote_delete_succeeded_at" TIMESTAMP(3),
  "remote_delete_succeeded_bot_id" TEXT,
  "candidate_failures" JSONB NOT NULL DEFAULT '{}',
  "last_status_code" INTEGER,
  "last_error_code" TEXT,
  "last_error" TEXT,
  "first_attempt_at" TIMESTAMP(3),
  "last_attempt_at" TIMESTAMP(3),
  "completed_at" TIMESTAMP(3),
  "absence_verified_at" TIMESTAMP(3),
  "absence_verified_bot_id" TEXT,
  "absence_verification_code" TEXT,
  "lease_token" TEXT,
  "lease_expires_at" TIMESTAMP(3),
  "leased_from_status" "ModerationDeleteIntentStatus",
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "moderation_delete_intents_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "moderation_delete_intents_retry_window_check"
    CHECK ("retry_until_at" >= "execute_at"),
  CONSTRAINT "moderation_delete_intents_attempt_count_check"
    CHECK ("attempt_count" >= 0),
  CONSTRAINT "moderation_delete_intents_routing_policy_check"
    CHECK ("routing_policy" IN ('delete_capable', 'origin_first', 'origin_only')),
  CONSTRAINT "moderation_delete_intents_author_kind_check"
    CHECK ("message_author_kind" IS NULL OR "message_author_kind" IN ('user', 'bot')),
  CONSTRAINT "moderation_delete_intents_candidate_failures_check"
    CHECK (jsonb_typeof("candidate_failures") = 'object'),
  CONSTRAINT "moderation_delete_intents_lease_pair_check"
    CHECK (("lease_token" IS NULL) = ("lease_expires_at" IS NULL)),
  CONSTRAINT "moderation_delete_intents_dispatch_pair_check"
    CHECK (
      ("delete_dispatch_started_at" IS NULL) =
      ("delete_dispatch_started_bot_id" IS NULL)
    ),
  CONSTRAINT "moderation_delete_intents_remote_success_pair_check"
    CHECK (
      ("remote_delete_succeeded_at" IS NULL) =
      ("remote_delete_succeeded_bot_id" IS NULL)
    )
);

CREATE TABLE "moderation_delete_intent_reasons" (
  "id" TEXT NOT NULL,
  "intent_id" TEXT NOT NULL,
  "reason_key" TEXT NOT NULL,
  "user_id" TEXT,
  "event_type" "EventType",
  "rule_code" TEXT NOT NULL,
  "masked_excerpt" TEXT,
  "score" DOUBLE PRECISION NOT NULL DEFAULT 1,
  "metadata" JSONB,
  "moderation_event_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "moderation_delete_intent_reasons_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "moderation_delete_intents_chat_message_key"
ON "moderation_delete_intents"("chat_id", "message_id");

CREATE INDEX "moderation_delete_intents_due_idx"
ON "moderation_delete_intents"("status", "next_attempt_at", "execute_at");

CREATE INDEX "moderation_delete_intents_lease_idx"
ON "moderation_delete_intents"("status", "lease_expires_at");

CREATE INDEX "moderation_delete_intents_retention_idx"
ON "moderation_delete_intents"("status", "updated_at");

CREATE INDEX "moderation_delete_intents_chat_status_created_idx"
ON "moderation_delete_intents"("chat_id", "status", "created_at");

CREATE UNIQUE INDEX "moderation_delete_intent_reasons_intent_reason_key"
ON "moderation_delete_intent_reasons"("intent_id", "reason_key");

CREATE UNIQUE INDEX "moderation_delete_intent_reasons_event_id_key"
ON "moderation_delete_intent_reasons"("moderation_event_id");

CREATE INDEX "moderation_delete_intent_reasons_event_idx"
ON "moderation_delete_intent_reasons"("intent_id", "moderation_event_id");

ALTER TABLE "moderation_delete_intents"
ADD CONSTRAINT "moderation_delete_intents_chat_id_fkey"
FOREIGN KEY ("chat_id") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "moderation_delete_intent_reasons"
ADD CONSTRAINT "moderation_delete_intent_reasons_intent_id_fkey"
FOREIGN KEY ("intent_id") REFERENCES "moderation_delete_intents"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
