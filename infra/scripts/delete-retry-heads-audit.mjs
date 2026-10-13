import { pathToFileURL } from 'node:url';

export function buildDeleteRetryHeadsIndexSql() {
  return `SELECT EXISTS (SELECT 1 FROM pg_index i
    WHERE i.indexrelid = to_regclass('public.moderation_delete_intents_due_idx')
      AND i.indrelid = to_regclass('public.moderation_delete_intents')
      AND i.indisvalid AND i.indisready AND i.indislive
      AND i.indnkeyatts = 3 AND i.indexprs IS NULL AND i.indpred IS NULL
      AND pg_get_indexdef(i.indexrelid, 1, false) = 'status'
      AND pg_get_indexdef(i.indexrelid, 2, false) = 'next_attempt_at'
      AND pg_get_indexdef(i.indexrelid, 3, false) = 'execute_at')
    AND EXISTS (SELECT 1 FROM pg_index i
    WHERE i.indexrelid = to_regclass('public.moderation_delete_intents_retention_idx')
      AND i.indrelid = to_regclass('public.moderation_delete_intents')
      AND i.indisvalid AND i.indisready AND i.indislive
      AND i.indnkeyatts = 2 AND i.indexprs IS NULL AND i.indpred IS NULL
      AND pg_get_indexdef(i.indexrelid, 1, false) = 'status'
      AND pg_get_indexdef(i.indexrelid, 2, false) = 'updated_at')
    AND EXISTS (SELECT 1 FROM pg_index i
    WHERE i.indexrelid = to_regclass('public.moderation_delete_intent_reasons_intent_reason_key')
      AND i.indrelid = to_regclass('public.moderation_delete_intent_reasons')
      AND i.indisvalid AND i.indisready AND i.indislive AND i.indisunique
      AND i.indnkeyatts = 2 AND i.indexprs IS NULL AND i.indpred IS NULL
      AND pg_get_indexdef(i.indexrelid, 1, false) = 'intent_id'
      AND pg_get_indexdef(i.indexrelid, 2, false) = 'reason_key') AS delete_retry_indexes_ready \\gset
\\if :delete_retry_indexes_ready
\\else
\\echo MAXIM_DELETE_RETRY_INDEX_UNAVAILABLE
\\quit 3
\\endif
`;
}

export function buildDeleteRetryHeadsAuditSql(explain = false) {
  // FLAG: Bound each indexed status head before payload/reason reads. These are
  // observations of retry clocks, not executable selection or replay authority.
  const branches = ['PENDING', 'RETRYABLE', 'WAITING_CAPABILITY', 'AMBIGUOUS', 'IN_PROGRESS'].map(
    (
      status,
    ) => `(SELECT id, status, next_attempt_at, 'oldest_retry' AS sample_kind FROM moderation_delete_intents
      WHERE status = '${status}'::"ModerationDeleteIntentStatus"
      ORDER BY next_attempt_at LIMIT 33)`,
  );
  return `${explain ? 'EXPLAIN (FORMAT JSON) ' : ''}WITH heads AS MATERIALIZED (
    ${branches.join('\nUNION ALL\n')}
    UNION ALL (SELECT id, status, next_attempt_at, 'recent_update' AS sample_kind FROM moderation_delete_intents
      WHERE status = 'AMBIGUOUS'::"ModerationDeleteIntentStatus" ORDER BY updated_at DESC LIMIT 33)
  ), samples AS MATERIALIZED (
    SELECT * FROM (SELECT *, row_number() OVER (PARTITION BY sample_kind, status ORDER BY next_attempt_at, id) AS ordinal
      FROM heads) ranked WHERE ordinal <= 32
  ), observations AS (
    SELECT md5(samples.id) AS intent_hash, samples.status, samples.sample_kind, samples.next_attempt_at,
      row.updated_at, row.attempt_count, row.last_attempt_at, row.retry_until_at,
      row.delete_dispatch_started_at IS NOT NULL AS dispatch_started,
      row.remote_delete_succeeded_at IS NOT NULL AS remote_success_marker,
      row.lease_expires_at, row.last_status_code,
      (SELECT json_build_object('truncated', count(*) > 64,
        'codes', coalesce(json_agg(CASE WHEN reason.rule_code IN (
          'VOICE_BLOCKED_DELETE', 'BOT_MESSAGE_AUTO_DELETE', 'COMMERCIAL_OCR_DELETE',
          'DUPLICATE_DELETE', 'REQUIRED_SUBSCRIPTION_DELETE', 'CHANNEL_AUTO_POST_FORWARD_REPLACEMENT_CLEANUP',
          'MESSAGE_TOO_LONG_DELETE', 'STICKER_RATE_LIMIT_DELETE', 'PHOTO_BLOCKED_DELETE',
          'VIDEO_BLOCKED_DELETE', 'FILE_BLOCKED_DELETE', 'MUTE_DELETE') THEN reason.rule_code ELSE 'other' END), '[]'::json))
       FROM (SELECT rule_code FROM moderation_delete_intent_reasons WHERE intent_id = samples.id
          ORDER BY reason_key LIMIT 65) reason) AS reasons
    FROM samples CROSS JOIN LATERAL (SELECT updated_at, attempt_count, last_attempt_at, retry_until_at,
      delete_dispatch_started_at, remote_delete_succeeded_at, lease_expires_at, last_status_code
      FROM moderation_delete_intents WHERE id = samples.id OFFSET 0) row
  ) SELECT json_build_object('schema_version',1,'audit','delete_retry_heads',
    'observed_at',statement_timestamp(),'policy_checked',false,'remote_effect_proven',false,
    'per_group_cap',32,'sample_truncated',EXISTS (SELECT 1 FROM heads GROUP BY sample_kind, status HAVING count(*) > 32),
    'rows',coalesce((SELECT json_agg(observations ORDER BY status,next_attempt_at,intent_hash) FROM observations),'[]'::json));\n`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [option, ...rest] = process.argv.slice(2);
  if (rest.length || (option !== undefined && option !== '--explain'))
    throw new Error('Expected only --explain or no arguments');
  process.stdout.write(
    buildDeleteRetryHeadsIndexSql() + buildDeleteRetryHeadsAuditSql(option === '--explain'),
  );
}
