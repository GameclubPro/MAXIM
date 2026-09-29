BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE "chat_settings"
  ADD COLUMN "duplicate_window_mode" TEXT NOT NULL DEFAULT 'INTERVAL',
  ADD COLUMN "duplicate_start_time_minutes" INTEGER NOT NULL DEFAULT 540,
  ADD COLUMN "duplicate_end_time_minutes" INTEGER NOT NULL DEFAULT 1080,
  ADD COLUMN "duplicate_timezone" TEXT NOT NULL DEFAULT 'Europe/Moscow';
COMMIT;
