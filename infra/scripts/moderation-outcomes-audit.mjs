import { pathToFileURL } from 'node:url';

export function buildModerationOutcomesIndexReadinessSql() {
  return `SELECT EXISTS (
  SELECT 1 FROM pg_index definition
  JOIN pg_class index_relation ON index_relation.oid = definition.indexrelid
  JOIN pg_am method ON method.oid = index_relation.relam
  WHERE definition.indexrelid = to_regclass('public.moderation_events_created_at_idx')
    AND definition.indrelid = to_regclass('public.moderation_events')
    AND definition.indisvalid AND definition.indisready AND definition.indislive
    AND method.amname = 'btree' AND definition.indnkeyatts = 1 AND definition.indnatts = 1
    AND definition.indpred IS NULL AND definition.indexprs IS NULL
    AND pg_get_indexdef(definition.indexrelid, 1, true) = 'created_at'
    AND definition.indoption[0] = 0
    AND NOT EXISTS (
      SELECT 1 FROM unnest(definition.indclass) class_oid
      JOIN pg_opclass operator_class ON operator_class.oid = class_oid
      WHERE NOT operator_class.opcdefault OR operator_class.opcnamespace <> 'pg_catalog'::regnamespace
    )
) AND EXISTS (
  SELECT 1 FROM pg_attribute attribute
  WHERE attribute.attrelid = to_regclass('public.moderation_events')
    AND attribute.attname = 'created_at' AND NOT attribute.attisdropped
    AND attribute.atttypid = 'timestamp without time zone'::regtype
    AND attribute.atttypmod = 3
) AS moderation_outcomes_index_ready \\gset
\\if :moderation_outcomes_index_ready
\\else
\\echo 'Required moderation outcome index is unavailable or incompatible; refusing diagnostics.'
\\quit 3
\\endif
`;
}

export function buildModerationOutcomesAuditSql(explain = false) {
  // FLAG: Bound the sole base-table walk before inspecting metadata or action. The report
  // contains only fixed evidence categories and timestamps, never identities or free text.
  // A persisted MUTE proves installation, not current activation or later enforcement. Only
  // its independent verified DELETE marker proves enforcement; queue/API counters do not.
  const query = `WITH candidates AS MATERIALIZED (
  SELECT action, operator, event_type, rule_code, metadata, created_at
  FROM moderation_events
  WHERE created_at >= statement_timestamp() - interval '60 minutes'
    AND created_at <= statement_timestamp()
  ORDER BY created_at DESC LIMIT 513
), sample AS MATERIALIZED (
  SELECT * FROM candidates ORDER BY created_at DESC LIMIT 512
), classified AS MATERIALIZED (
  SELECT created_at,
    CASE
      WHEN action = 'BAN' AND operator = 'BOT'
        AND metadata->'sanctionApplied' = 'true'::jsonb
        THEN 'BAN_REMOTE_CONFIRMED'
      WHEN action = 'BAN' AND operator = 'ADMIN' AND event_type = 'MEMBER_ACTION'
        AND rule_code = 'MANUAL_BAN' AND metadata->>'mode' = 'MAX_BLOCK'
        THEN 'BAN_REMOTE_CONFIRMED'
      WHEN action = 'BAN' AND operator = 'ADMIN' AND event_type = 'MEMBER_ACTION'
        AND rule_code = 'MANUAL_BAN' AND metadata->>'mode' = 'MAX_REMOVE_ONLY'
        THEN 'MEMBER_REMOVAL_REMOTE_CONFIRMED'
      WHEN action = 'BAN' THEN 'BAN_EVENT_UNVERIFIED'
      WHEN action = 'MUTE' AND ((operator = 'BOT'
        AND metadata->'sanctionApplied' = 'true'::jsonb)
        OR (operator = 'ADMIN' AND event_type = 'MEMBER_ACTION' AND rule_code = 'MANUAL_MUTE'))
        THEN 'MUTE_INSTALLED'
      WHEN action = 'MUTE' THEN 'MUTE_EVENT_UNVERIFIED'
      WHEN action = 'DELETE_MESSAGE' AND operator = 'BOT' AND rule_code = 'MUTE_ACTIVE_DELETE'
        AND metadata->'moderationDeleteVerified' = 'true'::jsonb
        THEN 'MUTE_ENFORCEMENT_REMOTE_CONFIRMED'
      WHEN action = 'DELETE_MESSAGE' AND rule_code = 'MUTE_ACTIVE_DELETE'
        THEN 'MUTE_ENFORCEMENT_EVENT_UNVERIFIED'
      ELSE 'OTHER_EVENT'
    END AS evidence,
    CASE WHEN operator = 'ADMIN' THEN 'ADMIN'
      WHEN operator = 'BOT' THEN 'BOT' ELSE 'UNKNOWN' END AS origin
  FROM sample
), grouped AS (
  SELECT evidence, origin, count(*) AS count_lower_bound,
    min(created_at) AS oldest_recorded_at, max(created_at) AS newest_recorded_at
  FROM classified WHERE evidence <> 'OTHER_EVENT' GROUP BY evidence, origin
)
SELECT json_build_object(
  'schema_version', 1, 'audit', 'recent_moderation_outcomes',
  'window_start_at', statement_timestamp() - interval '60 minutes',
  'window_end_at', statement_timestamp(), 'window_basis', 'event_recorded_at',
  'sample_cap', 512, 'sampled_events', (SELECT count(*) FROM sample),
  'sample_truncated', (SELECT count(*) > 512 FROM candidates),
  'sample_complete', (SELECT count(*) <= 512 FROM candidates),
  'oldest_recorded_at', (SELECT min(created_at) FROM sample),
  'newest_recorded_at', (SELECT max(created_at) FROM sample),
  'other_events', (SELECT count(*) FROM classified WHERE evidence = 'OTHER_EVENT'),
  'all_attempts_observed', false, 'current_mute_state_proven', false,
  'fleet_health_proven', false,
  'rows', coalesce((SELECT json_agg(grouped ORDER BY evidence, origin) FROM grouped), '[]'::json)
);`;
  return `${explain ? 'EXPLAIN (FORMAT JSON) ' : ''}${query}\n`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--explain')) {
    throw new Error('Usage: moderation-outcomes-audit.mjs [--explain]');
  }
  process.stdout.write(
    buildModerationOutcomesIndexReadinessSql() +
      buildModerationOutcomesAuditSql(args[0] === '--explain'),
  );
}
