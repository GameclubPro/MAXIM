CREATE INDEX CONCURRENTLY IF NOT EXISTS "webhook_events_local_display_name_chat_user_created_idx"
ON "webhook_events" (
  (NULLIF(BTRIM("normalized_payload"->'message'->>'chatId'), '')),
  (NULLIF(BTRIM("normalized_payload"->'message'->>'senderId'), '')),
  "created_at" DESC
)
WHERE
  NULLIF(BTRIM("normalized_payload"->'message'->>'chatId'), '') IS NOT NULL
  AND NULLIF(BTRIM("normalized_payload"->'message'->>'senderName'), '') IS NOT NULL
  AND "normalized_payload"->>'type' IN (
    'message_created',
    'message_edited',
    'message_callback',
    'bot_started',
    'bot_added',
    'user_added',
    'user_removed'
  );
