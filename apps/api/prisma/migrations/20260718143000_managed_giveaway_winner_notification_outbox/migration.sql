BEGIN;

CREATE TYPE "ManagedGiveawayWinnerNotificationStatus" AS ENUM (
  'PENDING',
  'RETRYABLE',
  'DISPATCHING',
  'SENT',
  'AMBIGUOUS',
  'FAILED_TERMINAL',
  'CANCELED'
);

CREATE TABLE "managed_giveaway_winner_notifications" (
  "id" TEXT NOT NULL,
  "winner_id" TEXT NOT NULL,
  "status" "ManagedGiveawayWinnerNotificationStatus" NOT NULL DEFAULT 'PENDING',
  "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "locked_at" TIMESTAMP(3),
  "dispatched_at" TIMESTAMP(3),
  "bot_id" TEXT,
  "remote_message_id" TEXT,
  "last_error" TEXT,
  "sent_at" TIMESTAMP(3),
  "ambiguous_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "managed_giveaway_winner_notifications_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "managed_giveaway_winner_notifications_attempt_count_check"
    CHECK ("attempt_count" >= 0),
  CONSTRAINT "managed_giveaway_winner_notifications_sent_pair_check"
    CHECK (
      ("status" = 'SENT' AND "remote_message_id" IS NOT NULL AND "sent_at" IS NOT NULL)
      OR "status" <> 'SENT'
    ),
  CONSTRAINT "managed_giveaway_winner_notifications_dispatch_check"
    CHECK ("status" <> 'DISPATCHING' OR "dispatched_at" IS NOT NULL)
);

CREATE UNIQUE INDEX "managed_giveaway_winner_notifications_winner_id_key"
ON "managed_giveaway_winner_notifications"("winner_id");

CREATE INDEX "managed_giveaway_winner_notifications_due_idx"
ON "managed_giveaway_winner_notifications"("status", "next_attempt_at", "locked_at");

CREATE INDEX "managed_giveaway_winner_notifications_stale_idx"
ON "managed_giveaway_winner_notifications"("status", "locked_at");

CREATE INDEX "managed_giveaway_winner_notifications_diagnostic_idx"
ON "managed_giveaway_winner_notifications"("status", "updated_at" DESC, "id" DESC);

ALTER TABLE "managed_giveaway_winner_notifications"
ADD CONSTRAINT "managed_giveaway_winner_notifications_winner_id_fkey"
FOREIGN KEY ("winner_id") REFERENCES "managed_giveaway_winners"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
