import { Prisma } from '../prisma/prisma-client';

export function buildSafetyDeskPublicationCohortIndexQuery(): Prisma.Sql {
  return Prisma.sql`WITH required(index_name, table_name, columns) AS (VALUES
    ('publication_occurrences_dispatch_status_created_id_idx', 'publication_occurrences',
      ARRAY['dispatch_profile', 'status', 'created_at', 'id']),
    ('publication_occurrences_pkey', 'publication_occurrences', ARRAY['id']),
    ('publication_schedules_pkey', 'publication_schedules', ARRAY['id']),
    ('publication_content_revisions_pkey', 'publication_content_revisions', ARRAY['id']),
    ('publication_content_assets_revision_position_key', 'publication_content_assets',
      ARRAY['content_revision_id', 'position']),
    ('publication_assets_pkey', 'publication_assets', ARRAY['id'])
  ) SELECT bool_and(EXISTS (
    SELECT 1 FROM pg_index i
    JOIN pg_class index_relation ON index_relation.oid = i.indexrelid
    JOIN pg_am access_method ON access_method.oid = index_relation.relam
    WHERE i.indexrelid = to_regclass(required.index_name)
      AND i.indrelid = to_regclass(required.table_name)
      AND i.indisvalid AND i.indisready AND i.indislive
      AND (required.index_name = 'publication_occurrences_dispatch_status_created_id_idx' OR i.indisunique)
      AND access_method.amname = 'btree'
      AND i.indnkeyatts = cardinality(required.columns)
      AND i.indnatts = cardinality(required.columns)
      AND 0 = ALL(i.indoption::smallint[])
      AND i.indexprs IS NULL AND i.indpred IS NULL
      AND ARRAY(SELECT pg_get_indexdef(i.indexrelid, n, false)
        FROM generate_series(1, cardinality(required.columns)) n ORDER BY n) =
        ARRAY(SELECT quote_ident(column_name) FROM unnest(required.columns) column_name)
  )) AS ready FROM required`;
}

