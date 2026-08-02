CREATE TABLE "channel_suggestion_image_assets" (
    "id" TEXT NOT NULL,
    "audit_log_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "bytes" BYTEA,
    "durable_payload" JSONB,
    "mime_type" TEXT,
    "file_name" TEXT,
    "size_bytes" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "channel_suggestion_image_assets_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "channel_suggestion_image_assets_position_check" CHECK ("position" >= 0),
    CONSTRAINT "channel_suggestion_image_assets_storage_check" CHECK (
        (
            "bytes" IS NOT NULL
            AND OCTET_LENGTH("bytes") > 0
            AND "durable_payload" IS NULL
            AND "size_bytes" = OCTET_LENGTH("bytes")
        )
        OR
        (
            "bytes" IS NULL
            AND "durable_payload" IS NOT NULL
            AND JSONB_TYPEOF("durable_payload") = 'object'
            AND "durable_payload" <> '{}'::jsonb
            AND "size_bytes" IS NULL
        )
    )
);

ALTER TABLE "channel_suggestion_image_assets"
ADD CONSTRAINT "channel_suggestion_image_assets_audit_log_id_fkey"
FOREIGN KEY ("audit_log_id") REFERENCES "audit_logs"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
