ALTER TABLE "channel_posts"
ADD COLUMN "views_at_24h" INTEGER,
ADD COLUMN "views_at_24h_captured_at" TIMESTAMP(3),
ADD COLUMN "views_at_48h" INTEGER,
ADD COLUMN "views_at_48h_captured_at" TIMESTAMP(3);

WITH recent_posts AS (
  SELECT
    posts."id",
    posts."published_at"
  FROM "channel_posts" AS posts
  WHERE posts."published_at" >= CURRENT_TIMESTAMP - INTERVAL '30 days'
),
milestones AS (
  -- Legacy zero snapshots cannot distinguish a reported zero from a missing MAX stat.
  SELECT
    posts."id" AS "channel_post_id",
    CASE WHEN snapshot_24h."views" > 0 THEN snapshot_24h."views" END AS "views_at_24h",
    CASE
      WHEN snapshot_24h."views" > 0 THEN snapshot_24h."captured_at"
    END AS "views_at_24h_captured_at",
    CASE WHEN snapshot_48h."views" > 0 THEN snapshot_48h."views" END AS "views_at_48h",
    CASE
      WHEN snapshot_48h."views" > 0 THEN snapshot_48h."captured_at"
    END AS "views_at_48h_captured_at"
  FROM recent_posts AS posts
  LEFT JOIN LATERAL (
    SELECT snapshots."views", snapshots."captured_at"
    FROM "channel_post_view_snapshots" AS snapshots
    WHERE snapshots."channel_post_id" = posts."id"
      AND snapshots."captured_at" >= posts."published_at" + INTERVAL '24 hours'
      AND snapshots."captured_at" <= posts."published_at" + INTERVAL '27 hours'
    ORDER BY snapshots."captured_at" ASC, snapshots."id" ASC
    LIMIT 1
  ) AS snapshot_24h ON TRUE
  LEFT JOIN LATERAL (
    SELECT snapshots."views", snapshots."captured_at"
    FROM "channel_post_view_snapshots" AS snapshots
    WHERE snapshots."channel_post_id" = posts."id"
      AND snapshots."captured_at" >= posts."published_at" + INTERVAL '48 hours'
      AND snapshots."captured_at" <= posts."published_at" + INTERVAL '51 hours'
    ORDER BY snapshots."captured_at" ASC, snapshots."id" ASC
    LIMIT 1
  ) AS snapshot_48h ON TRUE
)
UPDATE "channel_posts" AS posts
SET
  "views_at_24h" = milestones."views_at_24h",
  "views_at_24h_captured_at" = milestones."views_at_24h_captured_at",
  "views_at_48h" = milestones."views_at_48h",
  "views_at_48h_captured_at" = milestones."views_at_48h_captured_at"
FROM milestones
WHERE posts."id" = milestones."channel_post_id"
  AND (
    milestones."views_at_24h" IS NOT NULL
    OR milestones."views_at_48h" IS NOT NULL
  );

CREATE INDEX CONCURRENTLY "channel_posts_24h_milestone_due_idx"
ON "channel_posts"("views_at_24h", "published_at", "chat_id", "id");

CREATE INDEX CONCURRENTLY "channel_posts_48h_milestone_due_idx"
ON "channel_posts"("views_at_48h", "published_at", "chat_id", "id");
