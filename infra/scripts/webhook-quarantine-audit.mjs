import { pathToFileURL } from 'node:url';
import { buildWebhookCohortIndexSql } from './webhook-cohort-audit.mjs';

export const QUARANTINE_AUDIT_COLUMNS = [
  'receipt_id',
  'blocker_id',
  'anchor_id',
  'state',
  'deadline_at',
  'created_at',
  'next_check_at',
  'resolved_at',
];

export function validateQuarantineMinute(value) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value.replace('Z', '.000Z')
  )
    throw new Error('One exact UTC minute required');
}

export function buildQuarantinePrivilegesSql(required = false) {
  return `WITH effective AS (
    SELECT attribute.attname FROM pg_attribute attribute
    WHERE attribute.attrelid = to_regclass('public.webhook_dependency_quarantines')
      AND attribute.attnum > 0 AND NOT attribute.attisdropped
      AND has_column_privilege('maxim_audit', attribute.attrelid, attribute.attnum, 'SELECT')
  ) SELECT NOT coalesce(has_table_privilege('maxim_audit',
      to_regclass('public.webhook_dependency_quarantines'), 'SELECT'), false)
    AND (SELECT count(*) FROM effective) IN (${required ? '' : '0,'}${QUARANTINE_AUDIT_COLUMNS.length})
    AND NOT EXISTS (SELECT 1 FROM effective WHERE attname NOT IN (
      ${QUARANTINE_AUDIT_COLUMNS.map((column) => `'${column}'`).join(',')}
    )) AS quarantine_audit_privileges_ready \\gset
\\if :quarantine_audit_privileges_ready
\\else
\\echo MAXIM_QUARANTINE_AUDIT_PRIVILEGES_INVALID
SELECT 1 / 0;
\\endif
`;
}

export function buildQuarantineIndexSql() {
  return (
    buildWebhookCohortIndexSql() +
    `SELECT EXISTS (
    SELECT 1 FROM pg_index idx WHERE idx.indexrelid = to_regclass('public.webhook_dependency_quarantines_pkey')
      AND idx.indrelid = to_regclass('public.webhook_dependency_quarantines')
      AND idx.indisvalid AND idx.indisready AND idx.indislive AND idx.indisunique
      AND idx.indnkeyatts = 2 AND idx.indnatts = 2 AND idx.indpred IS NULL AND idx.indexprs IS NULL
      AND pg_get_indexdef(idx.indexrelid, 1, false) = 'receipt_id'
      AND pg_get_indexdef(idx.indexrelid, 2, false) = 'blocker_id'
  ) AS quarantine_audit_index_ready \\gset
\\if :quarantine_audit_index_ready
\\else
\\echo MAXIM_QUARANTINE_AUDIT_INDEX_INVALID
SELECT 1 / 0;
\\endif
`
  );
}

