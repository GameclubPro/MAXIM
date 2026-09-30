BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- FLAG: Forward-only function replacement; no historical row rewrite or drop.
-- Action counters, legacy array cleanup, feed fields and time buckets remain intact.
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
    -- FLAG: Inspect canonicality only for physically small arrays (<=128 bytes;
    -- a standard singleton with a <=64-byte ID fits). Nested CASE keeps the
    -- size gate ahead of array access, avoiding extra deTOAST work for larger
    -- stored values. Compressed size is not a bound on expanded array size.
    -- Larger/malformed arrays retain the exact original DISTINCT cleanup.
    "affected_user_ids" = CASE
      WHEN CASE
        WHEN pg_column_size("chat_moderation_stats_rollups"."affected_user_ids") <= 128 THEN
          CASE
            WHEN cardinality("chat_moderation_stats_rollups"."affected_user_ids") = 0
              AND cardinality(EXCLUDED."affected_user_ids") = 0
            THEN TRUE
            WHEN array_ndims("chat_moderation_stats_rollups"."affected_user_ids") = 1
              AND array_lower("chat_moderation_stats_rollups"."affected_user_ids", 1) = 1
              AND array_upper("chat_moderation_stats_rollups"."affected_user_ids", 1) = 1
              AND COALESCE(BTRIM("chat_moderation_stats_rollups"."affected_user_ids"[1]), '') <> ''
              AND (
                cardinality(EXCLUDED."affected_user_ids") = 0
                OR "chat_moderation_stats_rollups"."affected_user_ids"[1] = EXCLUDED."affected_user_ids"[1]
              )
            THEN TRUE
            ELSE FALSE
          END
        ELSE FALSE
      END
      THEN "chat_moderation_stats_rollups"."affected_user_ids"
      ELSE ARRAY(
        SELECT DISTINCT "affected_user_id"
        FROM unnest(
          "chat_moderation_stats_rollups"."affected_user_ids" || EXCLUDED."affected_user_ids"
        ) AS "affected_user_id"
        WHERE COALESCE(BTRIM("affected_user_id"), '') <> ''
      )
    END,
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
    -- FLAG: Keep the exact transaction-time freshness contract. Only a
    -- physically identical TIMESTAMP(3) assignment is skipped, never a later touch.
    ON CONFLICT ("chat_id", "bucket_start", "user_id") DO UPDATE SET
      "updated_at" = EXCLUDED."updated_at"
    WHERE "chat_moderation_affected_user_hours"."updated_at"
      IS DISTINCT FROM EXCLUDED."updated_at";
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

COMMIT;
