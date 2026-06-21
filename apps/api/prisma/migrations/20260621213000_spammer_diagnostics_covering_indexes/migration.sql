-- Cover the lazy full spammer-diagnostics observation probe.
-- The existing key index is kept for now; drop/merge only after pg_stat confirms
-- the covering index carries the diagnostics workload without regressions.

CREATE INDEX IF NOT EXISTS "spammer_observations_user_diagnostics_cover_idx"
  ON "spammer_observations" ("user_id", "observed_at" DESC)
  INCLUDE (
    "id",
    "source",
    "score",
    "confidence_level",
    "reason",
    "chat_id",
    "expires_at",
    "suppressed_at"
  );