export function buildQuarantineAuditSql(minute, explain = false) {
  validateQuarantineMinute(minute);
  // FLAG: Cap the covered status/time walk before any journal or blocker reads.
  // Each receipt probes at most five journal keys, reports four, then reads only
  // those blockers by primary key. Evidence is observational, never replay authority.
  const query = `WITH bounds AS MATERIALIZED (
    SELECT '${minute}'::timestamp AS from_at, '${minute}'::timestamp + interval '1 minute' AS until_at,
      statement_timestamp() AT TIME ZONE 'UTC' AS observed_at
  ), candidates AS MATERIALIZED (
    SELECT head.id, head.created_at FROM bounds CROSS JOIN LATERAL (
      SELECT id, created_at FROM webhook_events
      WHERE status = 'QUARANTINED' AND created_at >= bounds.from_at AND created_at < bounds.until_at
      ORDER BY created_at, id LIMIT 65
    ) head WHERE bounds.until_at <= bounds.observed_at
  ), receipts AS MATERIALIZED (
    SELECT * FROM candidates ORDER BY created_at, id LIMIT 64
  ), summaries AS MATERIALIZED (
    SELECT receipt.created_at, journal.captured, journal.items
    FROM receipts receipt CROSS JOIN LATERAL (
      WITH journal_heads AS MATERIALIZED (
        SELECT blocker_id, anchor_id, state, deadline_at, created_at, next_check_at, resolved_at
        FROM webhook_dependency_quarantines WHERE receipt_id = receipt.id
        ORDER BY blocker_id LIMIT 5
      ), journal_sample AS MATERIALIZED (
        SELECT * FROM journal_heads ORDER BY blocker_id LIMIT 4
      )
      SELECT (SELECT count(*) FROM journal_heads) AS captured,
        coalesce(json_agg(json_build_object(
          'state', CASE WHEN entry.state IN ('WAITING','EXPIRED','RELEASED') THEN entry.state ELSE 'other' END,
          'created_at', entry.created_at, 'deadline_at', entry.deadline_at,
          'next_check_at', entry.next_check_at, 'resolved_at', entry.resolved_at,
          'anchor_is_blocker', entry.anchor_id = entry.blocker_id,
          'blocker_found', blocker.id IS NOT NULL, 'blocker_status', blocker.status,
          'blocker_created_at', blocker.created_at, 'blocker_processed_at', blocker.processed_at,
          'blocker_retry_scheduled', blocker.next_enqueue_at IS NOT NULL,
          'blocker_timeout_boundary', blocker.timeout_quarantine_expires_at,
          'blocker_error_family', CASE
            WHEN blocker.id IS NULL THEN 'missing_blocker'
            WHEN blocker.error_message IS NULL THEN 'none'
            WHEN blocker.error_message = 'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:LEGACY_EXECUTION_UNVERIFIED; exact effects proof required'
              THEN 'legacy_execution_unverified'
            WHEN blocker.error_message = 'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:CANONICAL_BUSINESS_ALREADY_STARTED; durable-effects recovery required'
              THEN 'canonical_business_started'
            WHEN blocker.error_message ~ '^WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}: Webhook user-facing hot path timed out after [1-9][0-9]*ms for (message_created|message_edited)([[:space:]]\\|[[:space:]]|;|$)'
              THEN 'detached_timeout'
            WHEN starts_with(blocker.error_message, 'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:')
              THEN 'other_pending_quarantine'
            WHEN starts_with(blocker.error_message, 'WEBHOOK_HOT_PATH_TIMEOUT_TERMINAL_QUARANTINED:')
              THEN 'terminal_quarantine'
            WHEN blocker.error_message = 'Handler completion claim changed' THEN 'completion_claim_changed'
            ELSE 'other' END
        ) ORDER BY entry.blocker_id), '[]'::json) AS items
      FROM journal_sample entry LEFT JOIN LATERAL (
        SELECT id, status, created_at, processed_at, error_message, next_enqueue_at, timeout_quarantine_expires_at
        FROM webhook_events WHERE id = entry.blocker_id OFFSET 0
      ) blocker ON true
    ) journal
  ) SELECT json_build_object(
    'schema_version', 1, 'audit', 'webhook_quarantine', 'basis', 'currently_quarantined_receipt_created_at',
    'from', bounds.from_at, 'until', bounds.until_at, 'observed_at', bounds.observed_at,
    'window_closed', bounds.until_at <= bounds.observed_at,
    'sample_complete', (SELECT count(*) <= 64 FROM candidates) AND NOT EXISTS (SELECT 1 FROM summaries WHERE captured > 4),
    'receipts_truncated', (SELECT count(*) > 64 FROM candidates),
    'sampled_receipts', (SELECT count(*) FROM receipts),
    'remote_effects_proven', false, 'replay_authorized', false,
    'rows', coalesce((SELECT json_agg(json_build_object(
      'receipt_created_at', created_at, 'journal_found', captured > 0,
      'journal_truncated', captured > 4, 'blockers', items
    ) ORDER BY created_at) FROM summaries), '[]'::json)
  ) FROM bounds;`;
  return `${explain ? 'EXPLAIN (FORMAT JSON) ' : ''}${query}\n`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [minute, option, ...extra] = process.argv.slice(2);
  if (extra.length) throw new Error('Unexpected quarantine audit arguments');
  if (minute === '--privileges') {
    if (option !== undefined && option !== '--require-all')
      throw new Error('Invalid privilege arguments');
    process.stdout.write(buildQuarantinePrivilegesSql(option === '--require-all'));
  } else {
    if (option !== undefined && option !== '--explain') throw new Error('Invalid report arguments');
    process.stdout.write(
      buildQuarantineIndexSql() + buildQuarantineAuditSql(minute, option === '--explain'),
    );
  }
}
