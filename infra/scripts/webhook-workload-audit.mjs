import { pathToFileURL } from 'node:url';
import { buildWebhookCohortIndexSql } from './webhook-cohort-audit.mjs';

export function buildWebhookWorkloadAuditSql(explain = false) {
  if (typeof explain !== 'boolean') throw new Error('Expected a fixed EXPLAIN flag');
  // FLAG: Select at most 513 covered heads per status, then at most 512 exact rows.
  // Classify only saved observations; no source/identity/text leaves the database.
  // Incomplete samples and unknown payload shapes cannot establish a production mix.
  const query = `WITH bounds AS MATERIALIZED (
  SELECT statement_timestamp() AT TIME ZONE 'UTC' AS observed_at,
    (statement_timestamp() AT TIME ZONE 'UTC') - interval '35 seconds' AS from_at,
    (statement_timestamp() AT TIME ZONE 'UTC') - interval '30 seconds' AS until_at
), statuses(status) AS (VALUES
  ('RECEIVED'::"WebhookStatus"), ('QUEUED'::"WebhookStatus"),
  ('PROCESSED'::"WebhookStatus"), ('DUPLICATE'::"WebhookStatus"),
  ('FAILED'::"WebhookStatus"), ('NO_REPLAY_HELD'::"WebhookStatus"),
  ('CANCELLED'::"WebhookStatus"), ('QUARANTINED'::"WebhookStatus")
), candidates AS MATERIALIZED (
  SELECT statuses.status, head.id, head.created_at
  FROM statuses CROSS JOIN bounds CROSS JOIN LATERAL (
    SELECT id, created_at FROM webhook_events
    WHERE status = statuses.status AND created_at >= bounds.from_at AND created_at < bounds.until_at
    ORDER BY created_at, id LIMIT 513
  ) head
), samples AS MATERIALIZED (
  SELECT * FROM candidates ORDER BY created_at, id LIMIT 512
), details AS MATERIALIZED (
  SELECT samples.status,
    CASE WHEN length(metadata.semantic_key) BETWEEN 1 AND 2048 THEN metadata.semantic_key END AS saved_key,
    CASE WHEN octet_length(metadata.normalized_payload::text) <= 65536
      AND jsonb_typeof(metadata.normalized_payload) = 'object'
      THEN metadata.normalized_payload END AS source
  FROM samples CROSS JOIN LATERAL (
    SELECT normalized_payload, semantic_key FROM webhook_events WHERE id = samples.id OFFSET 0
  ) metadata
), shapes AS MATERIALIZED (
  SELECT status, saved_key, source,
    CASE WHEN source->>'type' IN ('message_created','message_edited','message_removed',
      'message_callback','user_added','user_removed','bot_added','bot_removed','bot_started',
      'bot_stopped','dialog_removed','chat_title_changed','bot_admin_permissions_changed')
      THEN source->>'type' ELSE 'unknown' END AS event_type,
    CASE WHEN source->'message'->>'entityType' IN ('chat','channel')
      THEN source->'message'->>'entityType' ELSE 'unknown' END AS entity_type,
    source->'raw'->'message' AS raw_message
  FROM details
), classified AS MATERIALIZED (
  SELECT status, saved_key, event_type, entity_type,
    CASE
      WHEN source IS NULL THEN 'unavailable_or_oversize'
      WHEN event_type = 'unknown' THEN 'unknown_event'
      WHEN event_type NOT IN ('message_created','message_edited') THEN 'non_message'
      WHEN jsonb_typeof(raw_message) IS DISTINCT FROM 'object' THEN 'unknown_shape'
      WHEN raw_message->'link' IS NOT NULL AND raw_message->'link' <> 'null'::jsonb THEN 'linked_message'
      WHEN raw_message->'attachments' IS NOT NULL OR raw_message->'content' IS NOT NULL
        OR raw_message->'data' IS NOT NULL OR raw_message->'payload' IS NOT NULL THEN 'alternative_shape'
      WHEN jsonb_typeof(raw_message->'body') IS DISTINCT FROM 'object' THEN 'unknown_shape'
      WHEN raw_message->'body'->'attachments' IS NULL
        OR raw_message->'body'->'attachments' IN ('null'::jsonb, '[]'::jsonb) THEN
        CASE WHEN jsonb_typeof(source->'message'->'text') = 'string' THEN 'text_or_empty' ELSE 'unknown_shape' END
      WHEN jsonb_typeof(raw_message->'body'->'attachments') <> 'array' THEN 'unknown_shape'
      WHEN jsonb_array_length(raw_message->'body'->'attachments') > 16 THEN 'attachment_limit'
      ELSE 'attachments'
    END AS shape,
    CASE WHEN jsonb_typeof(raw_message->'body'->'attachments') = 'array' THEN
      CASE WHEN jsonb_array_length(raw_message->'body'->'attachments') <= 16
        THEN raw_message->'body'->'attachments' END END AS attachments
  FROM shapes
), buckets AS MATERIALIZED (
  SELECT status, saved_key, event_type, entity_type,
    CASE WHEN shape <> 'attachments' THEN shape ELSE (
      SELECT CASE WHEN bool_and(COALESCE(item->>'type', '') = 'image') THEN 'direct_image'
        WHEN bool_and(COALESCE(item->>'type', '') = 'video') THEN 'direct_video'
        WHEN bool_and(COALESCE(item->>'type', '') = 'audio') THEN 'direct_audio'
        WHEN bool_and(COALESCE(item->>'type', '') = 'sticker') THEN 'direct_sticker'
        WHEN bool_and(COALESCE(item->>'type', '') = 'file') THEN 'direct_file'
        WHEN bool_and(COALESCE(item->>'type', '') = 'share') THEN 'direct_share'
        ELSE 'mixed_or_unknown_attachments' END
      FROM jsonb_array_elements(attachments) item
    ) END AS content_class
  FROM classified
), key_groups AS MATERIALIZED (
  SELECT count(*) AS receipts FROM buckets WHERE saved_key IS NOT NULL GROUP BY saved_key
)
SELECT json_build_object(
  'schema_version', 1, 'audit', 'closed_webhook_workload',
  'from', bounds.from_at, 'until', bounds.until_at, 'observed_at', bounds.observed_at,
  'window_seconds', 5, 'receipt_cap', 512,
  'sampled_receipts', (SELECT count(*) FROM samples),
  'captured_receipts_lower_bound', (SELECT count(*) FROM candidates),
  'sample_complete', (SELECT count(*) <= 512 FROM candidates),
  'nonempty', EXISTS (SELECT 1 FROM samples),
  'remote_effects_proven', false, 'moderation_decisions_proven', false,
  'classification_basis', 'saved_direct_body_attachments_only',
  'classifications_complete', EXISTS (SELECT 1 FROM buckets) AND NOT EXISTS (
    SELECT 1 FROM buckets WHERE content_class IN ('unavailable_or_oversize','unknown_shape',
      'unknown_event','linked_message','alternative_shape','attachment_limit','mixed_or_unknown_attachments')),
  'saved_key_groups', (SELECT count(*) FROM key_groups),
  'missing_or_invalid_saved_keys', (SELECT count(*) FROM buckets WHERE saved_key IS NULL),
  'receipts_per_saved_key', coalesce((SELECT json_agg(json_build_object(
    'receipts', receipts, 'groups', groups) ORDER BY receipts)
    FROM (SELECT receipts, count(*) AS groups FROM key_groups GROUP BY receipts) histogram), '[]'::json),
  'rows', coalesce((SELECT json_agg(json_build_object(
    'status', status, 'event_type', event_type, 'entity_type', entity_type,
    'content_class', content_class, 'receipts', receipts)
    ORDER BY status, event_type, entity_type, content_class)
    FROM (SELECT status, event_type, entity_type, content_class, count(*) AS receipts
      FROM buckets GROUP BY status, event_type, entity_type, content_class) grouped), '[]'::json)
) FROM bounds;`;
  return `${explain ? 'EXPLAIN (FORMAT JSON) ' : ''}${query}\n`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--explain'))
    throw new Error('Usage: webhook-workload-audit.mjs [--explain]');
  process.stdout.write(
    buildWebhookCohortIndexSql() + buildWebhookWorkloadAuditSql(args.length === 1),
  );
}
