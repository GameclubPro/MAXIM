BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE "publisher_comment_notification_preferences" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "bot_id" TEXT NOT NULL,
  "entity_type" "ChatEntityType" NOT NULL,
  "chat_id" TEXT NOT NULL DEFAULT '',
  "thread_id" TEXT NOT NULL DEFAULT '',
  "user_id" TEXT NOT NULL,
  "mode" "DialogNotificationMode" NOT NULL,
  "explicit" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "publisher_comment_notify_preference_scope_check" CHECK ("chat_id" <> '' OR "thread_id" = '')
);
CREATE UNIQUE INDEX "publisher_comment_notify_preference_key" ON "publisher_comment_notification_preferences" ("bot_id", "entity_type", "chat_id", "thread_id", "user_id");
CREATE INDEX "publisher_comment_notify_preference_fanout_idx" ON "publisher_comment_notification_preferences" ("bot_id", "entity_type", "chat_id", "thread_id", "id");
CREATE INDEX "publisher_comment_notify_preference_user_idx" ON "publisher_comment_notification_preferences" ("bot_id", "user_id", "entity_type", "chat_id");

CREATE TABLE "publisher_comment_notification_events" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "bot_id" TEXT NOT NULL,
  "chat_id" TEXT NOT NULL,
  "entity_type" "ChatEntityType" NOT NULL,
  "thread_id" TEXT NOT NULL,
  "author_user_id" TEXT NOT NULL,
  "reply_to_id" TEXT,
  "cursor" TEXT,
  "expanded" BOOLEAN NOT NULL DEFAULT false,
  "completed" BOOLEAN NOT NULL DEFAULT false,
  "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "lock_token" TEXT,
  "locked_until" TIMESTAMP(3)
);
CREATE INDEX "publisher_comment_notify_event_ready_idx" ON "publisher_comment_notification_events" ("bot_id", "completed", "available_at", "id");
CREATE INDEX "publisher_comment_notify_event_retention_idx" ON "publisher_comment_notification_events" ("completed", "expires_at", "id");

CREATE TABLE "publisher_comment_notification_deliveries" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "event_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "send_started_at" TIMESTAMP(3),
  "message_id" TEXT,
  "error_code" TEXT,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "publisher_comment_notify_delivery_status_check" CHECK ("status" IN ('PENDING', 'SENDING', 'SENT', 'SKIPPED', 'FAILED', 'UNKNOWN')),
  CONSTRAINT "publisher_comment_notify_delivery_event_fk" FOREIGN KEY ("event_id") REFERENCES "publisher_comment_notification_events" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "publisher_comment_notify_delivery_key" ON "publisher_comment_notification_deliveries" ("event_id", "user_id");
CREATE INDEX "publisher_comment_notify_delivery_ready_idx" ON "publisher_comment_notification_deliveries" ("event_id", "status", "available_at", "id");
COMMIT;
