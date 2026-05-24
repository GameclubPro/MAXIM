CREATE TABLE IF NOT EXISTS "chat_moderation_affected_user_hours" (
  "chat_id" TEXT NOT NULL,
  "bucket_start" TIMESTAMP(3) NOT NULL,
  "user_id" TEXT NOT NULL,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "chat_moderation_affected_user_hours_pkey" PRIMARY KEY (
    "chat_id",
    "bucket_start",
    "user_id"
  )
);

CREATE INDEX IF NOT EXISTS "chat_moderation_affected_user_hours_chat_bucket_idx"
ON "chat_moderation_affected_user_hours"("chat_id", "bucket_start" DESC);

CREATE TABLE IF NOT EXISTS "chat_moderation_feed_items" (
  "id" TEXT NOT NULL,
  "chat_id" TEXT NOT NULL,
  "bot_id" TEXT,
  "user_id" TEXT NOT NULL,
  "message_id" TEXT,
  "event_type" "EventType" NOT NULL,
  "rule_code" TEXT NOT NULL,
  "action" "SanctionAction" NOT NULL,
  "masked_excerpt" TEXT,
  "score" DOUBLE PRECISION NOT NULL DEFAULT 1,
  "operator" "Operator" NOT NULL DEFAULT 'BOT',
  "metadata" JSONB,
  "user_display_name" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "chat_moderation_feed_items_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "chat_moderation_feed_items_chat_created_id_idx"
ON "chat_moderation_feed_items"("chat_id", "created_at" DESC, "id" DESC);

CREATE INDEX IF NOT EXISTS "chat_moderation_feed_items_chat_action_created_id_idx"
ON "chat_moderation_feed_items"("chat_id", "action", "created_at" DESC, "id" DESC);

CREATE INDEX IF NOT EXISTS "chat_moderation_feed_items_chat_rule_created_id_idx"
ON "chat_moderation_feed_items"("chat_id", "rule_code", "created_at" DESC, "id" DESC);

CREATE INDEX IF NOT EXISTS "chat_moderation_feed_items_chat_user_created_idx"
ON "chat_moderation_feed_items"("chat_id", "user_id", "created_at" DESC);

CREATE TABLE IF NOT EXISTS "chat_membership_activity_feed_items" (
  "canonical_key" TEXT NOT NULL,
  "source_event_id" TEXT NOT NULL,
  "bot_id" TEXT,
  "chat_id" TEXT NOT NULL,
  "event_type" TEXT NOT NULL,
  "user_id" TEXT,
  "sender_name" TEXT,
  "event_at" TIMESTAMP(3) NOT NULL,
  "source_created_at" TIMESTAMP(3) NOT NULL,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "chat_membership_activity_feed_items_pkey" PRIMARY KEY ("canonical_key")
);

CREATE INDEX IF NOT EXISTS "chat_membership_activity_feed_items_chat_event_idx"
ON "chat_membership_activity_feed_items"(
  "chat_id",
  "event_type",
  "event_at" DESC,
  "source_event_id" DESC
);

CREATE INDEX IF NOT EXISTS "chat_membership_activity_feed_items_chat_time_idx"
ON "chat_membership_activity_feed_items"(
  "chat_id",
  "event_at" DESC,
  "source_event_id" DESC
);

CREATE INDEX IF NOT EXISTS "chat_membership_activity_feed_items_chat_user_time_idx"
ON "chat_membership_activity_feed_items"("chat_id", "user_id", "event_at" DESC);

CREATE TABLE IF NOT EXISTS "channel_stats_bucket_rollups" (
  "chat_id" TEXT NOT NULL,
  "bucket_start" TIMESTAMP(3) NOT NULL,
  "joined_users" INTEGER NOT NULL DEFAULT 0,
  "left_users" INTEGER NOT NULL DEFAULT 0,
  "posts" INTEGER NOT NULL DEFAULT 0,
  "views_delta" INTEGER NOT NULL DEFAULT 0,
  "reactions" INTEGER NOT NULL DEFAULT 0,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "channel_stats_bucket_rollups_pkey" PRIMARY KEY ("chat_id", "bucket_start")
);

CREATE INDEX IF NOT EXISTS "channel_stats_bucket_rollups_chat_bucket_idx"
ON "channel_stats_bucket_rollups"("chat_id", "bucket_start" DESC);

CREATE OR REPLACE FUNCTION "sync_chat_moderation_stats_rollup"()
RETURNS TRIGGER AS $$
DECLARE
  moderation_bucket TIMESTAMP(3);
  moderation_action TEXT;
  affected_ids TEXT[];
  target_display_name TEXT;
BEGIN
  moderation_action := CASE
    WHEN NEW."action" = 'WARN' THEN 'warn'
    WHEN NEW."action" = 'DELETE_MESSAGE' THEN 'delete_message'
    WHEN NEW."action" = 'MUTE' THEN 'mute'
    WHEN NEW."action" IN ('BAN', 'KICK') THEN 'ban'
    WHEN NEW."action" = 'NONE' AND NEW."rule_code" = 'MANUAL_UNMUTE' THEN 'unmute'
    WHEN NEW."action" = 'NONE' AND NEW."rule_code" = 'MANUAL_UNBAN' THEN 'unban'
    ELSE NULL
  END;

  IF moderation_action IS NULL THEN
    RETURN NEW;
  END IF;

  moderation_bucket := date_trunc('hour', NEW."created_at")::TIMESTAMP(3);
  affected_ids := CASE
    WHEN COALESCE(BTRIM(NEW."user_id"), '') = '' THEN ARRAY[]::TEXT[]
    ELSE ARRAY[NEW."user_id"]
  END;
  target_display_name := NULLIF(
    BTRIM(
      COALESCE(
        NEW."metadata"->>'targetDisplayName',
        NEW."metadata"->>'userDisplayName',
        NEW."metadata"->>'senderName',
        ''
      )
    ),
    ''
  );

  INSERT INTO "chat_moderation_stats_rollups" (
    "chat_id",
    "bucket_start",
    "warn",
    "delete_message",
    "mute",
    "ban",
    "unmute",
    "unban",
    "affected_user_ids",
    "updated_at"
  )
  VALUES (
    NEW."chat_id",
    moderation_bucket,
    CASE WHEN moderation_action = 'warn' THEN 1 ELSE 0 END,
    CASE WHEN moderation_action = 'delete_message' THEN 1 ELSE 0 END,
    CASE WHEN moderation_action = 'mute' THEN 1 ELSE 0 END,
    CASE WHEN moderation_action = 'ban' THEN 1 ELSE 0 END,
    CASE WHEN moderation_action = 'unmute' THEN 1 ELSE 0 END,
    CASE WHEN moderation_action = 'unban' THEN 1 ELSE 0 END,
    affected_ids,
    CURRENT_TIMESTAMP
  )
  ON CONFLICT ("chat_id", "bucket_start") DO UPDATE SET
    "warn" = "chat_moderation_stats_rollups"."warn" + EXCLUDED."warn",
    "delete_message" = "chat_moderation_stats_rollups"."delete_message" + EXCLUDED."delete_message",
    "mute" = "chat_moderation_stats_rollups"."mute" + EXCLUDED."mute",
    "ban" = "chat_moderation_stats_rollups"."ban" + EXCLUDED."ban",
    "unmute" = "chat_moderation_stats_rollups"."unmute" + EXCLUDED."unmute",
    "unban" = "chat_moderation_stats_rollups"."unban" + EXCLUDED."unban",
    "affected_user_ids" = (
      SELECT ARRAY(
        SELECT DISTINCT "affected_user_id"
        FROM unnest(
          "chat_moderation_stats_rollups"."affected_user_ids" || EXCLUDED."affected_user_ids"
        ) AS "affected_user_id"
        WHERE COALESCE(BTRIM("affected_user_id"), '') <> ''
      )
    ),
    "updated_at" = CURRENT_TIMESTAMP;

  IF COALESCE(BTRIM(NEW."user_id"), '') <> '' THEN
    INSERT INTO "chat_moderation_affected_user_hours" (
      "chat_id",
      "bucket_start",
      "user_id",
      "updated_at"
    )
    VALUES (
      NEW."chat_id",
      moderation_bucket,
      NEW."user_id",
      CURRENT_TIMESTAMP
    )
    ON CONFLICT ("chat_id", "bucket_start", "user_id") DO UPDATE SET
      "updated_at" = CURRENT_TIMESTAMP;
  END IF;

  INSERT INTO "chat_moderation_feed_items" (
    "id",
    "chat_id",
    "bot_id",
    "user_id",
    "message_id",
    "event_type",
    "rule_code",
    "action",
    "masked_excerpt",
    "score",
    "operator",
    "metadata",
    "user_display_name",
    "created_at",
    "updated_at"
  )
  VALUES (
    NEW."id",
    NEW."chat_id",
    NEW."bot_id",
    NEW."user_id",
    NEW."message_id",
    NEW."event_type",
    NEW."rule_code",
    NEW."action",
    NEW."masked_excerpt",
    NEW."score",
    NEW."operator",
    NEW."metadata",
    target_display_name,
    NEW."created_at",
    CURRENT_TIMESTAMP
  )
  ON CONFLICT ("id") DO UPDATE SET
    "bot_id" = EXCLUDED."bot_id",
    "user_id" = EXCLUDED."user_id",
    "message_id" = EXCLUDED."message_id",
    "event_type" = EXCLUDED."event_type",
    "rule_code" = EXCLUDED."rule_code",
    "action" = EXCLUDED."action",
    "masked_excerpt" = EXCLUDED."masked_excerpt",
    "score" = EXCLUDED."score",
    "operator" = EXCLUDED."operator",
    "metadata" = EXCLUDED."metadata",
    "user_display_name" = EXCLUDED."user_display_name",
    "created_at" = EXCLUDED."created_at",
    "updated_at" = CURRENT_TIMESTAMP;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "sync_chat_membership_activity_rollup"()
RETURNS TRIGGER AS $$
DECLARE
  membership_bucket TIMESTAMP(3);
  membership_canonical_key TEXT;
  inserted_new_canonical BOOLEAN := FALSE;
BEGIN
  IF NEW."event_type" NOT IN ('user_added', 'user_removed') THEN
    RETURN NEW;
  END IF;

  membership_bucket := date_trunc('hour', NEW."event_at")::TIMESTAMP(3);
  membership_canonical_key := md5(
    NEW."chat_id" || E'\x1f' ||
    NEW."event_type" || E'\x1f' ||
    COALESCE(NEW."user_id", '') || E'\x1f' ||
    to_char(NEW."event_at", 'YYYY-MM-DD HH24:MI:SS.MS')
  );

  WITH upserted AS (
    INSERT INTO "chat_membership_activity_feed_items" (
      "canonical_key",
      "source_event_id",
      "bot_id",
      "chat_id",
      "event_type",
      "user_id",
      "sender_name",
      "event_at",
      "source_created_at",
      "updated_at"
    )
    VALUES (
      membership_canonical_key,
      NEW."id",
      NEW."bot_id",
      NEW."chat_id",
      NEW."event_type",
      NEW."user_id",
      NEW."sender_name",
      NEW."event_at",
      NEW."created_at",
      CURRENT_TIMESTAMP
    )
    ON CONFLICT ("canonical_key") DO UPDATE SET
      "source_event_id" = EXCLUDED."source_event_id",
      "bot_id" = EXCLUDED."bot_id",
      "sender_name" = EXCLUDED."sender_name",
      "source_created_at" = EXCLUDED."source_created_at",
      "updated_at" = CURRENT_TIMESTAMP
    WHERE
      (
        COALESCE(BTRIM("chat_membership_activity_feed_items"."sender_name"), '') = ''
        AND COALESCE(BTRIM(EXCLUDED."sender_name"), '') <> ''
      )
      OR (
        (
          COALESCE(BTRIM("chat_membership_activity_feed_items"."sender_name"), '') = ''
          OR COALESCE(BTRIM(EXCLUDED."sender_name"), '') <> ''
        )
        AND (
          EXCLUDED."source_created_at" > "chat_membership_activity_feed_items"."source_created_at"
          OR (
            EXCLUDED."source_created_at" = "chat_membership_activity_feed_items"."source_created_at"
            AND EXCLUDED."source_event_id" > "chat_membership_activity_feed_items"."source_event_id"
          )
        )
      )
    RETURNING (xmax = 0) AS "inserted"
  )
  SELECT "inserted" INTO inserted_new_canonical FROM upserted;

  IF inserted_new_canonical THEN
    INSERT INTO "chat_membership_activity_rollups" (
      "chat_id",
      "bucket_start",
      "joined_users",
      "left_users",
      "updated_at"
    )
    VALUES (
      NEW."chat_id",
      membership_bucket,
      CASE WHEN NEW."event_type" = 'user_added' THEN 1 ELSE 0 END,
      CASE WHEN NEW."event_type" = 'user_removed' THEN 1 ELSE 0 END,
      CURRENT_TIMESTAMP
    )
    ON CONFLICT ("chat_id", "bucket_start") DO UPDATE SET
      "joined_users" = "chat_membership_activity_rollups"."joined_users" + EXCLUDED."joined_users",
      "left_users" = "chat_membership_activity_rollups"."left_users" + EXCLUDED."left_users",
      "updated_at" = CURRENT_TIMESTAMP;

    INSERT INTO "channel_stats_bucket_rollups" (
      "chat_id",
      "bucket_start",
      "joined_users",
      "left_users",
      "updated_at"
    )
    VALUES (
      NEW."chat_id",
      membership_bucket,
      CASE WHEN NEW."event_type" = 'user_added' THEN 1 ELSE 0 END,
      CASE WHEN NEW."event_type" = 'user_removed' THEN 1 ELSE 0 END,
      CURRENT_TIMESTAMP
    )
    ON CONFLICT ("chat_id", "bucket_start") DO UPDATE SET
      "joined_users" = "channel_stats_bucket_rollups"."joined_users" + EXCLUDED."joined_users",
      "left_users" = "channel_stats_bucket_rollups"."left_users" + EXCLUDED."left_users",
      "updated_at" = CURRENT_TIMESTAMP;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

INSERT INTO "chat_moderation_affected_user_hours" (
  "chat_id",
  "bucket_start",
  "user_id",
  "updated_at"
)
SELECT DISTINCT
  "chat_id",
  date_trunc('hour', "created_at")::TIMESTAMP(3) AS "bucket_start",
  "user_id",
  CURRENT_TIMESTAMP
FROM "moderation_events"
WHERE COALESCE(BTRIM("user_id"), '') <> ''
  AND (
    "action" IN ('WARN', 'DELETE_MESSAGE', 'MUTE', 'BAN', 'KICK')
    OR (
      "action" = 'NONE'
      AND "rule_code" IN ('MANUAL_UNMUTE', 'MANUAL_UNBAN')
    )
  )
ON CONFLICT ("chat_id", "bucket_start", "user_id") DO UPDATE SET
  "updated_at" = CURRENT_TIMESTAMP;

INSERT INTO "chat_moderation_feed_items" (
  "id",
  "chat_id",
  "bot_id",
  "user_id",
  "message_id",
  "event_type",
  "rule_code",
  "action",
  "masked_excerpt",
  "score",
  "operator",
  "metadata",
  "user_display_name",
  "created_at",
  "updated_at"
)
SELECT
  "id",
  "chat_id",
  "bot_id",
  "user_id",
  "message_id",
  "event_type",
  "rule_code",
  "action",
  "masked_excerpt",
  "score",
  "operator",
  "metadata",
  NULLIF(
    BTRIM(
      COALESCE(
        "metadata"->>'targetDisplayName',
        "metadata"->>'userDisplayName',
        "metadata"->>'senderName',
        ''
      )
    ),
    ''
  ) AS "user_display_name",
  "created_at",
  CURRENT_TIMESTAMP
FROM "moderation_events"
WHERE "action" IN ('WARN', 'DELETE_MESSAGE', 'MUTE', 'BAN', 'KICK')
  OR (
    "action" = 'NONE'
    AND "rule_code" IN ('MANUAL_UNMUTE', 'MANUAL_UNBAN')
  )
ON CONFLICT ("id") DO UPDATE SET
  "bot_id" = EXCLUDED."bot_id",
  "user_id" = EXCLUDED."user_id",
  "message_id" = EXCLUDED."message_id",
  "event_type" = EXCLUDED."event_type",
  "rule_code" = EXCLUDED."rule_code",
  "action" = EXCLUDED."action",
  "masked_excerpt" = EXCLUDED."masked_excerpt",
  "score" = EXCLUDED."score",
  "operator" = EXCLUDED."operator",
  "metadata" = EXCLUDED."metadata",
  "user_display_name" = EXCLUDED."user_display_name",
  "created_at" = EXCLUDED."created_at",
  "updated_at" = CURRENT_TIMESTAMP;

WITH ranked_membership_events AS (
  SELECT
    md5(
      "chat_id" || E'\x1f' ||
      "event_type" || E'\x1f' ||
      COALESCE("user_id", '') || E'\x1f' ||
      to_char("event_at", 'YYYY-MM-DD HH24:MI:SS.MS')
    ) AS "canonical_key",
    "id",
    "bot_id",
    "chat_id",
    "event_type",
    "user_id",
    "sender_name",
    "event_at",
    "created_at",
    ROW_NUMBER() OVER (
      PARTITION BY "chat_id", "event_type", COALESCE("user_id", ''), "event_at"
      ORDER BY
        CASE
          WHEN "sender_name" IS NULL OR BTRIM("sender_name") = '' THEN 1
          ELSE 0
        END ASC,
        "created_at" DESC,
        "id" DESC
    ) AS "membership_event_rank"
  FROM "chat_membership_activity_events"
  WHERE "event_type" IN ('user_added', 'user_removed')
)
INSERT INTO "chat_membership_activity_feed_items" (
  "canonical_key",
  "source_event_id",
  "bot_id",
  "chat_id",
  "event_type",
  "user_id",
  "sender_name",
  "event_at",
  "source_created_at",
  "updated_at"
)
SELECT
  "canonical_key",
  "id",
  "bot_id",
  "chat_id",
  "event_type",
  "user_id",
  "sender_name",
  "event_at",
  "created_at",
  CURRENT_TIMESTAMP
FROM ranked_membership_events
WHERE "membership_event_rank" = 1
ON CONFLICT ("canonical_key") DO UPDATE SET
  "source_event_id" = EXCLUDED."source_event_id",
  "bot_id" = EXCLUDED."bot_id",
  "sender_name" = EXCLUDED."sender_name",
  "source_created_at" = EXCLUDED."source_created_at",
  "updated_at" = CURRENT_TIMESTAMP;

TRUNCATE TABLE "chat_membership_activity_rollups";

INSERT INTO "chat_membership_activity_rollups" (
  "chat_id",
  "bucket_start",
  "joined_users",
  "left_users",
  "updated_at"
)
SELECT
  "chat_id",
  date_trunc('hour', "event_at")::TIMESTAMP(3) AS "bucket_start",
  COUNT(*) FILTER (WHERE "event_type" = 'user_added')::INTEGER AS "joined_users",
  COUNT(*) FILTER (WHERE "event_type" = 'user_removed')::INTEGER AS "left_users",
  CURRENT_TIMESTAMP
FROM "chat_membership_activity_feed_items"
GROUP BY "chat_id", date_trunc('hour', "event_at")::TIMESTAMP(3)
ON CONFLICT ("chat_id", "bucket_start") DO UPDATE SET
  "joined_users" = EXCLUDED."joined_users",
  "left_users" = EXCLUDED."left_users",
  "updated_at" = CURRENT_TIMESTAMP;

INSERT INTO "channel_stats_bucket_rollups" (
  "chat_id",
  "bucket_start",
  "joined_users",
  "left_users",
  "updated_at"
)
SELECT
  "chat_id",
  date_trunc('hour', "event_at")::TIMESTAMP(3) AS "bucket_start",
  COUNT(*) FILTER (WHERE "event_type" = 'user_added')::INTEGER AS "joined_users",
  COUNT(*) FILTER (WHERE "event_type" = 'user_removed')::INTEGER AS "left_users",
  CURRENT_TIMESTAMP
FROM "chat_membership_activity_feed_items"
GROUP BY "chat_id", date_trunc('hour', "event_at")::TIMESTAMP(3)
ON CONFLICT ("chat_id", "bucket_start") DO UPDATE SET
  "joined_users" = EXCLUDED."joined_users",
  "left_users" = EXCLUDED."left_users",
  "updated_at" = CURRENT_TIMESTAMP;

INSERT INTO "channel_stats_bucket_rollups" (
  "chat_id",
  "bucket_start",
  "posts",
  "reactions",
  "updated_at"
)
SELECT
  "chat_id",
  date_trunc('hour', "published_at")::TIMESTAMP(3) AS "bucket_start",
  COUNT(*)::INTEGER AS "posts",
  COALESCE(SUM(GREATEST("latest_reactions_total", 0)), 0)::INTEGER AS "reactions",
  CURRENT_TIMESTAMP
FROM "channel_posts"
GROUP BY "chat_id", date_trunc('hour', "published_at")::TIMESTAMP(3)
ON CONFLICT ("chat_id", "bucket_start") DO UPDATE SET
  "posts" = EXCLUDED."posts",
  "reactions" = EXCLUDED."reactions",
  "updated_at" = CURRENT_TIMESTAMP;

WITH ordered_view_snapshots AS (
  SELECT
    posts."chat_id",
    date_trunc('hour', snapshots."captured_at")::TIMESTAMP(3) AS "bucket_start",
    GREATEST(
      snapshots."views" - COALESCE(
        LAG(snapshots."views") OVER (
          PARTITION BY snapshots."channel_post_id"
          ORDER BY snapshots."captured_at" ASC, snapshots."id" ASC
        ),
        snapshots."views"
      ),
      0
    ) AS "views_delta"
  FROM "channel_post_view_snapshots" snapshots
  JOIN "channel_posts" posts ON posts."id" = snapshots."channel_post_id"
)
INSERT INTO "channel_stats_bucket_rollups" (
  "chat_id",
  "bucket_start",
  "views_delta",
  "updated_at"
)
SELECT
  "chat_id",
  "bucket_start",
  COALESCE(SUM("views_delta"), 0)::INTEGER AS "views_delta",
  CURRENT_TIMESTAMP
FROM ordered_view_snapshots
GROUP BY "chat_id", "bucket_start"
ON CONFLICT ("chat_id", "bucket_start") DO UPDATE SET
  "views_delta" = EXCLUDED."views_delta",
  "updated_at" = CURRENT_TIMESTAMP;

CREATE OR REPLACE FUNCTION "apply_channel_stats_post_bucket_delta"(
  post_chat_id TEXT,
  post_bucket_start TIMESTAMP(3),
  posts_delta INTEGER,
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
    "reactions",
    "updated_at"
  )
  VALUES (
    post_chat_id,
    post_bucket_start,
    posts_delta,
    reactions_delta,
    CURRENT_TIMESTAMP
  )
  ON CONFLICT ("chat_id", "bucket_start") DO UPDATE SET
    "posts" = GREATEST(
      "channel_stats_bucket_rollups"."posts" + EXCLUDED."posts",
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
        -GREATEST(OLD."latest_reactions_total", 0)
      );
      PERFORM "apply_channel_stats_post_bucket_delta"(
        NEW."chat_id",
        new_bucket,
        1,
        GREATEST(NEW."latest_reactions_total", 0)
      );
    ELSE
      PERFORM "apply_channel_stats_post_bucket_delta"(
        NEW."chat_id",
        new_bucket,
        0,
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
AFTER INSERT OR UPDATE OF "chat_id", "published_at", "latest_reactions_total" ON "channel_posts"
FOR EACH ROW
EXECUTE FUNCTION "sync_channel_stats_post_bucket_rollup"();

CREATE OR REPLACE FUNCTION "sync_channel_stats_view_bucket_rollup"()
RETURNS TRIGGER AS $$
DECLARE
  post_chat_id TEXT;
  view_bucket TIMESTAMP(3);
  previous_views INTEGER;
  view_delta INTEGER;
BEGIN
  SELECT posts."chat_id"
  INTO post_chat_id
  FROM "channel_posts" posts
  WHERE posts."id" = NEW."channel_post_id";

  IF post_chat_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT snapshots."views"
  INTO previous_views
  FROM "channel_post_view_snapshots" snapshots
  WHERE snapshots."channel_post_id" = NEW."channel_post_id"
    AND (
      snapshots."captured_at" < NEW."captured_at"
      OR (
        snapshots."captured_at" = NEW."captured_at"
        AND snapshots."id" < NEW."id"
      )
    )
  ORDER BY snapshots."captured_at" DESC, snapshots."id" DESC
  LIMIT 1;

  view_delta := GREATEST(NEW."views" - COALESCE(previous_views, NEW."views"), 0);
  IF view_delta <= 0 THEN
    RETURN NEW;
  END IF;

  view_bucket := date_trunc('hour', NEW."captured_at")::TIMESTAMP(3);
  INSERT INTO "channel_stats_bucket_rollups" (
    "chat_id",
    "bucket_start",
    "views_delta",
    "updated_at"
  )
  VALUES (
    post_chat_id,
    view_bucket,
    view_delta,
    CURRENT_TIMESTAMP
  )
  ON CONFLICT ("chat_id", "bucket_start") DO UPDATE SET
    "views_delta" = "channel_stats_bucket_rollups"."views_delta" + EXCLUDED."views_delta",
    "updated_at" = CURRENT_TIMESTAMP;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "channel_post_view_snapshots_stats_bucket_insert" ON "channel_post_view_snapshots";
CREATE TRIGGER "channel_post_view_snapshots_stats_bucket_insert"
AFTER INSERT ON "channel_post_view_snapshots"
FOR EACH ROW
EXECUTE FUNCTION "sync_channel_stats_view_bucket_rollup"();
