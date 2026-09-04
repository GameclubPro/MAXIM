CREATE INDEX CONCURRENTLY IF NOT EXISTS "vk_parsing_posts_pending_autopublish_recovery_idx"
ON "vk_parsing_posts" (
  "source_id",
  "vk_published_at",
  "created_at",
  "id"
)
WHERE "status" = 'NEW'
  AND "publish_schedule_fingerprint" IS NOT NULL
  AND "publish_queued_at" IS NULL
  AND "publish_scheduled_at" IS NULL
  AND "publish_locked_at" IS NULL
  AND "publish_attempt_count" = 0
  AND "publish_idempotency_key" IS NULL
  AND "publish_reason" IS NULL
  AND "publish_cancelled_at" IS NULL
  AND "publish_cancelled_by_user_id" IS NULL
  AND "publish_actor_user_id" IS NULL
  AND "dispatch_blocker_code" IS NULL
  AND "dispatch_blocked_at" IS NULL;
