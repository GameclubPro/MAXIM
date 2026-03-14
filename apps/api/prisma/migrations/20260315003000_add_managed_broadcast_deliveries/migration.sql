ALTER TYPE "ManagedBroadcastStatus" ADD VALUE IF NOT EXISTS 'PARTIAL';

CREATE TYPE "ManagedBroadcastDeliveryStatus" AS ENUM ('PENDING', 'SENDING', 'SENT', 'FAILED', 'CANCELED');

CREATE TABLE "managed_broadcast_deliveries" (
    "id" TEXT NOT NULL,
    "broadcast_id" TEXT NOT NULL,
    "occurrence_index" INTEGER NOT NULL,
    "target_chat_id" TEXT NOT NULL,
    "status" "ManagedBroadcastDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "sent_at" TIMESTAMP(3),
    "locked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "managed_broadcast_deliveries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "managed_broadcast_deliveries_broadcast_occurrence_target_key"
ON "managed_broadcast_deliveries"("broadcast_id", "occurrence_index", "target_chat_id");

CREATE INDEX "managed_broadcast_deliveries_broadcast_occurrence_status_idx"
ON "managed_broadcast_deliveries"("broadcast_id", "occurrence_index", "status");

CREATE INDEX "managed_broadcast_deliveries_status_locked_at_idx"
ON "managed_broadcast_deliveries"("status", "locked_at");

ALTER TABLE "managed_broadcast_deliveries"
ADD CONSTRAINT "managed_broadcast_deliveries_broadcast_id_fkey"
FOREIGN KEY ("broadcast_id") REFERENCES "managed_broadcasts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "managed_broadcast_deliveries" (
    "id",
    "broadcast_id",
    "occurrence_index",
    "target_chat_id",
    "status",
    "attempt_count",
    "last_error",
    "sent_at",
    "locked_at",
    "created_at",
    "updated_at"
)
SELECT
    md5(random()::text || clock_timestamp()::text || mb.id || occurrence.idx::text || target.chat_id),
    mb.id,
    occurrence.idx,
    target.chat_id,
    CASE
        WHEN occurrence.idx <= mb.sent_count THEN 'SENT'::"ManagedBroadcastDeliveryStatus"
        WHEN mb.status = 'CANCELED' THEN 'CANCELED'::"ManagedBroadcastDeliveryStatus"
        WHEN mb.status = 'FAILED' THEN 'FAILED'::"ManagedBroadcastDeliveryStatus"
        ELSE 'PENDING'::"ManagedBroadcastDeliveryStatus"
    END,
    CASE
        WHEN occurrence.idx <= mb.sent_count THEN 1
        WHEN mb.status = 'FAILED' THEN 1
        ELSE 0
    END,
    CASE
        WHEN mb.status = 'FAILED' AND occurrence.idx = LEAST(mb.sent_count + 1, GREATEST(mb.cycle_count, 1)) THEN mb.last_error
        ELSE NULL
    END,
    CASE
        WHEN occurrence.idx <= mb.sent_count THEN mb.updated_at
        ELSE NULL
    END,
    NULL,
    mb.created_at,
    mb.updated_at
FROM "managed_broadcasts" mb
CROSS JOIN LATERAL generate_series(1, GREATEST(mb.cycle_count, 1)) AS occurrence(idx)
CROSS JOIN LATERAL jsonb_array_elements_text(mb.target_chat_ids::jsonb) AS target(chat_id);
