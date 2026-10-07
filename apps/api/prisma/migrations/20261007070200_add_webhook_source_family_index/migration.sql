-- FLAG: Materialization reads one exact message family, never an unrelated chat
-- prefix. Scrubbed backlog lacks these source identities and is outside this index.
CREATE INDEX CONCURRENTLY "webhook_events_source_family_pending_idx"
  ON "webhook_events" (("normalized_payload"->'message'->>'chatId'),
    ("normalized_payload"->'message'->>'messageId'), "created_at", "id")
  WHERE "status" IN ('RECEIVED', 'QUEUED', 'FAILED') AND "processed_at" IS NULL
    AND "source_disposition_id" IS NULL
    AND ("normalized_payload"->'message'->>'chatId') IS NOT NULL
    AND ("normalized_payload"->'message'->>'messageId') IS NOT NULL;
