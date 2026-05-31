ALTER TABLE "spammer_observations"
ADD COLUMN IF NOT EXISTS "normalized_features" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN IF NOT EXISTS "ttl_days" INTEGER NOT NULL DEFAULT 14,
ADD COLUMN IF NOT EXISTS "explain_reason" TEXT NOT NULL DEFAULT '',
ADD COLUMN IF NOT EXISTS "privacy_class" TEXT NOT NULL DEFAULT 'STANDARD',
ADD COLUMN IF NOT EXISTS "raw_evidence_expires_at" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "spammer_observations_privacy_raw_expiry_idx"
ON "spammer_observations"("privacy_class", "raw_evidence_expires_at");

ALTER TABLE "global_spammer_enforcement_decisions"
ADD COLUMN IF NOT EXISTS "policy_band" TEXT NOT NULL DEFAULT 'LOW',
ADD COLUMN IF NOT EXISTS "shadow_score" DOUBLE PRECISION,
ADD COLUMN IF NOT EXISTS "campaign_breakdown" JSONB;

CREATE TABLE IF NOT EXISTS "spammer_campaign_clusters" (
  "id" TEXT NOT NULL,
  "cluster_key" TEXT NOT NULL,
  "signal_type" TEXT NOT NULL,
  "signal_hash" TEXT NOT NULL,
  "signal_value_preview" TEXT,
  "status" TEXT NOT NULL DEFAULT 'SUSPECTED',
  "confidence_score" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_observation_id" TEXT,
  "distinct_users_count" INTEGER NOT NULL DEFAULT 1,
  "distinct_chats_count" INTEGER NOT NULL DEFAULT 0,
  "observations_count" INTEGER NOT NULL DEFAULT 1,
  "source_breakdown" JSONB NOT NULL DEFAULT '{}',
  "reviewed_at" TIMESTAMP(3),
  "reviewed_by_user_id" TEXT,
  "review_reason" TEXT,
  "expires_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "spammer_campaign_clusters_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "spammer_campaign_clusters_cluster_key_key"
ON "spammer_campaign_clusters"("cluster_key");

CREATE UNIQUE INDEX IF NOT EXISTS "spammer_campaign_clusters_type_hash_key"
ON "spammer_campaign_clusters"("signal_type", "signal_hash");

CREATE INDEX IF NOT EXISTS "spammer_campaign_clusters_status_confidence_idx"
ON "spammer_campaign_clusters"("status", "confidence_score");

CREATE INDEX IF NOT EXISTS "spammer_campaign_clusters_last_seen_idx"
ON "spammer_campaign_clusters"("last_seen_at" DESC);

CREATE INDEX IF NOT EXISTS "spammer_campaign_clusters_expires_at_idx"
ON "spammer_campaign_clusters"("expires_at");

CREATE TABLE IF NOT EXISTS "spammer_campaign_cluster_members" (
  "cluster_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "chat_id" TEXT,
  "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "observations_count" INTEGER NOT NULL DEFAULT 1,
  "last_observation_id" TEXT,
  "last_source" TEXT NOT NULL,
  "last_reason" TEXT NOT NULL,
  "last_score" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "member_score" DOUBLE PRECISION NOT NULL DEFAULT 0,
  CONSTRAINT "spammer_campaign_cluster_members_pkey" PRIMARY KEY ("cluster_id", "user_id"),
  CONSTRAINT "spammer_campaign_cluster_members_cluster_id_fkey"
    FOREIGN KEY ("cluster_id") REFERENCES "spammer_campaign_clusters"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "spammer_campaign_members_user_last_idx"
ON "spammer_campaign_cluster_members"("user_id", "last_seen_at" DESC);

CREATE INDEX IF NOT EXISTS "spammer_campaign_members_cluster_score_idx"
ON "spammer_campaign_cluster_members"("cluster_id", "member_score");

CREATE TABLE IF NOT EXISTS "global_spammer_shadow_scores" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "chat_id" TEXT,
  "message_id" TEXT,
  "observation_id" TEXT,
  "trigger" TEXT NOT NULL,
  "current_score" DOUBLE PRECISION NOT NULL,
  "v2_score" DOUBLE PRECISION NOT NULL,
  "score_delta" DOUBLE PRECISION NOT NULL,
  "current_band" TEXT NOT NULL,
  "v2_band" TEXT NOT NULL,
  "would_promote" BOOLEAN NOT NULL DEFAULT false,
  "would_suppress" BOOLEAN NOT NULL DEFAULT false,
  "human_review_outcome" TEXT,
  "reviewed_at" TIMESTAMP(3),
  "reviewed_by_user_id" TEXT,
  "source_breakdown" JSONB NOT NULL DEFAULT '{}',
  "campaign_breakdown" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "global_spammer_shadow_scores_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "global_spammer_shadow_scores_user_created_idx"
ON "global_spammer_shadow_scores"("user_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "global_spammer_shadow_scores_chat_created_idx"
ON "global_spammer_shadow_scores"("chat_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "global_spammer_shadow_scores_band_created_idx"
ON "global_spammer_shadow_scores"("v2_band", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "global_spammer_shadow_scores_promote_created_idx"
ON "global_spammer_shadow_scores"("would_promote", "created_at" DESC);

CREATE TABLE IF NOT EXISTS "global_spammer_review_feedback" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "chat_id" TEXT,
  "reviewer_user_id" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "candidate_status_before" TEXT,
  "confidence_score_before" DOUBLE PRECISION,
  "source_breakdown" JSONB,
  "campaign_breakdown" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "global_spammer_review_feedback_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "global_spammer_review_feedback_user_created_idx"
ON "global_spammer_review_feedback"("user_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "global_spammer_review_feedback_chat_created_idx"
ON "global_spammer_review_feedback"("chat_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "global_spammer_review_feedback_action_created_idx"
ON "global_spammer_review_feedback"("action", "created_at" DESC);
