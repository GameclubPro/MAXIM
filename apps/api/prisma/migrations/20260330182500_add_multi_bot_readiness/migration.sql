ALTER TABLE "chats"
  ADD COLUMN "bot_id" TEXT;

CREATE INDEX "chats_bot_id_idx"
  ON "chats"("bot_id");

ALTER TABLE "webhook_events"
  ADD COLUMN "bot_id" TEXT,
  ADD COLUMN "queue_name" TEXT;

CREATE INDEX "webhook_events_bot_id_status_created_at_idx"
  ON "webhook_events"("bot_id", "status", "created_at");
