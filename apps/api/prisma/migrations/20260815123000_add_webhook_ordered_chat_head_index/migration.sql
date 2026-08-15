CREATE INDEX CONCURRENTLY IF NOT EXISTS "webhook_events_ordered_chat_head_idx"
ON "webhook_events" (
  (COALESCE(
    NULLIF(BTRIM("normalized_payload"->'message'->>'chatId'), ''),
    NULLIF(BTRIM("normalized_payload"->>'chatId'), '')
  )),
  "created_at",
  "id"
)
WHERE (
    "status" = ANY(ARRAY['RECEIVED', 'QUEUED']::"WebhookStatus"[])
    OR (
      "status" = 'FAILED'::"WebhookStatus"
      AND (
        "next_enqueue_at" IS NOT NULL
        OR LEFT(
          COALESCE("error_message", ''),
          37
        ) = 'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:'
      )
    )
  )
  AND LOWER(
    COALESCE(
      NULLIF(BTRIM("normalized_payload"->>'type'), ''),
      NULLIF(BTRIM("normalized_payload"->>'update_type'), '')
    )
  ) = ANY(ARRAY['message_created', 'message_edited']);
