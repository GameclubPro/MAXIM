ALTER TABLE "managed_broadcasts"
ADD COLUMN "schedule_mode" TEXT NOT NULL DEFAULT 'legacy',
ADD COLUMN "schedule_timezone" TEXT NOT NULL DEFAULT 'Europe/Moscow';

CREATE TABLE "managed_broadcast_occurrences" (
    "id" TEXT NOT NULL,
    "broadcast_id" TEXT NOT NULL,
    "source_chat_id" TEXT NOT NULL,
    "entity_type" "ChatEntityType" NOT NULL DEFAULT 'CHAT',
    "occurrence_index" INTEGER NOT NULL,
    "scheduled_at" TIMESTAMP(3) NOT NULL,
    "status" "ManagedBroadcastStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "managed_broadcast_occurrences_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "managed_broadcast_occurrences_broadcast_occurrence_key"
ON "managed_broadcast_occurrences"("broadcast_id", "occurrence_index");

CREATE UNIQUE INDEX "managed_broadcast_occurrences_slot_key"
ON "managed_broadcast_occurrences"("source_chat_id", "entity_type", "scheduled_at");

CREATE INDEX "managed_broadcast_occurrences_status_scheduled_at_idx"
ON "managed_broadcast_occurrences"("status", "scheduled_at");

ALTER TABLE "managed_broadcast_occurrences"
ADD CONSTRAINT "managed_broadcast_occurrences_broadcast_id_fkey"
FOREIGN KEY ("broadcast_id") REFERENCES "managed_broadcasts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
