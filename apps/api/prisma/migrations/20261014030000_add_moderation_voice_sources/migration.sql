-- FLAG: Empty additive evidence table only; no historical voice or receipt is enrolled.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
CREATE TABLE "moderation_voice_sources" (
  "chat_id" TEXT NOT NULL,
  "message_id" TEXT NOT NULL,
  "user_id" TEXT,
  "source_at" TIMESTAMP(3),
  "deadline_at" TIMESTAMP(3),
  "receipt_id" TEXT,
  "invalidated_at" TIMESTAMP(3),
  "expires_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "moderation_voice_sources_pkey" PRIMARY KEY ("chat_id", "message_id"),
  CONSTRAINT "moderation_voice_source_evidence_check" CHECK (
    ("user_id" IS NOT NULL AND "source_at" IS NOT NULL AND "deadline_at" IS NOT NULL
      AND "receipt_id" IS NOT NULL AND "deadline_at" - "source_at" = INTERVAL '5 minutes'
      AND "expires_at" > "deadline_at")
    OR ("user_id" IS NULL AND "source_at" IS NULL AND "deadline_at" IS NULL
      AND "receipt_id" IS NULL AND "invalidated_at" IS NOT NULL)
  )
);
CREATE INDEX "moderation_voice_sources_expiry_idx"
  ON "moderation_voice_sources" ("expires_at", "chat_id", "message_id");
COMMIT;
