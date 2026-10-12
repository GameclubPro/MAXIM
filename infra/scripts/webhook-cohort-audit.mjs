import { pathToFileURL } from 'node:url';

export function buildWebhookCohortIndexSql() {
  return `SELECT EXISTS (
  SELECT 1 FROM pg_index i
  WHERE i.indexrelid = to_regclass('public.webhook_events_status_created_at_id_idx')
    AND i.indrelid = to_regclass('public.webhook_events')
    AND i.indisvalid AND i.indisready AND i.indislive
    AND i.indnkeyatts = 3 AND i.indnatts = 3
    AND i.indexprs IS NULL AND i.indpred IS NULL
    AND ARRAY(SELECT pg_get_indexdef(i.indexrelid, n, false)
      FROM generate_series(1, 3) n ORDER BY n) = ARRAY['status', 'created_at', 'id']
) AS webhook_cohort_index_ready \\gset
\\if :webhook_cohort_index_ready
\\else
\\echo MAXIM_WEBHOOK_COHORT_INDEX_UNAVAILABLE
SELECT 1 / 0;
\\endif
`;
}

export function buildWebhookCohortAuditSql(explain = false) {
  // FLAG: A closed receipt-created window includes every status. Bound covered
  // index reads before primary-key metadata fetches; no bodies or identities leave SQL.
  // Cancellation and duplicates are never included in processed-only latency.
  const query = `WITH bounds AS MATERIALIZED (
  SELECT statement_timestamp() AT TIME ZONE 'UTC' AS observed_at,
    (statement_timestamp() AT TIME ZONE 'UTC') - interval '60 seconds' AS from_at,
    (statement_timestamp() AT TIME ZONE 'UTC') - interval '30 seconds' AS until_at
), statuses(status) AS (VALUES
  ('RECEIVED'::"WebhookStatus"), ('QUEUED'::"WebhookStatus"),
  ('PROCESSED'::"WebhookStatus"), ('DUPLICATE'::"WebhookStatus"),
  ('FAILED'::"WebhookStatus"), ('NO_REPLAY_HELD'::"WebhookStatus"), ('CANCELLED'::"WebhookStatus"), ('QUARANTINED'::"WebhookStatus")
), candidates AS MATERIALIZED (
  SELECT statuses.status, head.id, head.created_at
  FROM statuses CROSS JOIN bounds
  LEFT JOIN LATERAL (
    SELECT id, created_at FROM webhook_events
    WHERE status = statuses.status AND created_at >= bounds.from_at AND created_at < bounds.until_at
    ORDER BY created_at, id LIMIT 513
  ) head ON true
), samples AS MATERIALIZED (
  SELECT * FROM (
    SELECT *, row_number() OVER (PARTITION BY status ORDER BY created_at, id) AS ordinal
    FROM candidates WHERE id IS NOT NULL
  ) ranked WHERE ordinal <= 512
), details AS MATERIALIZED (
  SELECT samples.status, samples.created_at, metadata.processed_at, metadata.queued_at,
    metadata.next_enqueue_at, metadata.timeout_quarantine_expires_at, metadata.execution_deadline_at,
    CASE WHEN samples.status = 'FAILED' THEN
      CASE
        WHEN metadata.error_message IS NULL THEN 'missing'
        WHEN metadata.error_message ~ '^NO_EXECUTABLE_OWNER; deadline=[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
          THEN 'no_executable_owner'
        WHEN starts_with(metadata.error_message, 'WEBHOOK_HOT_PATH_TIMEOUT_TERMINAL_QUARANTINED:')
          THEN 'terminal_quarantine_marker'
        WHEN starts_with(metadata.error_message, 'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:')
          THEN 'pending_quarantine_marker'
        WHEN metadata.error_message ~ '^(Webhook preparation failed: )?Canonical webhook claim is not ready for .+'
          THEN 'canonical_not_ready'
        WHEN metadata.error_message ~ '^(Webhook preparation failed: )?Canonical webhook business lease is busy for .+'
          THEN 'business_lease_busy'
        WHEN metadata.error_message ~ '^(Webhook preparation failed: )?Canonical webhook business lease was lost (before completion|before unfenced timeout settlement|during timeout quarantine) for .+'
          THEN 'business_lease_lost'
        WHEN metadata.error_message ~ '^(Webhook preparation failed: )?Canonical webhook business lease storage is unavailable for .+'
          THEN 'business_lease_unavailable'
        WHEN metadata.error_message = 'Handler completion claim changed'
          THEN 'completion_claim_changed'
        WHEN metadata.error_message = 'timeout exceeded when trying to connect'
          THEN 'connection_admission_timeout_text'
        ELSE 'other'
      END
    END AS failure_family
  FROM samples CROSS JOIN LATERAL (
    SELECT processed_at, queued_at, next_enqueue_at, timeout_quarantine_expires_at,
      execution_deadline_at, error_message
    FROM webhook_events WHERE id = samples.id OFFSET 0
  ) metadata
), failure_rows AS (
  -- FLAG: Saved text is untrusted diagnostic evidence, never replay authority.
  -- Classify only the already bounded primary-key samples; never emit raw errors.
  SELECT failure_family, count(*) AS sampled,
    count(*) FILTER (WHERE next_enqueue_at IS NOT NULL) AS retry_scheduled,
    count(*) FILTER (WHERE timeout_quarantine_expires_at IS NOT NULL) AS quarantine_timestamp_present,
    count(*) FILTER (WHERE execution_deadline_at <= created_at) AS deadline_elapsed_at_receipt,
    count(*) FILTER (WHERE execution_deadline_at <= bounds.observed_at) AS deadline_elapsed_at_observation
  FROM details CROSS JOIN bounds WHERE status = 'FAILED'
  GROUP BY failure_family
), grouped AS (
  SELECT statuses.status,
    (SELECT count(*) FROM candidates c WHERE c.status = statuses.status AND c.id IS NOT NULL) AS captured,
    count(details.created_at) AS sampled,
    CASE WHEN statuses.status IN ('RECEIVED', 'QUEUED')
      THEN max(extract(epoch FROM bounds.observed_at - details.created_at)) ELSE NULL END AS oldest_pending_age_seconds,
    count(*) FILTER (WHERE details.status = 'PROCESSED' AND
      (processed_at IS NULL OR processed_at < details.created_at OR processed_at > bounds.observed_at)) AS invalid_processed_clocks,
    count(*) FILTER (WHERE queued_at < details.created_at OR queued_at > bounds.observed_at) AS invalid_queued_clocks,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM processed_at - details.created_at) * 1000)
      FILTER (WHERE details.status = 'PROCESSED' AND processed_at >= details.created_at AND processed_at <= bounds.observed_at) AS processed_only_p95_ms,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM queued_at - details.created_at) * 1000)
      FILTER (WHERE queued_at >= details.created_at AND queued_at <= bounds.observed_at) AS queued_sample_p95_ms
  FROM statuses CROSS JOIN bounds LEFT JOIN details ON details.status = statuses.status
  GROUP BY statuses.status
)
SELECT json_build_object(
  'schema_version', 2, 'audit', 'closed_webhook_cohort', 'window_basis', 'receipt_created_at',
  'from', bounds.from_at, 'until', bounds.until_at, 'observed_at', bounds.observed_at,
  'cap_per_status', 512, 'sample_complete', NOT EXISTS (SELECT 1 FROM grouped WHERE captured > 512),
  'nonempty', EXISTS (SELECT 1 FROM samples), 'remote_effects_proven', false,
  'failure_classification_authority', 'saved_metadata_only',
  'failure_families', coalesce((SELECT json_agg(json_build_object(
    'family', failure_family, 'count_lower_bound', sampled,
    'retry_scheduled', retry_scheduled, 'quarantine_timestamp_present', quarantine_timestamp_present,
    'deadline_elapsed_at_receipt', deadline_elapsed_at_receipt,
    'deadline_elapsed_at_observation', deadline_elapsed_at_observation
  ) ORDER BY failure_family) FROM failure_rows), '[]'::json),
  'rows', (SELECT json_agg(json_build_object(
    'status', status, 'count_lower_bound', sampled, 'truncated', captured > 512,
    'oldest_pending_age_seconds', oldest_pending_age_seconds,
    'invalid_processed_clocks', invalid_processed_clocks, 'invalid_queued_clocks', invalid_queued_clocks,
    'processed_only_p95_ms', processed_only_p95_ms, 'queued_sample_p95_ms', queued_sample_p95_ms
  ) ORDER BY status) FROM grouped)
) FROM bounds;`;
  return `${explain ? 'EXPLAIN (FORMAT JSON) ' : ''}${query}\n`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--explain'))
    throw new Error('Usage: webhook-cohort-audit.mjs [--explain]');
  process.stdout.write(
    buildWebhookCohortIndexSql() + buildWebhookCohortAuditSql(args[0] === '--explain'),
  );
}
