ALTER TABLE "chat_settings"
ADD COLUMN IF NOT EXISTS "delete_spammers_require_approval" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "global_spammer_candidates" (
  "user_id" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "first_detected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_detected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "detections_count" INTEGER NOT NULL DEFAULT 1,
  "last_reason" TEXT NOT NULL,
  "last_chat_id" TEXT,
  "last_evidence" JSONB,
  "last_user_label" TEXT,
  "suppressed_until" TIMESTAMP(3),
  "reviewed_at" TIMESTAMP(3),
  "reviewed_by_user_id" TEXT,
  CONSTRAINT "global_spammer_candidates_pkey" PRIMARY KEY ("user_id")
);

CREATE INDEX IF NOT EXISTS "global_spammer_candidates_status_last_detected_at_idx"
ON "global_spammer_candidates"("status", "last_detected_at" DESC);

CREATE INDEX IF NOT EXISTS "global_spammer_candidates_suppressed_until_idx"
ON "global_spammer_candidates"("suppressed_until");

CREATE TABLE IF NOT EXISTS "global_spammer_candidate_chats" (
  "candidate_user_id" TEXT NOT NULL,
  "chat_id" TEXT NOT NULL,
  "first_detected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_detected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "detections_count" INTEGER NOT NULL DEFAULT 1,
  "last_message_id" TEXT,
  "last_excerpt" TEXT,
  "last_user_label" TEXT,
  "last_evidence" JSONB,
  CONSTRAINT "global_spammer_candidate_chats_pkey" PRIMARY KEY ("candidate_user_id", "chat_id"),
  CONSTRAINT "global_spammer_candidate_chats_candidate_user_id_fkey"
    FOREIGN KEY ("candidate_user_id") REFERENCES "global_spammer_candidates"("user_id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "global_spammer_candidate_chats_chat_id_fkey"
    FOREIGN KEY ("chat_id") REFERENCES "chats"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "global_spammer_candidate_chats_chat_id_last_detected_at_idx"
ON "global_spammer_candidate_chats"("chat_id", "last_detected_at" DESC);
