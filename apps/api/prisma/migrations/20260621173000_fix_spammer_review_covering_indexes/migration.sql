-- Replace the broad candidate covering index: PostgreSQL can prefer it as a
-- status-only scan for the chat-edge branch. Keep indexes constrained to the
-- exact predicates used by the spammer review list query.

DROP INDEX IF EXISTS "global_spammer_candidates_chat_status_rank_cover_idx";

CREATE INDEX IF NOT EXISTS "global_spammer_candidates_user_status_rank_cover_idx"
  ON "global_spammer_candidates" ("user_id", "status")
  INCLUDE ("confidence_score", "last_detected_at");

CREATE INDEX IF NOT EXISTS "global_spammer_candidates_last_chat_status_rank_cover_idx"
  ON "global_spammer_candidates" (
    "last_chat_id",
    "status",
    "confidence_score" DESC,
    "last_detected_at" DESC
  )
  INCLUDE ("user_id");
