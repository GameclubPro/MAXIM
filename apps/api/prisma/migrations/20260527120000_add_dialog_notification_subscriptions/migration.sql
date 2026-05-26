CREATE TYPE "DialogNotificationMode" AS ENUM ('OFF', 'REPLIES', 'ALL');

CREATE TABLE "dialog_notification_subscriptions" (
  "id" TEXT NOT NULL,
  "chat_id" TEXT NOT NULL,
  "entity_type" "ChatEntityType" NOT NULL DEFAULT 'CHAT',
  "thread_id" TEXT NOT NULL DEFAULT '',
  "user_id" TEXT NOT NULL,
  "mode" "DialogNotificationMode" NOT NULL DEFAULT 'REPLIES',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "dialog_notification_subscriptions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "dialog_notification_subscriptions_entity_chat_thread_user_key"
  ON "dialog_notification_subscriptions"("entity_type", "chat_id", "thread_id", "user_id");

CREATE INDEX "dialog_notification_subscriptions_thread_mode_idx"
  ON "dialog_notification_subscriptions"("chat_id", "entity_type", "thread_id", "mode");

CREATE INDEX "dialog_notification_subscriptions_user_updated_idx"
  ON "dialog_notification_subscriptions"("user_id", "updated_at");

ALTER TABLE "dialog_notification_subscriptions"
  ADD CONSTRAINT "dialog_notification_subscriptions_chat_id_fkey"
  FOREIGN KEY ("chat_id") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;
