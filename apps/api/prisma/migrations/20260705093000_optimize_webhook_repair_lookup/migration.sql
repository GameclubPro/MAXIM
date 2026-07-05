CREATE INDEX CONCURRENTLY IF NOT EXISTS "webhook_events_bot_chat_repair_signal_idx"
ON "webhook_events" (
  "bot_id",
  (COALESCE(
    NULLIF(BTRIM(normalized_payload->'message'->>'chatId'), ''),
    NULLIF(BTRIM(normalized_payload->>'chatId'), '')
  )),
  "created_at" DESC
)
WHERE (
  "bot_id" IS NOT NULL
  AND COALESCE(
    NULLIF(BTRIM(normalized_payload->'message'->>'chatId'), ''),
    NULLIF(BTRIM(normalized_payload->>'chatId'), '')
  ) IS NOT NULL
);
