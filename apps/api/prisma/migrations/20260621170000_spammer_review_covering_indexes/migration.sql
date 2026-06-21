-- Cover hot spammer-review candidate list probes without cold heap reads.

CREATE INDEX IF NOT EXISTS "global_spammer_candidate_chats_chat_candidate_detected_cover_idx"
  ON "global_spammer_candidate_chats" ("chat_id", "candidate_user_id")
  INCLUDE ("last_detected_at");

CREATE INDEX IF NOT EXISTS "global_spammer_candidates_chat_status_rank_cover_idx"
  ON "global_spammer_candidates" (
    "last_chat_id",
    "status",
    "confidence_score" DESC,
    "last_detected_at" DESC,
    "user_id"
  );
