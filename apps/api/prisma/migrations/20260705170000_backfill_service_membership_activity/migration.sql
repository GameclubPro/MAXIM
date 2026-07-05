-- Backfill join/leave activity for MAX service messages that carry membership collections.
-- Direct user_added/user_removed events were already backfilled by earlier migrations.
WITH service_membership_events AS (
  SELECT
    "dedup_key",
    "bot_id",
    NULLIF(BTRIM("normalized_payload"->'message'->>'chatId'), '') AS "chat_id",
    CASE
      WHEN "normalized_payload"->'membership'->>'action' = 'removed' THEN 'user_removed'
      ELSE 'user_added'
    END AS "event_type",
    COALESCE(
      (NULLIF(BTRIM("normalized_payload"->'message'->>'createdAt'), '')::TIMESTAMPTZ AT TIME ZONE 'UTC')::TIMESTAMP(3),
      "created_at"
    ) AS "event_at",
    "created_at",
    "normalized_payload"->'membership'->'memberUserIds' AS "member_user_ids"
  FROM "webhook_events"
  WHERE LOWER(COALESCE(NULLIF(BTRIM("normalized_payload"->>'type'), ''), '')) = 'message_created'
    AND "normalized_payload"->'membership'->>'action' IN ('added', 'removed')
    AND JSONB_TYPEOF("normalized_payload"->'membership'->'memberUserIds') = 'array'
    AND NULLIF(BTRIM("normalized_payload"->'message'->>'chatId'), '') IS NOT NULL
),
expanded_members AS (
  SELECT DISTINCT ON (
    "dedup_key",
    "event_type",
    "chat_id",
    NULLIF(BTRIM("member_user_id"), ''),
    "event_at"
  )
    "dedup_key",
    "bot_id",
    "chat_id",
    "event_type",
    NULLIF(BTRIM("member_user_id"), '') AS "user_id",
    "event_at",
    "created_at"
  FROM service_membership_events
  CROSS JOIN LATERAL JSONB_ARRAY_ELEMENTS_TEXT("member_user_ids") AS members("member_user_id")
  WHERE NULLIF(BTRIM("member_user_id"), '') IS NOT NULL
  ORDER BY
    "dedup_key",
    "event_type",
    "chat_id",
    NULLIF(BTRIM("member_user_id"), ''),
    "event_at"
)
INSERT INTO "chat_membership_activity_events" (
  "id",
  "dedupe_key",
  "bot_id",
  "chat_id",
  "event_type",
  "user_id",
  "sender_name",
  "event_at",
  "created_at"
)
SELECT
  "dedup_key" || ':membership:' || "event_type" || ':' || MD5("user_id") AS "id",
  'membership:' || "event_type" || ':' || "chat_id" || ':' || "user_id" || ':' ||
    TO_CHAR("event_at", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "dedupe_key",
  "bot_id",
  "chat_id",
  "event_type",
  "user_id",
  NULL AS "sender_name",
  "event_at",
  "event_at"
FROM expanded_members
ON CONFLICT ("dedupe_key") DO NOTHING;
