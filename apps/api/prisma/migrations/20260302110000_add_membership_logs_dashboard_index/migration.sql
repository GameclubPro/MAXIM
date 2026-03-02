CREATE INDEX "webhook_events_membership_chat_created_at_idx"
ON "webhook_events" (((normalized_payload->'message'->>'chatId')), created_at)
WHERE (normalized_payload->>'type' IN ('user_added', 'user_removed'));
