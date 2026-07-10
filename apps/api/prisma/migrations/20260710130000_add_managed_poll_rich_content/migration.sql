ALTER TABLE "managed_polls"
  ADD COLUMN "question_format" TEXT NOT NULL DEFAULT 'plain',
  ADD COLUMN "image_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "images" JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE "managed_polls"
  ADD CONSTRAINT "managed_polls_question_format_check"
  CHECK ("question_format" IN ('plain', 'markdown')) NOT VALID,
  ADD CONSTRAINT "managed_polls_image_count_check"
  CHECK ("image_count" BETWEEN 0 AND 10) NOT VALID;

ALTER TABLE "managed_polls"
  VALIDATE CONSTRAINT "managed_polls_question_format_check",
  VALIDATE CONSTRAINT "managed_polls_image_count_check";
