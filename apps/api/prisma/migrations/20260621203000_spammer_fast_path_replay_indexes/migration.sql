-- Keep fast-path denorm replay idempotent without scanning per-user shadow history.

CREATE INDEX IF NOT EXISTS "global_spammer_shadow_scores_user_observation_idx"
  ON "global_spammer_shadow_scores" ("user_id", "observation_id")
  WHERE "observation_id" IS NOT NULL;
