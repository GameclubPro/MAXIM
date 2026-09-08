SET lock_timeout = '5s';
SET statement_timeout = '30s';

ALTER TABLE "channel_settings"
  ADD COLUMN "quick_buttons_enabled" BOOLEAN NOT NULL DEFAULT false;
