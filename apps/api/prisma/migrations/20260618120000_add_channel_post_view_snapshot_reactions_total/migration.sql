ALTER TABLE "channel_post_view_snapshots"
  ADD COLUMN "reactions_total" INTEGER NOT NULL DEFAULT 0;

UPDATE "channel_post_view_snapshots" AS snapshots
SET "reactions_total" = GREATEST(posts."latest_reactions_total", 0)
FROM "channel_posts" AS posts
WHERE snapshots."channel_post_id" = posts."id";
