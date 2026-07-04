ALTER TABLE "chat_participant_moderation_immunities"
  ALTER COLUMN "expires_at" DROP NOT NULL,
  ALTER COLUMN "daily_violation_limit" DROP NOT NULL;

DO $$
BEGIN
  ALTER TABLE "chat_participant_moderation_immunities"
    ADD CONSTRAINT "chat_participant_moderation_immunities_mode_shape_check"
    CHECK (
      ("expires_at" IS NULL AND "daily_violation_limit" IS NULL)
      OR ("expires_at" IS NOT NULL AND "daily_violation_limit" IS NOT NULL)
    );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
