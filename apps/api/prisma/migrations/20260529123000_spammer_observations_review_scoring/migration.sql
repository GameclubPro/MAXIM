ALTER TABLE "global_spammers"
ADD COLUMN IF NOT EXISTS "confidence_score" DOUBLE PRECISION NOT NULL DEFAULT 1,
ADD COLUMN IF NOT EXISTS "confirmed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN IF NOT EXISTS "expires_at" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "source_breakdown" JSONB NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS "global_spammers_expires_at_idx"
ON "global_spammers"("expires_at");

ALTER TABLE "global_spammer_candidates"
ADD COLUMN IF NOT EXISTS "confidence_score" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS "source_breakdown" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN IF NOT EXISTS "review_reason" TEXT,
ADD COLUMN IF NOT EXISTS "false_positive" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS "global_spammer_candidates_confidence_score_idx"
ON "global_spammer_candidates"("confidence_score");

CREATE TABLE IF NOT EXISTS "spammer_observations" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "score" DOUBLE PRECISION NOT NULL,
  "confidence_level" TEXT NOT NULL DEFAULT 'LOW',
  "reason" TEXT NOT NULL,
  "chat_id" TEXT,
  "message_id" TEXT,
  "evidence_hash" TEXT NOT NULL,
  "evidence" JSONB,
  "observed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "suppressed_at" TIMESTAMP(3),
  "suppression_reason" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "spammer_observations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "spammer_observations_chat_id_fkey"
    FOREIGN KEY ("chat_id") REFERENCES "chats"("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "spammer_observations_user_source_evidence_key"
ON "spammer_observations"("user_id", "source", "evidence_hash");

CREATE INDEX IF NOT EXISTS "spammer_observations_user_expires_at_idx"
ON "spammer_observations"("user_id", "expires_at");

CREATE INDEX IF NOT EXISTS "spammer_observations_source_observed_at_idx"
ON "spammer_observations"("source", "observed_at" DESC);

CREATE INDEX IF NOT EXISTS "spammer_observations_expires_at_idx"
ON "spammer_observations"("expires_at");

CREATE INDEX IF NOT EXISTS "spammer_observations_suppressed_at_idx"
ON "spammer_observations"("suppressed_at");

CREATE TABLE IF NOT EXISTS "global_spammer_suppressions" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "admin_user_id" TEXT,
  "source_chat_id" TEXT,
  "suppressed_until" TIMESTAMP(3) NOT NULL,
  "evidence" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "global_spammer_suppressions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "global_spammer_suppressions_user_until_idx"
ON "global_spammer_suppressions"("user_id", "suppressed_until");

CREATE INDEX IF NOT EXISTS "global_spammer_suppressions_source_created_at_idx"
ON "global_spammer_suppressions"("source", "created_at" DESC);
