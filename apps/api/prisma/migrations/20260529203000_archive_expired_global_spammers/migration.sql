CREATE TABLE "global_spammer_archives" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "first_detected_at" TIMESTAMP(3) NOT NULL,
    "last_detected_at" TIMESTAMP(3) NOT NULL,
    "detections_count" INTEGER NOT NULL,
    "last_reason" TEXT NOT NULL,
    "last_chat_id" TEXT,
    "last_evidence" JSONB,
    "confidence_score" DOUBLE PRECISION NOT NULL,
    "confirmed_at" TIMESTAMP(3) NOT NULL,
    "expired_at" TIMESTAMP(3),
    "source_breakdown" JSONB NOT NULL DEFAULT '{}',
    "archive_reason" TEXT NOT NULL DEFAULT 'EXPIRED',
    "archived_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "global_spammer_archives_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "global_spammer_archives_user_expired_reason_key" ON "global_spammer_archives"("user_id", "expired_at", "archive_reason");
CREATE INDEX "global_spammer_archives_user_archived_idx" ON "global_spammer_archives"("user_id", "archived_at" DESC);
CREATE INDEX "global_spammer_archives_expired_at_idx" ON "global_spammer_archives"("expired_at");
