import { Prisma } from '../prisma/prisma-client';

export function buildSafetyDeskWebhookCohortIndexQuery(): Prisma.Sql {
  return Prisma.sql`SELECT EXISTS (
    SELECT 1 FROM pg_index i
    JOIN pg_class index_relation ON index_relation.oid = i.indexrelid
    JOIN pg_am access_method ON access_method.oid = index_relation.relam
    WHERE i.indexrelid = to_regclass('webhook_events_status_created_at_id_idx')
      AND i.indrelid = to_regclass('webhook_events')
      AND i.indisvalid AND i.indisready AND i.indislive
      AND access_method.amname = 'btree'
      AND i.indnkeyatts = 3 AND i.indnatts = 3
      AND i.indexprs IS NULL AND i.indpred IS NULL
      AND ARRAY(SELECT pg_get_indexdef(i.indexrelid, n, false)
        FROM generate_series(1, 3) n ORDER BY n) = ARRAY['status', 'created_at', 'id']
  ) AS ready`;
}

export function buildSafetyDeskWebhookCohortQuery(): Prisma.Sql {
  // FLAG: Select covered status heads before reading scalar metadata by primary key.
  // Every accepted status belongs to the closed cohort; completion is not effect proof.
  // Keep the reviewed collector's 513/512 bounds and never load event bodies here.
  return Prisma.sql`WITH bounds AS MATERIALIZED (
    SELECT statement_timestamp() AT TIME ZONE 'UTC' AS observed_at,
      (statement_timestamp() AT TIME ZONE 'UTC') - interval '60 seconds' AS from_at,
      (statement_timestamp() AT TIME ZONE 'UTC') - interval '30 seconds' AS until_at
  ), statuses(status) AS (VALUES
    ('RECEIVED'::"WebhookStatus"), ('QUEUED'::"WebhookStatus"),
    ('PROCESSED'::"WebhookStatus"), ('DUPLICATE'::"WebhookStatus"),
    ('FAILED'::"WebhookStatus"), ('NO_REPLAY_HELD'::"WebhookStatus"),
    ('CANCELLED'::"WebhookStatus"), ('QUARANTINED'::"WebhookStatus")
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
      metadata.execution_deadline_at, metadata.timeout_quarantine_expires_at
    FROM samples CROSS JOIN LATERAL (
      SELECT processed_at, queued_at, execution_deadline_at, timeout_quarantine_expires_at
      FROM webhook_events WHERE id = samples.id OFFSET 0
    ) metadata
  ), timings AS MATERIALIZED (
    SELECT details.*,
      CASE WHEN status = 'PROCESSED' AND processed_at >= created_at AND processed_at <= bounds.observed_at
        THEN extract(epoch FROM processed_at - created_at) * 1000 END AS processed_ms,
      CASE WHEN queued_at >= created_at AND queued_at <= bounds.observed_at
        THEN extract(epoch FROM queued_at - created_at) * 1000 END AS queued_ms
    FROM details CROSS JOIN bounds
  ), grouped AS (
    SELECT statuses.status,
      (SELECT count(*) FROM candidates c WHERE c.status = statuses.status AND c.id IS NOT NULL) AS captured,
      count(timings.created_at) AS sampled,
      CASE WHEN statuses.status IN ('RECEIVED', 'QUEUED')
        THEN max(extract(epoch FROM bounds.observed_at - timings.created_at)) END AS oldest_pending_age_seconds,
      count(*) FILTER (WHERE execution_deadline_at <= bounds.observed_at) AS expired_at_observation,
      count(timeout_quarantine_expires_at) AS quarantine_timestamp_present,
      count(*) FILTER (WHERE timings.status = 'PROCESSED' AND processed_ms IS NULL) AS invalid_processed_clocks,
      count(*) FILTER (WHERE queued_at IS NOT NULL AND queued_ms IS NULL) AS invalid_queued_clocks,
      count(processed_ms) AS processed_samples,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY processed_ms) AS processed_p95_ms,
      percentile_cont(0.99) WITHIN GROUP (ORDER BY processed_ms) AS processed_p99_ms,
      count(queued_ms) AS queued_samples,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY queued_ms) AS queued_p95_ms,
      percentile_cont(0.99) WITHIN GROUP (ORDER BY queued_ms) AS queued_p99_ms
    FROM statuses CROSS JOIN bounds LEFT JOIN timings ON timings.status = statuses.status
    GROUP BY statuses.status
  )
  SELECT jsonb_build_object(
    'schemaVersion', 1, 'basis', 'receipt_created_at', 'windowSeconds', 30, 'graceSeconds', 30,
    'windowStartedAt', to_char(bounds.from_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'windowEndedAt', to_char(bounds.until_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'observedAt', to_char(bounds.observed_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'sampleLimitPerStatus', 512,
    'sampleComplete', NOT EXISTS (SELECT 1 FROM grouped WHERE captured > 512),
    'totalCountLowerBound', (SELECT sum(sampled) FROM grouped), 'effectsEvidence', 'not_linked',
    'rows', (SELECT jsonb_agg(jsonb_build_object(
      'status', status, 'countLowerBound', sampled, 'truncated', captured > 512,
      'oldestPendingAgeSec', oldest_pending_age_seconds,
      'expiredAtObservation', expired_at_observation,
      'quarantineTimestampPresent', quarantine_timestamp_present,
      'invalidProcessedClocks', invalid_processed_clocks, 'invalidQueuedClocks', invalid_queued_clocks,
      'processedLatency', jsonb_build_object(
        'sampleCount', processed_samples, 'p95Ms', processed_p95_ms, 'p99Ms', processed_p99_ms),
      'enqueueLatency', jsonb_build_object(
        'sampleCount', queued_samples, 'p95Ms', queued_p95_ms, 'p99Ms', queued_p99_ms)
    ) ORDER BY status) FROM grouped)
  ) AS snapshot FROM bounds`;
}
