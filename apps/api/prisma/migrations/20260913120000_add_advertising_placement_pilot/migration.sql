BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE "advertising_placements" (
  "chat_id" TEXT PRIMARY KEY CHECK ("chat_id" ~ '^-[1-9][0-9]{0,19}$'),
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "listing_id" UUID,
  "revision" INTEGER NOT NULL DEFAULT 0 CHECK ("revision" >= 0),
  "last_send_id" UUID,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CHECK (NOT "enabled" OR "listing_id" IS NOT NULL)
);
CREATE TABLE "advertising_placement_sends" (
  "id" UUID PRIMARY KEY,
  "chat_id" TEXT NOT NULL REFERENCES "advertising_placements"("chat_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "listing_id" UUID NOT NULL,
  "settings_revision" INTEGER NOT NULL CHECK ("settings_revision" > 0),
  "status" TEXT NOT NULL DEFAULT 'SENDING' CHECK ("status" IN ('SENDING','SENT','FAILED','UNCERTAIN')),
  "remote_message_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ("status" <> 'SENT' OR "remote_message_id" IS NOT NULL)
);
CREATE INDEX "advertising_placement_sends_chat_id_created_at_idx" ON "advertising_placement_sends"("chat_id", "created_at");
COMMIT;
