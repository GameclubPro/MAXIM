-- Optimize spammer review list, diagnostics, and metrics lookups.

CREATE INDEX IF NOT EXISTS "global_spammer_candidates_status_confidence_detected_idx"
  ON "global_spammer_candidates" ("status", "confidence_score" DESC, "last_detected_at" DESC);

CREATE INDEX IF NOT EXISTS "global_spammer_candidates_chat_status_confidence_idx"
  ON "global_spammer_candidates" ("last_chat_id", "status", "confidence_score" DESC, "last_detected_at" DESC);

CREATE INDEX IF NOT EXISTS "global_spammer_candidate_chats_chat_candidate_idx"
  ON "global_spammer_candidate_chats" ("chat_id", "candidate_user_id");

INSERT INTO "global_spammer_candidate_chats" (
  "candidate_user_id",
  "chat_id",
  "detections_count",
  "last_message_id",
  "last_excerpt",
  "last_user_label",
  "last_evidence",
  "first_detected_at",
  "last_detected_at"
)
SELECT
  "user_id",
  "last_chat_id",
  GREATEST("detections_count", 1),
  NULL,
  NULL,
  "last_user_label",
  "last_evidence",
  "first_detected_at",
  "last_detected_at"
FROM "global_spammer_candidates"
WHERE "last_chat_id" IS NOT NULL
ON CONFLICT ("candidate_user_id", "chat_id") DO UPDATE
SET
  "detections_count" = GREATEST(
    "global_spammer_candidate_chats"."detections_count",
    EXCLUDED."detections_count"
  ),
  "last_user_label" = COALESCE(
    EXCLUDED."last_user_label",
    "global_spammer_candidate_chats"."last_user_label"
  ),
  "last_evidence" = COALESCE(
    EXCLUDED."last_evidence",
    "global_spammer_candidate_chats"."last_evidence"
  ),
  "last_detected_at" = GREATEST(
    "global_spammer_candidate_chats"."last_detected_at",
    EXCLUDED."last_detected_at"
  );

CREATE INDEX IF NOT EXISTS "spammer_observations_user_observed_at_idx"
  ON "spammer_observations" ("user_id", "observed_at" DESC);

CREATE INDEX IF NOT EXISTS "spammer_observations_chat_observed_source_idx"
  ON "spammer_observations" ("chat_id", "observed_at" DESC, "source");

CREATE INDEX IF NOT EXISTS "spammer_observations_chat_suppressed_source_idx"
  ON "spammer_observations" ("chat_id", "suppressed_at" DESC, "source");

CREATE INDEX IF NOT EXISTS "spammer_observations_observed_source_idx"
  ON "spammer_observations" ("observed_at" DESC, "source");

CREATE INDEX IF NOT EXISTS "spammer_observations_suppressed_source_idx"
  ON "spammer_observations" ("suppressed_at" DESC, "source");

CREATE INDEX IF NOT EXISTS "spammer_campaign_members_chat_last_idx"
  ON "spammer_campaign_cluster_members" ("chat_id", "last_seen_at" DESC);

CREATE INDEX IF NOT EXISTS "spammer_campaign_members_chat_cluster_idx"
  ON "spammer_campaign_cluster_members" ("chat_id", "cluster_id");

CREATE INDEX IF NOT EXISTS "spammer_graph_signals_user_observed_idx"
  ON "spammer_graph_signals" ("user_id", "observed_at" DESC);

CREATE INDEX IF NOT EXISTS "global_spammer_shadow_scores_chat_promote_created_idx"
  ON "global_spammer_shadow_scores" ("chat_id", "would_promote", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "global_spammer_shadow_scores_unreviewed_user_idx"
  ON "global_spammer_shadow_scores" ("user_id", "created_at" DESC)
  WHERE "human_review_outcome" IS NULL;
