ALTER TABLE "vk_parsing_sources"
  ADD COLUMN IF NOT EXISTS "sync_status" TEXT NOT NULL DEFAULT 'IDLE',
  ADD COLUMN IF NOT EXISTS "next_sync_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "last_success_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "sync_started_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "sync_locked_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "sync_locked_by" TEXT,
  ADD COLUMN IF NOT EXISTS "sync_attempt_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "last_error_code" TEXT,
  ADD COLUMN IF NOT EXISTS "last_imported_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "last_fetched_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "last_sync_duration_ms" INTEGER;

UPDATE "vk_parsing_sources"
SET "next_sync_at" = COALESCE("next_sync_at", CURRENT_TIMESTAMP)
WHERE "status" = 'ACTIVE';

ALTER TABLE "vk_parsing_posts"
  ADD COLUMN IF NOT EXISTS "content_hash" TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "published_content_hash" TEXT,
  ADD COLUMN IF NOT EXISTS "last_seen_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "missing_since_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "unavailable_at" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "vk_parsing_media_cache" (
  "id" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'UNKNOWN',
  "mime_type" TEXT,
  "content_length" INTEGER,
  "last_checked_at" TIMESTAMP(3),
  "last_error" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "vk_parsing_media_cache_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "vk_parsing_media_cache_url_key"
  ON "vk_parsing_media_cache"("url");

CREATE INDEX IF NOT EXISTS "vk_parsing_sources_status_next_sync_at_idx"
  ON "vk_parsing_sources"("status", "next_sync_at");

CREATE INDEX IF NOT EXISTS "vk_parsing_sources_sync_status_locked_at_idx"
  ON "vk_parsing_sources"("sync_status", "sync_locked_at");

CREATE INDEX IF NOT EXISTS "vk_parsing_posts_source_last_seen_at_idx"
  ON "vk_parsing_posts"("source_id", "last_seen_at");

CREATE INDEX IF NOT EXISTS "vk_parsing_media_cache_status_checked_idx"
  ON "vk_parsing_media_cache"("status", "last_checked_at");
