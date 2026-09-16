SET lock_timeout = '5s';
SET statement_timeout = '30s';

ALTER TABLE "chat_settings"
  ALTER COLUMN "stop_words_policy" SET DEFAULT '{}'::jsonb;
