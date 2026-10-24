-- FLAG: Add nullable shadow counters without rewriting retained hourly history.
-- Untouched rows retain their exact legacy INTEGER values through reader COALESCE.
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';
ALTER TABLE "channel_stats_bucket_rollups"
  ADD COLUMN "views_total_exact" BIGINT,
  ADD COLUMN "views_delta_exact" BIGINT;

CREATE OR REPLACE FUNCTION "apply_channel_stats_post_bucket_delta"(
  post_chat_id TEXT,
  post_bucket_start TIMESTAMP(3),
  posts_delta INTEGER,
  views_total_delta INTEGER,
  reactions_delta INTEGER
)
RETURNS VOID AS $$
BEGIN
  IF post_chat_id IS NULL OR post_bucket_start IS NULL THEN RETURN; END IF;
  INSERT INTO "channel_stats_bucket_rollups" (
    "chat_id","bucket_start","posts","views_total","views_total_exact","reactions","updated_at"
  ) VALUES (
    post_chat_id,post_bucket_start,posts_delta,GREATEST(views_total_delta,0),
    GREATEST(views_total_delta::BIGINT,0),reactions_delta,CURRENT_TIMESTAMP
  ) ON CONFLICT ("chat_id","bucket_start") DO UPDATE SET
    "posts"=GREATEST("channel_stats_bucket_rollups"."posts"+EXCLUDED."posts",0),
    "views_total_exact"=GREATEST(COALESCE("channel_stats_bucket_rollups"."views_total_exact","channel_stats_bucket_rollups"."views_total"::BIGINT)+views_total_delta::BIGINT,0),
    "views_total"=LEAST(GREATEST(COALESCE("channel_stats_bucket_rollups"."views_total_exact","channel_stats_bucket_rollups"."views_total"::BIGINT)+views_total_delta::BIGINT,0),2147483647)::INTEGER,
    "reactions"=GREATEST("channel_stats_bucket_rollups"."reactions"+EXCLUDED."reactions",0),
    "updated_at"=CURRENT_TIMESTAMP;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "sync_channel_stats_view_bucket_rollup"()
RETURNS TRIGGER AS $$
DECLARE
  post_chat_id TEXT;
  view_bucket TIMESTAMP(3);
  previous_views INTEGER;
  view_delta BIGINT;
BEGIN
  SELECT posts."chat_id" INTO post_chat_id FROM "channel_posts" posts WHERE posts."id"=NEW."channel_post_id";
  IF post_chat_id IS NULL THEN RETURN NEW; END IF;
  SELECT snapshots."views" INTO previous_views FROM "channel_post_view_snapshots" snapshots
    WHERE snapshots."channel_post_id"=NEW."channel_post_id" AND
      (snapshots."captured_at"<NEW."captured_at" OR (snapshots."captured_at"=NEW."captured_at" AND snapshots."id"<NEW."id"))
    ORDER BY snapshots."captured_at" DESC,snapshots."id" DESC LIMIT 1;
  view_delta:=GREATEST(NEW."views"::BIGINT-COALESCE(previous_views,NEW."views")::BIGINT,0);
  IF view_delta<=0 THEN RETURN NEW; END IF;
  view_bucket:=date_trunc('hour',NEW."captured_at")::TIMESTAMP(3);
  INSERT INTO "channel_stats_bucket_rollups" ("chat_id","bucket_start","views_delta","views_delta_exact","updated_at")
    VALUES(post_chat_id,view_bucket,LEAST(view_delta,2147483647)::INTEGER,view_delta,CURRENT_TIMESTAMP)
    ON CONFLICT("chat_id","bucket_start") DO UPDATE SET
      "views_delta_exact"=COALESCE("channel_stats_bucket_rollups"."views_delta_exact","channel_stats_bucket_rollups"."views_delta"::BIGINT)+EXCLUDED."views_delta_exact",
      "views_delta"=LEAST(COALESCE("channel_stats_bucket_rollups"."views_delta_exact","channel_stats_bucket_rollups"."views_delta"::BIGINT)+EXCLUDED."views_delta_exact",2147483647)::INTEGER,
      "updated_at"=CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
COMMIT;
