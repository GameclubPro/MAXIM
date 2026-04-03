CREATE INDEX IF NOT EXISTS "webhook_events_managed_sender_chat_created_idx"
ON "webhook_events" (
  ((normalized_payload->'message'->>'senderId')),
  ((normalized_payload->'message'->>'chatId')),
  "created_at" DESC
)
WHERE (
  NULLIF(BTRIM(normalized_payload->'message'->>'chatId'), '') IS NOT NULL
  AND (normalized_payload->>'type') IN ('message_created', 'message_callback', 'bot_started', 'bot_added')
);
