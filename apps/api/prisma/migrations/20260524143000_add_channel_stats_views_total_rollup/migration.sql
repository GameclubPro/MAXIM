ALTER TABLE "channel_stats_bucket_rollups"
ADD COLUMN IF NOT EXISTS "views_total" INTEGER NOT NULL DEFAULT 0;

INSERT INTO "channel_stats_bucket_rollups" (
  "chat_id",
  "bucket_start",
  "views_total",
  "updated_at"
)
SELECT
  "chat_id",
  date_trunc('hour', "published_at")::TIMESTAMP(3) AS "bucket_start",
  COALESCE(SUM(GREATEST("latest_views", 0)), 0)::INTEGER AS "views_total",
  CURRENT_TIMESTAMP
FROM "channel_posts"
GROUP BY "chat_id", date_trunc('hour', "published_at")::TIMESTAMP(3)
ON CONFLICT ("chat_id", "bucket_start") DO UPDATE SET
  "views_total" = EXCLUDED."views_total",
  "updated_at" = CURRENT_TIMESTAMP;

CREATE OR REPLACE FUNCTION "apply_channel_stats_post_bucket_delta"(
  post_chat_id TEXT,
  post_bucket_start TIMESTAMP(3),
  posts_delta INTEGER,
  views_total_delta INTEGER,
  reactions_delta INTEGER
)
RETURNS VOID AS $$
BEGIN
  IF post_chat_id IS NULL OR post_bucket_start IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO "channel_stats_bucket_rollups" (
    "chat_id",
    "bucket_start",
    "posts",
    "views_total",
    "reactions",
    "updated_at"
  )
  VALUES (
    post_chat_id,
    post_bucket_start,
    posts_delta,
    views_total_delta,
    reactions_delta,
    CURRENT_TIMESTAMP
  )
  ON CONFLICT ("chat_id", "bucket_start") DO UPDATE SET
    "posts" = GREATEST(
      "channel_stats_bucket_rollups"."posts" + EXCLUDED."posts",
      0
    ),
    "views_total" = GREATEST(
      "channel_stats_bucket_rollups"."views_total" + EXCLUDED."views_total",
      0
    ),
    "reactions" = GREATEST(
      "channel_stats_bucket_rollups"."reactions" + EXCLUDED."reactions",
      0
    ),
    "updated_at" = CURRENT_TIMESTAMP;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "sync_channel_stats_post_bucket_rollup"()
RETURNS TRIGGER AS $$
DECLARE
  old_bucket TIMESTAMP(3);
  new_bucket TIMESTAMP(3);
BEGIN
  IF TG_OP = 'INSERT' THEN
    new_bucket := date_trunc('hour', NEW."published_at")::TIMESTAMP(3);
    PERFORM "apply_channel_stats_post_bucket_delta"(
      NEW."chat_id",
      new_bucket,
      1,
      GREATEST(NEW."latest_views", 0),
      GREATEST(NEW."latest_reactions_total", 0)
    );
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    old_bucket := date_trunc('hour', OLD."published_at")::TIMESTAMP(3);
    new_bucket := date_trunc('hour', NEW."published_at")::TIMESTAMP(3);

    IF OLD."chat_id" <> NEW."chat_id" OR old_bucket <> new_bucket THEN
      PERFORM "apply_channel_stats_post_bucket_delta"(
        OLD."chat_id",
        old_bucket,
        -1,
        -GREATEST(OLD."latest_views", 0),
        -GREATEST(OLD."latest_reactions_total", 0)
      );
      PERFORM "apply_channel_stats_post_bucket_delta"(
        NEW."chat_id",
        new_bucket,
        1,
        GREATEST(NEW."latest_views", 0),
        GREATEST(NEW."latest_reactions_total", 0)
      );
    ELSE
      PERFORM "apply_channel_stats_post_bucket_delta"(
        NEW."chat_id",
        new_bucket,
        0,
        GREATEST(NEW."latest_views", 0) - GREATEST(OLD."latest_views", 0),
        GREATEST(NEW."latest_reactions_total", 0) - GREATEST(OLD."latest_reactions_total", 0)
      );
    END IF;

    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "channel_posts_stats_bucket_insert_update" ON "channel_posts";
CREATE TRIGGER "channel_posts_stats_bucket_insert_update"
AFTER INSERT OR UPDATE OF
  "chat_id",
  "published_at",
  "latest_views",
  "latest_reactions_total"
ON "channel_posts"
FOR EACH ROW
EXECUTE FUNCTION "sync_channel_stats_post_bucket_rollup"();

DROP FUNCTION IF EXISTS "apply_channel_stats_post_bucket_delta"(
  TEXT,
  TIMESTAMP(3),
  INTEGER,
  INTEGER
);
