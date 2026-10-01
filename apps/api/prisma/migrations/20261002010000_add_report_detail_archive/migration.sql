-- FLAG: Additive archive totals retain closed-case identity and authorization bindings.
-- Runtime deletion is separately disabled until the retention feature is explicitly enabled.
ALTER TABLE "chat_report_cases"
  ADD COLUMN "details_archived_at" TIMESTAMP(3),
  ADD COLUMN "details_archive_completed_at" TIMESTAMP(3),
  ADD COLUMN "retained_votes" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "retained_candidates" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "retained_deleted" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "retained_absent" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "retained_failed" INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT "chat_report_cases_archive_totals_bounds" CHECK (
    retained_votes >= 0 AND retained_candidates >= 0 AND retained_deleted >= 0
    AND retained_absent >= 0 AND retained_failed >= 0
    AND retained_deleted + retained_absent + retained_failed <= retained_candidates
  ) NOT VALID;

ALTER TABLE "chat_report_actions" ADD COLUMN "receipt_updated_at" TIMESTAMP(3);
