ALTER TABLE "vk_parsing_sources"
  ADD COLUMN IF NOT EXISTS "import_enabled" BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS "auto_publish_enabled" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "auto_publish_enabled_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "auto_publish_paused_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "auto_publish_paused_reason" TEXT,
  ADD COLUMN IF NOT EXISTS "publish_interval_minutes" INTEGER NOT NULL DEFAULT 60,
  ADD COLUMN IF NOT EXISTS "daily_limit" INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS "min_publish_interval_minutes" INTEGER NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS "publish_mode" TEXT NOT NULL DEFAULT 'QUEUE',
  ADD COLUMN IF NOT EXISTS "priority" TEXT NOT NULL DEFAULT 'NORMAL',
  ADD COLUMN IF NOT EXISTS "quiet_hours_start" TEXT,
  ADD COLUMN IF NOT EXISTS "quiet_hours_end" TEXT,
  ADD COLUMN IF NOT EXISTS "last_auto_published_at" TIMESTAMP(3);

UPDATE "vk_parsing_sources"
SET "import_enabled" = ("status" = 'ACTIVE')
WHERE "import_enabled" IS DISTINCT FROM ("status" = 'ACTIVE');

ALTER TABLE "vk_parsing_settings"
  ADD COLUMN IF NOT EXISTS "auto_publish_kill_switch_enabled" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "scheduler_timezone" TEXT NOT NULL DEFAULT 'Europe/Moscow',
  ADD COLUMN IF NOT EXISTS "quiet_hours_start" TEXT,
  ADD COLUMN IF NOT EXISTS "quiet_hours_end" TEXT,
  ADD COLUMN IF NOT EXISTS "work_hours_start" TEXT NOT NULL DEFAULT '09:00',
  ADD COLUMN IF NOT EXISTS "work_hours_end" TEXT NOT NULL DEFAULT '22:00',
  ADD COLUMN IF NOT EXISTS "distribute_evenly_enabled" BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS "round_robin_enabled" BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS "circuit_breaker_enabled" BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS "circuit_breaker_window_minutes" INTEGER NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS "circuit_breaker_post_limit" INTEGER NOT NULL DEFAULT 10;

ALTER TABLE "vk_parsing_posts"
  ADD COLUMN IF NOT EXISTS "publish_scheduled_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "publish_cancelled_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "publish_cancelled_by_user_id" TEXT;

CREATE INDEX IF NOT EXISTS "vk_parsing_sources_scheduler_idx"
  ON "vk_parsing_sources"("chat_id", "status", "import_enabled", "next_sync_at");

CREATE INDEX IF NOT EXISTS "vk_parsing_posts_chat_scheduled_idx"
  ON "vk_parsing_posts"("chat_id", "publish_scheduled_at");

CREATE INDEX IF NOT EXISTS "vk_parsing_posts_source_queued_idx"
  ON "vk_parsing_posts"("source_id", "publish_queued_at");

CREATE INDEX IF NOT EXISTS "vk_parsing_posts_auto_published_idx"
  ON "vk_parsing_posts"("chat_id", "source_id", "auto_published_at");
