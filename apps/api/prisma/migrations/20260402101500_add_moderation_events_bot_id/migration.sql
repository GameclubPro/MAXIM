ALTER TABLE "moderation_events"
ADD COLUMN "bot_id" TEXT;

CREATE INDEX "moderation_events_bot_id_created_at_idx"
ON "moderation_events" ("bot_id", "created_at" DESC);
