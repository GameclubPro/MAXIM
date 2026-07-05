CREATE INDEX CONCURRENTLY IF NOT EXISTS "audit_logs_channel_suggestion_recovery_pending_idx"
ON "audit_logs"("created_at")
WHERE "action" = 'CHANNEL_DIALOG_SUGGESTION'
  AND ("payload"->>'delivered') = 'false'
  AND COALESCE(NULLIF("payload"->>'reviewStatus', ''), 'pending') = 'pending'
  AND COALESCE(
    jsonb_array_length(
      CASE
        WHEN jsonb_typeof("payload"->'deliveries') = 'array'
        THEN "payload"->'deliveries'
        ELSE '[]'::jsonb
      END
    ),
    0
  ) = 0;
