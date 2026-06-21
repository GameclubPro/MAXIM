-- Cover spammer-review metrics probes without reading wide candidate rows.

CREATE INDEX IF NOT EXISTS "global_spammer_candidates_user_metrics_cover_idx"
  ON "global_spammer_candidates" ("user_id")
  INCLUDE ("status", "first_detected_at", "reviewed_at", "false_positive");

CREATE INDEX IF NOT EXISTS "global_spammer_candidates_last_chat_metrics_cover_idx"
  ON "global_spammer_candidates" ("last_chat_id")
  INCLUDE ("user_id", "status", "first_detected_at", "reviewed_at", "false_positive");
