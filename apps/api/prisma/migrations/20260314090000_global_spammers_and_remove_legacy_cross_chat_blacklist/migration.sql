ALTER TABLE "chat_settings"
  ADD COLUMN IF NOT EXISTS "delete_spammers_enabled" BOOLEAN NOT NULL DEFAULT false,
  DROP COLUMN IF EXISTS "global_cross_chat_spam_enabled",
  DROP COLUMN IF EXISTS "global_user_blacklist_enabled";

DROP TABLE IF EXISTS "global_user_blacklist";

CREATE TABLE IF NOT EXISTS "global_spammers" (
  "user_id" TEXT NOT NULL,
  "first_detected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_detected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "detections_count" INTEGER NOT NULL DEFAULT 1,
  "last_reason" TEXT NOT NULL,
  "last_chat_id" TEXT,
  "last_evidence" JSONB,
  CONSTRAINT "global_spammers_pkey" PRIMARY KEY ("user_id")
);

CREATE INDEX IF NOT EXISTS "global_spammers_last_detected_at_idx"
ON "global_spammers"("last_detected_at" DESC);
