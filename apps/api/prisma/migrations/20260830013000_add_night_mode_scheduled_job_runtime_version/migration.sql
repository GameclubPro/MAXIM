ALTER TABLE "night_mode_transition_scheduled_jobs"
  ADD COLUMN "runtime_version" INTEGER NOT NULL DEFAULT 3;

ALTER TABLE "night_mode_transition_scheduled_jobs"
  ADD CONSTRAINT "night_mode_transition_scheduled_jobs_runtime_version_check"
  CHECK ("runtime_version" BETWEEN 2 AND 4);
