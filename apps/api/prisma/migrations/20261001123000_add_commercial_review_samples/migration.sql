-- FLAG: Sanitized quality feedback is isolated from global-spammer reputation and sanctions.
CREATE TABLE "commercial_review_samples" (
  "id" TEXT NOT NULL,
  "chat_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "message_id" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "evidence_hash" TEXT NOT NULL,
  "score" DOUBLE PRECISION NOT NULL,
  "evidence" JSONB NOT NULL,
  "label" TEXT,
  "review_priority" INTEGER NOT NULL DEFAULT 50,
  "observed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "commercial_review_samples_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "commercial_review_samples_source_check" CHECK ("source" IN ('TEXT', 'OCR')),
  CONSTRAINT "commercial_review_samples_label_check" CHECK ("label" IS NULL OR "label" IN ('COMMERCIAL', 'NOT_COMMERCIAL', 'UNSURE')),
  CONSTRAINT "commercial_review_samples_priority_check" CHECK ("review_priority" BETWEEN 0 AND 100),
  CONSTRAINT "commercial_review_samples_chat_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "commercial_review_samples_evidence_hash_key" ON "commercial_review_samples"("evidence_hash");
CREATE INDEX "commercial_review_samples_queue_idx" ON "commercial_review_samples"("label", "review_priority" DESC, "observed_at" DESC, "id" DESC);
CREATE INDEX "commercial_review_samples_all_queue_idx" ON "commercial_review_samples"("review_priority" DESC, "observed_at" DESC, "id" DESC);
CREATE INDEX "commercial_review_samples_expiry_idx" ON "commercial_review_samples"("expires_at", "id");
