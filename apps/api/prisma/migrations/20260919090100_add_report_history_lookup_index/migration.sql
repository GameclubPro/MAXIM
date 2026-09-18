CREATE INDEX CONCURRENTLY "webhook_events_report_history_idx"
ON "webhook_events" ((normalized_payload->'message'->>'chatId'),
  (normalized_payload->'message'->>'senderId'), created_at, id)
WHERE normalized_payload->>'type' = 'message_created';
