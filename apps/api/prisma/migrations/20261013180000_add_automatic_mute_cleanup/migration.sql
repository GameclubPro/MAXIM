-- FLAG: Additive outbox only. No historical mute is enrolled and no retained webhook is scanned.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
CREATE TABLE "automatic_mute_cleanups" (
  "event_id" TEXT PRIMARY KEY REFERENCES "moderation_events"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "chat_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "source_message_id" TEXT NOT NULL,
  "origin_bot_id" TEXT,
  "window_start" TIMESTAMP(3) NOT NULL,
  "window_end" TIMESTAMP(3) NOT NULL,
  "deadline_at" TIMESTAMP(3) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lease_token" TEXT,
  "cursor_created_at" TIMESTAMP(3),
  "cursor_id" TEXT,
  "scanned_receipts" INTEGER NOT NULL DEFAULT 0,
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "last_error_code" TEXT,
  "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "automatic_mute_cleanup_window_check" CHECK (
    "window_end" - "window_start" = INTERVAL '30 minutes'
    AND "deadline_at" - "window_end" = INTERVAL '30 minutes'
  ),
  CONSTRAINT "automatic_mute_cleanup_status_check" CHECK ("status" IN ('PENDING', 'SCANNED', 'CANCELLED', 'EXPIRED')),
  CONSTRAINT "automatic_mute_cleanup_cursor_check" CHECK (("cursor_created_at" IS NULL) = ("cursor_id" IS NULL))
);
CREATE INDEX "automatic_mute_cleanup_due_idx" ON "automatic_mute_cleanups" ("status", "next_attempt_at", "event_id");
CREATE INDEX "automatic_mute_cleanup_retention_idx" ON "automatic_mute_cleanups" ("status", "completed_at", "event_id");
COMMIT;
