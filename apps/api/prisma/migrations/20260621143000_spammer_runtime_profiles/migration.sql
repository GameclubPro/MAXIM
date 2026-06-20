CREATE TABLE IF NOT EXISTS "spammer_user_runtime_profiles" (
  "user_id" TEXT NOT NULL,
  "registry_status" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "confidence_score" DOUBLE PRECISION,
  "shadow_score" DOUBLE PRECISION,
  "policy_band" TEXT NOT NULL DEFAULT 'LOW',
  "reason" TEXT NOT NULL,
  "expires_at" TIMESTAMP(3),
  "suppressed_until" TIMESTAMP(3),
  "source_breakdown" JSONB,
  "campaign_breakdown" JSONB,
  "source_version" INTEGER NOT NULL DEFAULT 2,
  "stale_after" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "spammer_user_runtime_profiles_pkey" PRIMARY KEY ("user_id")
);

CREATE INDEX IF NOT EXISTS "spammer_runtime_profiles_status_updated_idx"
ON "spammer_user_runtime_profiles"("registry_status", "updated_at" DESC);

CREATE INDEX IF NOT EXISTS "spammer_runtime_profiles_stale_after_idx"
ON "spammer_user_runtime_profiles"("stale_after");

INSERT INTO "spammer_user_runtime_profiles" (
  "user_id",
  "registry_status",
  "action",
  "confidence_score",
  "shadow_score",
  "policy_band",
  "reason",
  "expires_at",
  "source_breakdown",
  "source_version",
  "stale_after",
  "updated_at"
)
SELECT
  g."user_id",
  CASE
    WHEN g."expires_at" IS NOT NULL AND g."expires_at" > CURRENT_TIMESTAMP
      THEN 'ACTIVE_CONFIRMED'
    ELSE 'EXPIRED'
  END,
  CASE
    WHEN g."expires_at" IS NOT NULL AND g."expires_at" > CURRENT_TIMESTAMP
      THEN 'DELETE_AND_KICK'
    ELSE 'NONE'
  END,
  g."confidence_score",
  NULL,
  CASE
    WHEN g."expires_at" IS NOT NULL AND g."expires_at" > CURRENT_TIMESTAMP
      THEN 'CONFIRMED'
    WHEN g."confidence_score" >= 0.97
      THEN 'CONFIRMED'
    WHEN g."confidence_score" >= 0.92
      THEN 'VERY_HIGH'
    WHEN g."confidence_score" >= 0.74
      THEN 'HIGH'
    WHEN g."confidence_score" >= 0.55
      THEN 'MEDIUM'
    ELSE 'LOW'
  END,
  g."last_reason",
  g."expires_at",
  g."source_breakdown",
  2,
  g."expires_at",
  CURRENT_TIMESTAMP
FROM "global_spammers" g
ON CONFLICT ("user_id") DO UPDATE SET
  "registry_status" = EXCLUDED."registry_status",
  "action" = EXCLUDED."action",
  "confidence_score" = EXCLUDED."confidence_score",
  "shadow_score" = EXCLUDED."shadow_score",
  "policy_band" = EXCLUDED."policy_band",
  "reason" = EXCLUDED."reason",
  "expires_at" = EXCLUDED."expires_at",
  "source_breakdown" = EXCLUDED."source_breakdown",
  "source_version" = EXCLUDED."source_version",
  "stale_after" = EXCLUDED."stale_after",
  "updated_at" = CURRENT_TIMESTAMP;

INSERT INTO "spammer_user_runtime_profiles" (
  "user_id",
  "registry_status",
  "action",
  "confidence_score",
  "shadow_score",
  "policy_band",
  "reason",
  "suppressed_until",
  "source_breakdown",
  "source_version",
  "stale_after",
  "updated_at"
)
SELECT
  c."user_id",
  CASE
    WHEN c."status" = 'SUPPRESSED'
      THEN 'SUPPRESSED'
    WHEN c."status" = 'PENDING' AND c."confidence_score" >= 0.55
      THEN 'MEDIUM_REVIEW'
    ELSE 'NONE'
  END,
  'NONE',
  c."confidence_score",
  NULL,
  CASE
    WHEN c."confidence_score" >= 0.97
      THEN 'CONFIRMED'
    WHEN c."confidence_score" >= 0.92
      THEN 'VERY_HIGH'
    WHEN c."confidence_score" >= 0.74
      THEN 'HIGH'
    WHEN c."confidence_score" >= 0.55
      THEN 'MEDIUM'
    ELSE 'LOW'
  END,
  c."last_reason",
  c."suppressed_until",
  c."source_breakdown",
  2,
  c."suppressed_until",
  CURRENT_TIMESTAMP
FROM "global_spammer_candidates" c
WHERE NOT EXISTS (
  SELECT 1
  FROM "global_spammers" g
  WHERE g."user_id" = c."user_id"
)
ON CONFLICT ("user_id") DO NOTHING;
