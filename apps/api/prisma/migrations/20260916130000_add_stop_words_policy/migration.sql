SET lock_timeout = '5s';
SET statement_timeout = '30s';

ALTER TABLE "chat_settings"
  ADD COLUMN "stop_words_policy" JSONB,
  ADD COLUMN "stop_words_media" JSONB,
  ADD COLUMN "stop_words_revision" INTEGER NOT NULL DEFAULT 0;