export function buildSafetyDeskPublicationCohortQuery(): Prisma.Sql {
  // FLAG: This denominator is accepted occurrences, not requests, retries or recipients.
  // Bound every status head before scalar PK reads; never join the recipient audience.
  // FLAG: Asset extrema use opposite index ends; payload reads probe only positions 0..9.
  // A LIMIT over an asset list may sort an unbounded bitmap result before applying its cap.
  return Prisma.sql`WITH bounds AS MATERIALIZED (
    SELECT statement_timestamp() AT TIME ZONE 'UTC' AS observed_at,
      (statement_timestamp() AT TIME ZONE 'UTC') - interval '930 seconds' AS from_at,
      (statement_timestamp() AT TIME ZONE 'UTC') - interval '30 seconds' AS until_at
  ), statuses(status) AS (VALUES
    ('SCHEDULED'::"PublicationOccurrenceStatus"), ('IN_PROGRESS'::"PublicationOccurrenceStatus"),
    ('SENT'::"PublicationOccurrenceStatus"), ('PARTIAL'::"PublicationOccurrenceStatus"),
    ('FAILED'::"PublicationOccurrenceStatus"), ('AMBIGUOUS'::"PublicationOccurrenceStatus"),
    ('CANCELED'::"PublicationOccurrenceStatus")
  ), candidates AS MATERIALIZED (
    SELECT statuses.status, head.id, head.created_at
    FROM statuses CROSS JOIN bounds
    LEFT JOIN LATERAL (
      SELECT id, created_at FROM publication_occurrences
      WHERE dispatch_profile = 'PUBLIK_V1'::"PublicationDispatchProfile"
        AND status = statuses.status AND created_at >= bounds.from_at AND created_at < bounds.until_at
      ORDER BY created_at, id LIMIT 513
    ) head ON true
  ), samples AS MATERIALIZED (
    SELECT * FROM (
      SELECT *, row_number() OVER (PARTITION BY status ORDER BY created_at, id) AS ordinal
      FROM candidates WHERE id IS NOT NULL
    ) ranked WHERE ordinal <= 512
  ), details AS MATERIALIZED (
    SELECT samples.status, samples.created_at, metadata.*
    FROM samples CROSS JOIN LATERAL (
      SELECT publication_id, schedule_id, content_revision_id, schedule_revision, scheduled_at,
        delivery_deadline_at, retry_authorized_at, retry_expires_at,
        dispatch_blocker_code, dispatch_blocked_at
      FROM publication_occurrences WHERE id = samples.id OFFSET 0
    ) metadata
  ), schedule_ids AS MATERIALIZED (
    SELECT DISTINCT schedule_id FROM details
  ), schedules AS MATERIALIZED (
    SELECT metadata.* FROM schedule_ids CROSS JOIN LATERAL (
      SELECT id, publication_id, revision, mode, created_at
      FROM publication_schedules WHERE id = schedule_ids.schedule_id OFFSET 0
    ) metadata
  ), content_ids AS MATERIALIZED (
    SELECT DISTINCT content_revision_id FROM details
  ), contents AS MATERIALIZED (
    SELECT metadata.* FROM content_ids CROSS JOIN LATERAL (
      SELECT id, publication_id, created_at FROM publication_content_revisions
      WHERE id = content_ids.content_revision_id OFFSET 0
    ) metadata
  ), asset_bounds AS MATERIALIZED (
    SELECT contents.id AS content_revision_id,
      (SELECT min(position) FROM publication_content_assets
        WHERE content_revision_id = contents.id) AS first_position,
      (SELECT max(position) FROM publication_content_assets
        WHERE content_revision_id = contents.id) AS last_position
    FROM contents
  ), asset_heads AS MATERIALIZED (
    SELECT asset_bounds.content_revision_id, positions.position, metadata.asset_id
    FROM asset_bounds CROSS JOIN generate_series(0, 9) AS positions(position)
    CROSS JOIN LATERAL (
      SELECT asset_id FROM publication_content_assets
      WHERE content_revision_id = asset_bounds.content_revision_id
        AND position = positions.position OFFSET 0
    ) metadata
    WHERE first_position = 0 AND last_position BETWEEN 0 AND 9
      AND positions.position <= last_position
  ), asset_ids AS MATERIALIZED (
    SELECT DISTINCT asset_id FROM asset_heads
  ), assets AS MATERIALIZED (
    SELECT metadata.* FROM asset_ids CROSS JOIN LATERAL (
      SELECT id, mime_type FROM publication_assets WHERE id = asset_ids.asset_id OFFSET 0
    ) metadata
  ), media AS MATERIALIZED (
    SELECT asset_bounds.content_revision_id,
      CASE WHEN first_position IS NULL AND last_position IS NULL THEN 'TEXT'
        WHEN first_position <> 0 OR last_position NOT BETWEEN 0 AND 9
          OR count(asset_heads.asset_id) <> last_position + 1
          OR count(assets.id) <> count(asset_heads.asset_id) THEN 'UNKNOWN'
        WHEN bool_and(lower(assets.mime_type) LIKE 'image/%') THEN 'IMAGE'
        WHEN last_position = 0 AND bool_and(lower(assets.mime_type) LIKE 'video/%') THEN 'VIDEO'
        ELSE 'UNKNOWN' END AS kind
    FROM asset_bounds LEFT JOIN asset_heads USING (content_revision_id)
    LEFT JOIN assets ON assets.id = asset_heads.asset_id
    GROUP BY asset_bounds.content_revision_id, first_position, last_position
  ), evidence AS MATERIALIZED (
    SELECT details.*,
      status IN ('SCHEDULED', 'IN_PROGRESS') AS pending,
      retry_authorized_at IS NOT NULL OR
        (dispatch_blocker_code = 'PUBLISHER_EXPLICIT_RETRY' AND dispatch_blocked_at IS NOT NULL)
        AS retry_recorded,
      retry_authorized_at IS NOT NULL OR retry_expires_at IS NOT NULL OR
        COALESCE(dispatch_blocker_code = 'PUBLISHER_EXPLICIT_RETRY', false) AS retry_present,
      CASE WHEN delivery_deadline_at >= scheduled_at THEN delivery_deadline_at END AS original_deadline,
      retry_authorized_at >= details.created_at AND retry_authorized_at <= bounds.observed_at
        AND retry_expires_at >= retry_authorized_at AS retry_valid,
      CASE WHEN schedules.publication_id = details.publication_id
          AND schedules.revision = details.schedule_revision AND details.schedule_revision > 0
          AND schedules.created_at <= details.created_at
        THEN schedules.mode::text ELSE 'UNKNOWN' END AS mode,
      CASE WHEN contents.publication_id = details.publication_id
          AND contents.created_at <= details.created_at
          AND retry_authorized_at IS NULL AND retry_expires_at IS NULL
          AND dispatch_blocker_code IS DISTINCT FROM 'PUBLISHER_EXPLICIT_RETRY'
        THEN COALESCE(media.kind, 'UNKNOWN') ELSE 'UNKNOWN' END AS media_kind
    FROM details CROSS JOIN bounds
    LEFT JOIN schedules ON schedules.id = details.schedule_id
    LEFT JOIN contents ON contents.id = details.content_revision_id
    LEFT JOIN media ON media.content_revision_id = details.content_revision_id
  ), deadlines AS MATERIALIZED (
    SELECT evidence.*,
      CASE WHEN NOT retry_present THEN original_deadline
        WHEN retry_valid AND original_deadline IS NOT NULL
          THEN greatest(original_deadline, retry_expires_at)
        WHEN retry_valid AND retry_expires_at >= bounds.observed_at THEN retry_expires_at
        ELSE NULL END AS effective_deadline
    FROM evidence CROSS JOIN bounds
  ), grouped AS (
    SELECT statuses.status,
      (SELECT count(*) FROM candidates c WHERE c.status = statuses.status AND c.id IS NOT NULL) AS captured,
      count(deadlines.created_at) AS sampled,
      count(*) FILTER (WHERE pending AND scheduled_at > bounds.observed_at) AS pending_not_due,
      count(*) FILTER (WHERE pending AND scheduled_at <= bounds.observed_at
        AND effective_deadline >= bounds.observed_at) AS pending_due,
      count(*) FILTER (WHERE pending AND scheduled_at <= bounds.observed_at
        AND effective_deadline < bounds.observed_at) AS pending_expired,
      count(*) FILTER (WHERE pending AND scheduled_at <= bounds.observed_at
        AND effective_deadline IS NULL) AS pending_timing_unknown,
      count(*) FILTER (WHERE pending AND dispatch_blocker_code IS NOT NULL
        AND dispatch_blocker_code <> 'PUBLISHER_EXPLICIT_RETRY') AS blocked_pending,
      count(*) FILTER (WHERE retry_recorded) AS retry_authorized_count,
      max(extract(epoch FROM bounds.observed_at - scheduled_at)) FILTER (
        WHERE pending AND scheduled_at <= bounds.observed_at
          AND effective_deadline >= bounds.observed_at) AS oldest_due_age_seconds,
      jsonb_build_object(
        'NOW', count(*) FILTER (WHERE mode = 'NOW'),
        'ONCE', count(*) FILTER (WHERE mode = 'ONCE'),
        'SLOTS', count(*) FILTER (WHERE mode = 'SLOTS'),
        'RECURRENCE', count(*) FILTER (WHERE mode = 'RECURRENCE'),
        'UNKNOWN', count(*) FILTER (WHERE mode = 'UNKNOWN')) AS mode_counts,
      jsonb_build_object(
        'TEXT', count(*) FILTER (WHERE media_kind = 'TEXT'),
        'IMAGE', count(*) FILTER (WHERE media_kind = 'IMAGE'),
        'VIDEO', count(*) FILTER (WHERE media_kind = 'VIDEO'),
        'UNKNOWN', count(*) FILTER (WHERE media_kind = 'UNKNOWN')) AS media_counts
    FROM statuses CROSS JOIN bounds LEFT JOIN deadlines ON deadlines.status = statuses.status
    GROUP BY statuses.status
  )
  SELECT jsonb_build_object(
    'schemaVersion', 1, 'basis', 'occurrence_created_at', 'dispatchProfile', 'PUBLIK_V1',
    'windowSeconds', 900, 'graceSeconds', 30,
    'windowStartedAt', to_char(bounds.from_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'windowEndedAt', to_char(bounds.until_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'observedAt', to_char(bounds.observed_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'sampleLimitPerStatus', 512,
    'sampleComplete', NOT EXISTS (SELECT 1 FROM grouped WHERE captured > 512),
    'totalCountLowerBound', (SELECT sum(sampled) FROM grouped),
    'completionTimingEvidence', 'not_recorded', 'effectsEvidence', 'occurrence_status_only',
    'rows', (SELECT jsonb_agg(jsonb_build_object(
      'status', status, 'countLowerBound', sampled, 'truncated', captured > 512,
      'pendingNotDue', pending_not_due, 'pendingDue', pending_due,
      'pendingExpired', pending_expired, 'pendingTimingUnknown', pending_timing_unknown,
      'blockedPending', blocked_pending, 'retryAuthorizedCount', retry_authorized_count,
      'oldestDueAgeSec', oldest_due_age_seconds, 'modeCounts', mode_counts, 'mediaCounts', media_counts
    ) ORDER BY status) FROM grouped)
  ) AS snapshot FROM bounds`;
}
