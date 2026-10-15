-- Presentation evidence only; existing rows remain unknown until a targeted read succeeds.
SET lock_timeout = '5s';
ALTER TABLE "managed_bot_chat_catalog"
  ADD COLUMN "avatar_state" TEXT,
  ADD COLUMN "metadata_observed_at" TIMESTAMP(3);
