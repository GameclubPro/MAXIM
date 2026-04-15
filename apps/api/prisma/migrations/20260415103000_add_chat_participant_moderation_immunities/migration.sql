CREATE TABLE IF NOT EXISTS "chat_participant_moderation_immunities" (
  "id" TEXT NOT NULL,
  "chat_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "daily_violation_limit" INTEGER NOT NULL,
  "daily_violation_usage" INTEGER NOT NULL DEFAULT 0,
  "usage_date_key" TEXT,
  "created_by_user_id" TEXT,
  "updated_by_user_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "chat_participant_moderation_immunities_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "chat_participant_moderation_immunities_chat_id_user_id_key"
ON "chat_participant_moderation_immunities"("chat_id", "user_id");

CREATE INDEX IF NOT EXISTS "chat_participant_moderation_immunities_chat_id_expires_at_idx"
ON "chat_participant_moderation_immunities"("chat_id", "expires_at");

DO $$
BEGIN
  ALTER TABLE "chat_participant_moderation_immunities"
    ADD CONSTRAINT "chat_participant_moderation_immunities_chat_id_fkey"
    FOREIGN KEY ("chat_id")
    REFERENCES "chats"("id")
    ON DELETE CASCADE
    ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
