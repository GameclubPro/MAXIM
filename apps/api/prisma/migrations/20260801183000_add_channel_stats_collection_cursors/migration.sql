ALTER TABLE "channel_posts"
ADD COLUMN "view_milestone_last_attempt_at" TIMESTAMP(3);

ALTER TABLE "channel_stats_sync_states"
ADD COLUMN "last_views_discovery_at" TIMESTAMP(3),
ADD COLUMN "last_views_attempt_at" TIMESTAMP(3);
