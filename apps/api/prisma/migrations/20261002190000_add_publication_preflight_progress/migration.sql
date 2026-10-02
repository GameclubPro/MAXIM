-- FLAG: Additive, nullable progress only; old readers/writers remain compatible.
-- Redis acknowledgement precedes progress, and each bounded cycle wraps for queue-loss recovery.
ALTER TABLE "publication_occurrences"
  ADD COLUMN "access_preflight_position" INTEGER,
  ADD COLUMN "access_preflight_cycle_started_at" TIMESTAMP(3),
  ADD COLUMN "access_preflight_last_completed_at" TIMESTAMP(3);
