ALTER TABLE "vk_parsing_sources"
  ADD COLUMN IF NOT EXISTS "last_fetched_pages" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "last_fetched_offsets" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS "last_vk_newest_post_id" INTEGER,
  ADD COLUMN IF NOT EXISTS "last_vk_newest_published_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "adaptive_interval_ms" INTEGER;

ALTER TABLE "vk_parsing_posts"
  ADD COLUMN IF NOT EXISTS "attachment_types" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS "unsupported_attachments" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS "has_unsupported_attachments" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "is_advertising" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "advertising_markers" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS "missing_seen_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "last_availability_checked_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "publish_queued_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "publish_locked_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "publish_attempt_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "publish_idempotency_key" TEXT;

ALTER TABLE "vk_parsing_media_cache"
  ADD COLUMN IF NOT EXISTS "media_identity" TEXT,
  ADD COLUMN IF NOT EXISTS "max_upload_payload" JSONB,
  ADD COLUMN IF NOT EXISTS "max_upload_token" TEXT,
  ADD COLUMN IF NOT EXISTS "max_uploaded_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "upload_attempt_count" INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS "vk_parsing_posts_publish_idempotency_key_key"
  ON "vk_parsing_posts"("publish_idempotency_key");

CREATE INDEX IF NOT EXISTS "vk_parsing_posts_status_publish_queued_idx"
  ON "vk_parsing_posts"("status", "publish_queued_at");

CREATE INDEX IF NOT EXISTS "vk_parsing_posts_publish_locked_idx"
  ON "vk_parsing_posts"("publish_locked_at");

CREATE UNIQUE INDEX IF NOT EXISTS "vk_parsing_media_cache_media_identity_key"
  ON "vk_parsing_media_cache"("media_identity");
