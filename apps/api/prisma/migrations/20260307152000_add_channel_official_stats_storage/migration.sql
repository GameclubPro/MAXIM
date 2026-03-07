CREATE TABLE "channel_audience_snapshots" (
  "id" TEXT NOT NULL,
  "chat_id" TEXT NOT NULL,
  "participants_count" INTEGER,
  "status" TEXT,
  "is_public" BOOLEAN,
  "link" TEXT,
  "last_event_at" TIMESTAMP(3),
  "captured_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "channel_audience_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "channel_posts" (
  "id" TEXT NOT NULL,
  "chat_id" TEXT NOT NULL,
  "message_id" TEXT NOT NULL,
  "published_at" TIMESTAMP(3) NOT NULL,
  "url" TEXT,
  "latest_views" INTEGER NOT NULL DEFAULT 0,
  "latest_snapshot_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "channel_posts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "channel_post_view_snapshots" (
  "id" TEXT NOT NULL,
  "channel_post_id" TEXT NOT NULL,
  "views" INTEGER NOT NULL,
  "captured_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "channel_post_view_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "channel_stats_sync_states" (
  "id" TEXT NOT NULL,
  "chat_id" TEXT NOT NULL,
  "views_coverage_from" TIMESTAMP(3),
  "membership_coverage_from" TIMESTAMP(3),
  "last_audience_sync_at" TIMESTAMP(3),
  "last_views_sync_at" TIMESTAMP(3),
  "last_opportunistic_sync_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "channel_stats_sync_states_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "channel_posts_chat_id_message_id_key"
ON "channel_posts"("chat_id", "message_id");

CREATE UNIQUE INDEX "channel_stats_sync_states_chat_id_key"
ON "channel_stats_sync_states"("chat_id");

CREATE INDEX "channel_audience_snapshots_chat_id_captured_at_idx"
ON "channel_audience_snapshots"("chat_id", "captured_at" DESC);

CREATE INDEX "channel_posts_chat_id_published_at_idx"
ON "channel_posts"("chat_id", "published_at" DESC);

CREATE INDEX "channel_posts_chat_id_latest_snapshot_at_idx"
ON "channel_posts"("chat_id", "latest_snapshot_at" DESC);

CREATE INDEX "channel_post_view_snapshots_channel_post_id_captured_at_idx"
ON "channel_post_view_snapshots"("channel_post_id", "captured_at" DESC);

CREATE INDEX "channel_post_view_snapshots_captured_at_idx"
ON "channel_post_view_snapshots"("captured_at");

CREATE INDEX "webhook_events_channel_membership_created_idx"
ON "webhook_events" (((normalized_payload->'message'->>'chatId')), "created_at")
WHERE (normalized_payload->>'type' IN ('user_added', 'user_removed'));

ALTER TABLE "channel_audience_snapshots"
ADD CONSTRAINT "channel_audience_snapshots_chat_id_fkey"
FOREIGN KEY ("chat_id") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "channel_posts"
ADD CONSTRAINT "channel_posts_chat_id_fkey"
FOREIGN KEY ("chat_id") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "channel_post_view_snapshots"
ADD CONSTRAINT "channel_post_view_snapshots_channel_post_id_fkey"
FOREIGN KEY ("channel_post_id") REFERENCES "channel_posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "channel_stats_sync_states"
ADD CONSTRAINT "channel_stats_sync_states_chat_id_fkey"
FOREIGN KEY ("chat_id") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;
