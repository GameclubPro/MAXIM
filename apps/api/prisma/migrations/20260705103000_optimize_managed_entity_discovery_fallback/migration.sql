CREATE INDEX CONCURRENTLY IF NOT EXISTS "webhook_events_managed_sender_created_chat_idx"
ON "webhook_events" (
  ((normalized_payload->'message'->>'senderId')),
  "created_at" DESC,
  ((normalized_payload->'message'->>'chatId'))
)
WHERE (
  NULLIF(BTRIM(normalized_payload->'message'->>'chatId'), '') IS NOT NULL
  AND (normalized_payload->>'type') IN (
    'message_created',
    'message_edited',
    'message_callback',
    'bot_started',
    'bot_added',
    'user_added',
    'user_removed'
  )
);

CREATE INDEX CONCURRENTLY IF NOT EXISTS "moderation_events_created_at_idx"
ON "moderation_events" ("created_at");
