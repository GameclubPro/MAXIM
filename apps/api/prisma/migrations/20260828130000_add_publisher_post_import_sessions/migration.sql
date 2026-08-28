CREATE TYPE "PublisherPostImportStatus" AS ENUM (
  'WAITING',
  'PROCESSING',
  'READY',
  'FAILED',
  'CANCELED',
  'EXPIRED'
);

CREATE TABLE "publisher_post_import_sessions" (
  "id" TEXT NOT NULL,
  "publisher_bot_id" TEXT NOT NULL,
  "actor_user_id" TEXT NOT NULL,
  "request_id" TEXT NOT NULL,
  "start_token" TEXT NOT NULL,
  "status" "PublisherPostImportStatus" NOT NULL DEFAULT 'WAITING',
  "private_chat_id" TEXT,
  "incoming_message_id" TEXT,
  "source_webhook_event_id" TEXT,
  "bot_status_message_id" TEXT,
  "last_notified_status" TEXT,
  "notification_kind" TEXT,
  "notification_pending" BOOLEAN NOT NULL DEFAULT false,
  "notification_locked_at" TIMESTAMP(3),
  "notification_lock_token" TEXT,
  "notification_dispatch_started_at" TIMESTAMP(3),
  "callback_id" TEXT,
  "publication_id" TEXT,
  "failure_code" TEXT,
  "omissions" JSONB NOT NULL DEFAULT '[]',
  "captured_at" TIMESTAMP(3),
  "capture_guard_until" TIMESTAMP(3),
  "locked_at" TIMESTAMP(3),
  "lock_token" TEXT,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "publisher_post_import_sessions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "publisher_post_import_sessions_publication_id_fkey"
    FOREIGN KEY ("publication_id") REFERENCES "publications"("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "publisher_post_import_sessions_start_token_key"
  ON "publisher_post_import_sessions"("start_token");
CREATE UNIQUE INDEX "publisher_post_import_sessions_publication_id_key"
  ON "publisher_post_import_sessions"("publication_id");
CREATE UNIQUE INDEX "publisher_post_import_sessions_bot_actor_request_key"
  ON "publisher_post_import_sessions"("publisher_bot_id", "actor_user_id", "request_id");
CREATE UNIQUE INDEX "publisher_post_import_sessions_bot_incoming_message_key"
  ON "publisher_post_import_sessions"("publisher_bot_id", "incoming_message_id");
CREATE UNIQUE INDEX "publisher_post_import_sessions_one_active_actor_key"
  ON "publisher_post_import_sessions"("publisher_bot_id", "actor_user_id")
  WHERE "status" IN ('WAITING', 'PROCESSING');
CREATE INDEX "publisher_post_import_sessions_actor_created_idx"
  ON "publisher_post_import_sessions"("publisher_bot_id", "actor_user_id", "created_at" DESC);
CREATE INDEX "publisher_post_import_sessions_recovery_idx"
  ON "publisher_post_import_sessions"("status", "locked_at", "updated_at");
CREATE INDEX "publisher_post_import_sessions_expiry_idx"
  ON "publisher_post_import_sessions"("status", "expires_at");
CREATE INDEX "publisher_post_import_sessions_notification_idx"
  ON "publisher_post_import_sessions"("notification_pending", "notification_locked_at", "updated_at");
