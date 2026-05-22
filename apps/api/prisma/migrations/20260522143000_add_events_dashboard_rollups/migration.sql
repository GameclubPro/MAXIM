CREATE TABLE IF NOT EXISTS "chat_moderation_stats_rollups" (
  "chat_id" TEXT NOT NULL,
  "bucket_start" TIMESTAMP(3) NOT NULL,
  "warn" INTEGER NOT NULL DEFAULT 0,
  "delete_message" INTEGER NOT NULL DEFAULT 0,
  "mute" INTEGER NOT NULL DEFAULT 0,
  "ban" INTEGER NOT NULL DEFAULT 0,
  "unmute" INTEGER NOT NULL DEFAULT 0,
  "unban" INTEGER NOT NULL DEFAULT 0,
  "affected_user_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "chat_moderation_stats_rollups_pkey" PRIMARY KEY ("chat_id", "bucket_start")
);

CREATE TABLE IF NOT EXISTS "chat_membership_activity_rollups" (
  "chat_id" TEXT NOT NULL,
  "bucket_start" TIMESTAMP(3) NOT NULL,
  "joined_users" INTEGER NOT NULL DEFAULT 0,
  "left_users" INTEGER NOT NULL DEFAULT 0,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "chat_membership_activity_rollups_pkey" PRIMARY KEY ("chat_id", "bucket_start")
);

CREATE INDEX IF NOT EXISTS "chat_moderation_stats_rollups_chat_bucket_idx"
ON "chat_moderation_stats_rollups"("chat_id", "bucket_start" DESC);

CREATE INDEX IF NOT EXISTS "chat_membership_activity_rollups_chat_bucket_idx"
ON "chat_membership_activity_rollups"("chat_id", "bucket_start" DESC);

CREATE INDEX IF NOT EXISTS "moderation_events_chat_created_id_idx"
ON "moderation_events"("chat_id", "created_at" DESC, "id" DESC);

CREATE INDEX IF NOT EXISTS "moderation_events_chat_action_created_id_idx"
ON "moderation_events"("chat_id", "action", "created_at" DESC, "id" DESC);

CREATE INDEX IF NOT EXISTS "moderation_events_chat_rule_created_id_idx"
ON "moderation_events"("chat_id", "rule_code", "created_at" DESC, "id" DESC);

CREATE INDEX IF NOT EXISTS "chat_membership_activity_events_dashboard_idx"
ON "chat_membership_activity_events"(
  "chat_id",
  "event_type",
  "event_at" DESC,
  "user_id",
  "created_at" DESC,
  "id" DESC
);

CREATE OR REPLACE FUNCTION "sync_chat_moderation_stats_rollup"()
RETURNS TRIGGER AS $$
DECLARE
  moderation_bucket TIMESTAMP(3);
  moderation_action TEXT;
  affected_ids TEXT[];
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

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "moderation_events_stats_rollup_insert" ON "moderation_events";
CREATE TRIGGER "moderation_events_stats_rollup_insert"
AFTER INSERT ON "moderation_events"
FOR EACH ROW
EXECUTE FUNCTION "sync_chat_moderation_stats_rollup"();

CREATE OR REPLACE FUNCTION "sync_chat_membership_activity_rollup"()
RETURNS TRIGGER AS $$
DECLARE
  membership_bucket TIMESTAMP(3);
BEGIN
  IF NEW."event_type" NOT IN ('user_added', 'user_removed') THEN
    RETURN NEW;
  END IF;

  membership_bucket := date_trunc('hour', NEW."event_at")::TIMESTAMP(3);

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

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "chat_membership_activity_events_rollup_insert" ON "chat_membership_activity_events";
CREATE TRIGGER "chat_membership_activity_events_rollup_insert"
AFTER INSERT ON "chat_membership_activity_events"
FOR EACH ROW
EXECUTE FUNCTION "sync_chat_membership_activity_rollup"();

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
SELECT
  "chat_id",
  date_trunc('hour', "created_at")::TIMESTAMP(3) AS "bucket_start",
  COUNT(*) FILTER (WHERE "action" = 'WARN')::INTEGER AS "warn",
  COUNT(*) FILTER (WHERE "action" = 'DELETE_MESSAGE')::INTEGER AS "delete_message",
  COUNT(*) FILTER (WHERE "action" = 'MUTE')::INTEGER AS "mute",
  COUNT(*) FILTER (WHERE "action" IN ('BAN', 'KICK'))::INTEGER AS "ban",
  COUNT(*) FILTER (
    WHERE "action" = 'NONE' AND "rule_code" = 'MANUAL_UNMUTE'
  )::INTEGER AS "unmute",
  COUNT(*) FILTER (
    WHERE "action" = 'NONE' AND "rule_code" = 'MANUAL_UNBAN'
  )::INTEGER AS "unban",
  COALESCE(
    ARRAY_AGG(DISTINCT "user_id") FILTER (
      WHERE COALESCE(BTRIM("user_id"), '') <> ''
        AND (
          "action" IN ('WARN', 'DELETE_MESSAGE', 'MUTE', 'BAN', 'KICK')
          OR (
            "action" = 'NONE'
            AND "rule_code" IN ('MANUAL_UNMUTE', 'MANUAL_UNBAN')
          )
        )
    ),
    ARRAY[]::TEXT[]
  ) AS "affected_user_ids",
  CURRENT_TIMESTAMP
FROM "moderation_events"
WHERE "action" IN ('WARN', 'DELETE_MESSAGE', 'MUTE', 'BAN', 'KICK')
  OR (
    "action" = 'NONE'
    AND "rule_code" IN ('MANUAL_UNMUTE', 'MANUAL_UNBAN')
  )
GROUP BY "chat_id", date_trunc('hour', "created_at")::TIMESTAMP(3)
ON CONFLICT ("chat_id", "bucket_start") DO UPDATE SET
  "warn" = EXCLUDED."warn",
  "delete_message" = EXCLUDED."delete_message",
  "mute" = EXCLUDED."mute",
  "ban" = EXCLUDED."ban",
  "unmute" = EXCLUDED."unmute",
  "unban" = EXCLUDED."unban",
  "affected_user_ids" = EXCLUDED."affected_user_ids",
  "updated_at" = CURRENT_TIMESTAMP;

WITH ranked_membership_events AS (
  SELECT
    "chat_id",
    "event_type",
    "user_id",
    "event_at",
    date_trunc('hour', "event_at")::TIMESTAMP(3) AS "bucket_start",
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
),
canonical_membership_events AS (
  SELECT
    "chat_id",
    "event_type",
    "user_id",
    "event_at",
    "bucket_start"
  FROM ranked_membership_events
  WHERE "membership_event_rank" = 1
)
INSERT INTO "chat_membership_activity_rollups" (
  "chat_id",
  "bucket_start",
  "joined_users",
  "left_users",
  "updated_at"
)
SELECT
  "chat_id",
  "bucket_start",
  COUNT(*) FILTER (WHERE "event_type" = 'user_added')::INTEGER AS "joined_users",
  COUNT(*) FILTER (WHERE "event_type" = 'user_removed')::INTEGER AS "left_users",
  CURRENT_TIMESTAMP
FROM canonical_membership_events
GROUP BY "chat_id", "bucket_start"
ON CONFLICT ("chat_id", "bucket_start") DO UPDATE SET
  "joined_users" = EXCLUDED."joined_users",
  "left_users" = EXCLUDED."left_users",
  "updated_at" = CURRENT_TIMESTAMP;
