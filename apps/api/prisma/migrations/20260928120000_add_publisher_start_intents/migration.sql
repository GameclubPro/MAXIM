BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE "publisher_start_intents" (
  "id" TEXT PRIMARY KEY,
  "publisher_bot_id" TEXT NOT NULL,
  "private_chat_id" TEXT NOT NULL,
  "requested_at" TIMESTAMP(3) NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "next_enqueue_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "publisher_start_intents_status_check"
    CHECK ("status" IN ('PENDING', 'ATTEMPTED', 'SENT', 'UNKNOWN', 'EXPIRED'))
);
CREATE INDEX "publisher_start_intents_due_idx"
  ON "publisher_start_intents" ("status", "next_enqueue_at", "id");
COMMIT;
