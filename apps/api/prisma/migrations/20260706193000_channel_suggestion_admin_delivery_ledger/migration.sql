DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type
    WHERE typname = 'ChannelSuggestionAdminDeliveryStatus'
  ) THEN
    CREATE TYPE "ChannelSuggestionAdminDeliveryStatus" AS ENUM (
      'PENDING',
      'SENDING',
      'SENT',
      'FAILED',
      'AMBIGUOUS'
    );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "channel_suggestion_admin_deliveries" (
  "id" TEXT NOT NULL,
  "audit_log_id" TEXT NOT NULL,
  "admin_user_id" TEXT NOT NULL,
  "bot_key" TEXT NOT NULL,
  "bot_id" TEXT,
  "private_chat_id" TEXT,
  "status" "ChannelSuggestionAdminDeliveryStatus" NOT NULL DEFAULT 'PENDING',
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "remote_message_id" TEXT,
  "last_error" TEXT,
  "last_status_code" INTEGER,
  "last_error_code" TEXT,
  "terminal" BOOLEAN NOT NULL DEFAULT FALSE,
  "sent_at" TIMESTAMP(3),
  "locked_at" TIMESTAMP(3),
  "lock_token" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "channel_suggestion_admin_deliveries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "channel_suggestion_admin_deliveries_scope_key"
ON "channel_suggestion_admin_deliveries"("audit_log_id", "admin_user_id", "bot_key");

CREATE INDEX IF NOT EXISTS "channel_suggestion_admin_deliveries_audit_status_idx"
ON "channel_suggestion_admin_deliveries"("audit_log_id", "status");

CREATE INDEX IF NOT EXISTS "channel_suggestion_admin_deliveries_status_locked_idx"
ON "channel_suggestion_admin_deliveries"("status", "locked_at");

ALTER TABLE "channel_suggestion_admin_deliveries"
  ADD CONSTRAINT "channel_suggestion_admin_deliveries_attempt_count_check"
  CHECK ("attempt_count" >= 0) NOT VALID;

ALTER TABLE "channel_suggestion_admin_deliveries"
  ADD CONSTRAINT "channel_suggestion_admin_deliveries_sending_lock_check"
  CHECK ("status" <> 'SENDING' OR "locked_at" IS NOT NULL) NOT VALID;

ALTER TABLE "channel_suggestion_admin_deliveries"
  ADD CONSTRAINT "channel_suggestion_admin_deliveries_sent_state_check"
  CHECK (
    "status" <> 'SENT'
    OR ("sent_at" IS NOT NULL AND "remote_message_id" IS NOT NULL)
  ) NOT VALID;

ALTER TABLE "channel_suggestion_admin_deliveries"
  ADD CONSTRAINT "channel_suggestion_admin_deliveries_bot_key_check"
  CHECK (BTRIM("bot_key") <> '') NOT VALID;

ALTER TABLE "channel_suggestion_admin_deliveries"
  VALIDATE CONSTRAINT "channel_suggestion_admin_deliveries_attempt_count_check";

ALTER TABLE "channel_suggestion_admin_deliveries"
  VALIDATE CONSTRAINT "channel_suggestion_admin_deliveries_sending_lock_check";

ALTER TABLE "channel_suggestion_admin_deliveries"
  VALIDATE CONSTRAINT "channel_suggestion_admin_deliveries_sent_state_check";

ALTER TABLE "channel_suggestion_admin_deliveries"
  VALIDATE CONSTRAINT "channel_suggestion_admin_deliveries_bot_key_check";

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'channel_suggestion_admin_deliveries_audit_log_id_fkey'
  ) THEN
    ALTER TABLE "channel_suggestion_admin_deliveries"
    ADD CONSTRAINT "channel_suggestion_admin_deliveries_audit_log_id_fkey"
    FOREIGN KEY ("audit_log_id") REFERENCES "audit_logs"("id") ON DELETE CASCADE ON UPDATE CASCADE
    NOT VALID;
  END IF;
END $$;
