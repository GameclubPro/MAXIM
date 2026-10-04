-- FLAG: Historical labels remain untouched; only distinct trusted reviewers provide independent evidence.
ALTER TABLE "commercial_review_samples"
  ADD COLUMN "quality_metadata" JSONB,
  ADD COLUMN "independent_label" TEXT,
  ADD COLUMN "independent_review_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "review_state" TEXT NOT NULL DEFAULT 'UNREVIEWED';
ALTER TABLE "commercial_review_samples"
  ADD CONSTRAINT "commercial_review_samples_independent_label_check" CHECK ("independent_label" IS NULL OR "independent_label" IN ('COMMERCIAL', 'NOT_COMMERCIAL', 'UNSURE')) NOT VALID,
  ADD CONSTRAINT "commercial_review_samples_review_count_check" CHECK ("independent_review_count" BETWEEN 0 AND 2) NOT VALID,
  ADD CONSTRAINT "commercial_review_samples_review_state_check" CHECK ("review_state" IN ('UNREVIEWED', 'AWAITING_SECOND', 'DISAGREEMENT', 'RESOLVED')) NOT VALID;
CREATE TABLE "commercial_review_ratings" (
  "id" TEXT NOT NULL,
  "sample_id" TEXT NOT NULL,
  "reviewer_key" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "expected_disposition" TEXT,
  "evidence_kind" TEXT NOT NULL,
  "source_evidence_digest" TEXT,
  "reason" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "commercial_review_ratings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "commercial_review_ratings_sample_id_fkey" FOREIGN KEY ("sample_id") REFERENCES "commercial_review_samples"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "commercial_review_ratings_reviewer_key_check" CHECK ("reviewer_key" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "commercial_review_ratings_kind_check" CHECK ("kind" IN ('INDEPENDENT', 'ADJUDICATION')),
  CONSTRAINT "commercial_review_ratings_label_check" CHECK ("label" IN ('COMMERCIAL', 'NOT_COMMERCIAL', 'UNSURE')),
  CONSTRAINT "commercial_review_ratings_disposition_check" CHECK ("expected_disposition" IS NULL OR "expected_disposition" IN ('KEEP', 'DELETE')),
  CONSTRAINT "commercial_review_ratings_evidence_check" CHECK ("evidence_kind" IN ('TEXT', 'CAPTION_ONLY', 'PRIVATE_SOURCE_IMAGE')),
  CONSTRAINT "commercial_review_ratings_caption_check" CHECK ("evidence_kind" <> 'CAPTION_ONLY' OR ("label" = 'UNSURE' AND "expected_disposition" IS NULL)),
  CONSTRAINT "commercial_review_ratings_image_digest_check" CHECK ("evidence_kind" <> 'PRIVATE_SOURCE_IMAGE' OR ("source_evidence_digest" IS NOT NULL AND "source_evidence_digest" ~ '^[a-f0-9]{64}$')),
  CONSTRAINT "commercial_review_ratings_keep_check" CHECK ("label" <> 'NOT_COMMERCIAL' OR "expected_disposition" IS NULL OR "expected_disposition" = 'KEEP'),
  CONSTRAINT "commercial_review_ratings_uncertain_check" CHECK ("label" <> 'UNSURE' OR "expected_disposition" IS NULL)
);
CREATE UNIQUE INDEX "commercial_review_ratings_sample_reviewer_key" ON "commercial_review_ratings"("sample_id", "reviewer_key");
CREATE INDEX "commercial_review_ratings_sample_kind_idx" ON "commercial_review_ratings"("sample_id", "kind", "created_at");
CREATE UNIQUE INDEX "commercial_review_ratings_one_adjudication_key" ON "commercial_review_ratings"("sample_id") WHERE "kind" = 'ADJUDICATION';
