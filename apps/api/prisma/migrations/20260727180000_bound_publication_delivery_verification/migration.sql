CREATE TYPE "PublicationDeliveryVerificationSource" AS ENUM (
  'AUTOMATED_STABLE',
  'MANUAL_CONFIRMED',
  'LEGACY_SINGLE_OBSERVATION'
);

ALTER TABLE "managed_broadcast_deliveries"
ADD COLUMN "remote_message_verification_attempt_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "remote_message_verification_absent_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "remote_message_verification_present_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "remote_message_verification_attempted_at" TIMESTAMP(3),
ADD COLUMN "remote_message_verification_next_at" TIMESTAMP(3),
ADD COLUMN "remote_message_verification_last_error" TEXT,
ADD COLUMN "remote_message_verification_source" "PublicationDeliveryVerificationSource",
ADD COLUMN "last_error_code" TEXT;

ALTER TABLE "chat_bot_memberships"
ADD COLUMN "send_route_failure_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "send_route_quarantined_until" TIMESTAMP(3),
ADD COLUMN "send_route_last_failure_at" TIMESTAMP(3),
ADD COLUMN "send_route_last_failure_code" TEXT,
ADD COLUMN "send_route_last_success_at" TIMESTAMP(3);
