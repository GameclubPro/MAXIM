ALTER TABLE "managed_broadcast_deliveries"
  ADD CONSTRAINT "managed_broadcast_deliveries_attempt_count_check"
  CHECK ("attempt_count" >= 0) NOT VALID;

ALTER TABLE "managed_broadcast_deliveries"
  ADD CONSTRAINT "managed_broadcast_deliveries_sending_lock_check"
  CHECK ("status" <> 'SENDING' OR "locked_at" IS NOT NULL) NOT VALID;

ALTER TABLE "managed_broadcast_deliveries"
  ADD CONSTRAINT "managed_broadcast_deliveries_sent_state_check"
  CHECK (
    "status" <> 'SENT'
    OR ("sent_at" IS NOT NULL AND "remote_message_id" IS NOT NULL)
  ) NOT VALID;
