-- FLAG: Nullable additive storage preserves legacy close-event registry readers. New
-- recovery variants require the independent-recovery reader floor before any rollback.
ALTER TABLE "night_mode_transition_scheduled_jobs"
  ADD COLUMN "recovery_payload" JSONB;
