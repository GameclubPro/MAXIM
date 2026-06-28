ALTER TABLE "managed_broadcasts"
  ADD COLUMN "lock_token" TEXT;

ALTER TABLE "managed_broadcast_deliveries"
  ADD COLUMN "lock_token" TEXT,
  ADD COLUMN "legacy_sent_without_remote_id" BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE "managed_broadcast_calendar_reservations" (
  "id" TEXT NOT NULL,
  "broadcast_id" TEXT NOT NULL,
  "source_chat_id" TEXT NOT NULL,
  "entity_type" "ChatEntityType" NOT NULL DEFAULT 'CHAT',
  "occurrence_index" INTEGER NOT NULL,
  "target_chat_id" TEXT NOT NULL,
  "scheduled_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "managed_broadcast_calendar_reservations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "managed_broadcast_calendar_reservations_target_slot_key"
ON "managed_broadcast_calendar_reservations"("entity_type", "target_chat_id", "scheduled_at");

CREATE INDEX "managed_broadcast_calendar_res_broadcast_occ_idx"
ON "managed_broadcast_calendar_reservations"("broadcast_id", "occurrence_index");

CREATE INDEX "managed_broadcast_calendar_res_source_slot_idx"
ON "managed_broadcast_calendar_reservations"("source_chat_id", "entity_type", "scheduled_at");

ALTER TABLE "managed_broadcast_calendar_reservations"
ADD CONSTRAINT "managed_broadcast_calendar_reservations_broadcast_id_fkey"
FOREIGN KEY ("broadcast_id") REFERENCES "managed_broadcasts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "managed_broadcast_idempotency_records" (
  "id" TEXT NOT NULL,
  "request_id" TEXT NOT NULL,
  "request_hash" TEXT NOT NULL,
  "source_chat_id" TEXT NOT NULL,
  "entity_type" "ChatEntityType" NOT NULL DEFAULT 'CHAT',
  "actor_user_id" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "broadcast_id" TEXT,
  "result" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "managed_broadcast_idempotency_records_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "managed_broadcast_idempotency_scope_key"
ON "managed_broadcast_idempotency_records"("source_chat_id", "entity_type", "actor_user_id", "request_id");

CREATE INDEX "managed_broadcast_idempotency_created_at_idx"
ON "managed_broadcast_idempotency_records"("created_at");

ALTER TABLE "managed_broadcast_idempotency_records"
ADD CONSTRAINT "managed_broadcast_idempotency_records_broadcast_id_fkey"
FOREIGN KEY ("broadcast_id") REFERENCES "managed_broadcasts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

INSERT INTO "managed_broadcast_calendar_reservations" (
  "id",
  "broadcast_id",
  "source_chat_id",
  "entity_type",
  "occurrence_index",
  "target_chat_id",
  "scheduled_at",
  "created_at"
)
SELECT
  md5(random()::text || clock_timestamp()::text || occurrence.id || target.chat_id),
  occurrence.broadcast_id,
  occurrence.source_chat_id,
  occurrence.entity_type,
  occurrence.occurrence_index,
  target.chat_id,
  occurrence.scheduled_at,
  occurrence.created_at
FROM "managed_broadcast_occurrences" occurrence
JOIN "managed_broadcasts" broadcast ON broadcast.id = occurrence.broadcast_id
CROSS JOIN LATERAL jsonb_array_elements_text(broadcast.target_chat_ids::jsonb) AS target(chat_id)
WHERE occurrence.status IN ('ACTIVE', 'PARTIAL', 'FAILED')
  AND broadcast.status IN ('ACTIVE', 'PARTIAL', 'FAILED')
ON CONFLICT ("entity_type", "target_chat_id", "scheduled_at") DO NOTHING;

UPDATE "managed_broadcast_deliveries"
SET "legacy_sent_without_remote_id" = TRUE
WHERE "status" = 'SENT'
  AND "remote_message_id" IS NULL;

UPDATE "managed_broadcasts"
SET
  "cycle_count" = GREATEST("cycle_count", 1, "sent_count"),
  "cycle_every_hours" = GREATEST("cycle_every_hours", 1),
  "sent_count" = GREATEST("sent_count", 0)
WHERE "cycle_count" < 1
   OR "cycle_every_hours" < 1
   OR "sent_count" < 0
   OR "sent_count" > "cycle_count";

ALTER TABLE "managed_broadcast_deliveries"
  DROP CONSTRAINT IF EXISTS "managed_broadcast_deliveries_sent_state_check";

ALTER TABLE "managed_broadcast_deliveries"
  ADD CONSTRAINT "managed_broadcast_deliveries_sent_state_check"
  CHECK (
    "status" <> 'SENT'
    OR (
      "sent_at" IS NOT NULL
      AND (
        "remote_message_id" IS NOT NULL
        OR "legacy_sent_without_remote_id" = TRUE
      )
    )
  ) NOT VALID;

ALTER TABLE "managed_broadcasts"
  ADD CONSTRAINT "managed_broadcasts_schedule_numbers_check"
  CHECK (
    "cycle_count" >= 1
    AND "cycle_every_hours" >= 1
    AND "sent_count" >= 0
    AND "sent_count" <= "cycle_count"
  ) NOT VALID;

ALTER TABLE "managed_broadcast_deliveries"
  VALIDATE CONSTRAINT "managed_broadcast_deliveries_attempt_count_check";

ALTER TABLE "managed_broadcast_deliveries"
  VALIDATE CONSTRAINT "managed_broadcast_deliveries_sending_lock_check";

ALTER TABLE "managed_broadcast_deliveries"
  VALIDATE CONSTRAINT "managed_broadcast_deliveries_sent_state_check";

ALTER TABLE "managed_broadcasts"
  VALIDATE CONSTRAINT "managed_broadcasts_schedule_numbers_check";
