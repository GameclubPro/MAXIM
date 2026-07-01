CREATE TYPE "DialogNotificationScope" AS ENUM ('CHANNEL', 'ALL_CHANNELS');

ALTER TABLE "dialog_notification_subscriptions"
  ADD COLUMN "explicit" BOOLEAN;

UPDATE "dialog_notification_subscriptions"
  SET "explicit" = CASE WHEN "mode" = 'REPLIES' THEN false ELSE true END;

ALTER TABLE "dialog_notification_subscriptions"
  ALTER COLUMN "explicit" SET DEFAULT true,
  ALTER COLUMN "explicit" SET NOT NULL;

CREATE TABLE "dialog_notification_preferences" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "entity_type" "ChatEntityType" NOT NULL DEFAULT 'CHAT',
  "scope" "DialogNotificationScope" NOT NULL,
  "target_key" TEXT NOT NULL DEFAULT '',
  "chat_id" TEXT,
  "mode" "DialogNotificationMode" NOT NULL DEFAULT 'OFF',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "dialog_notification_preferences_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "dialog_notification_preferences"
  ADD CONSTRAINT "dialog_notification_preferences_chat_id_fkey"
  FOREIGN KEY ("chat_id") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "dialog_notification_preferences_user_scope_target_key"
  ON "dialog_notification_preferences"("user_id", "entity_type", "scope", "target_key");

CREATE INDEX "dialog_notification_preferences_scope_target_mode_idx"
  ON "dialog_notification_preferences"("entity_type", "scope", "target_key", "mode");

CREATE INDEX "dialog_notification_preferences_user_updated_idx"
  ON "dialog_notification_preferences"("user_id", "updated_at");

CREATE INDEX "dialog_notification_preferences_chat_scope_mode_idx"
  ON "dialog_notification_preferences"("chat_id", "scope", "mode");
