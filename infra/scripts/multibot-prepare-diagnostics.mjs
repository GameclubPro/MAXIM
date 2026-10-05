import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const MULTIBOT_PREPARATION_RECEIPT_COLUMNS = Object.freeze([
  'id',
  'migration_name',
  'checksum',
  'started_at',
  'finished_at',
  'rolled_back_at',
  'applied_steps_count',
  'logs',
]);
export const MULTIBOT_PREPARATION_MIGRATIONS = Object.freeze([
  '20261005015900_prepare_multibot_webhook_columns',
  '20261005016000_add_multibot_semantic_order_index',
  '20261005016100_index_multibot_retention_cursor',
  '20261005020000_add_multibot_order_fences',
  '20261005020200_preserve_semantic_execution_tombstones',
]);
export const multibotPreparationChecksums = Object.freeze(
  Object.fromEntries(
    MULTIBOT_PREPARATION_MIGRATIONS.map((name) => [
      name,
      createHash('sha256')
        .update(
          readFileSync(
            resolve(import.meta.dirname, '../../apps/api/prisma/migrations', name, 'migration.sql'),
          ),
        )
        .digest('hex'),
    ]),
  ),
);

const receiptValues = MULTIBOT_PREPARATION_MIGRATIONS.map(
  (name, position) => `('${name}', '${multibotPreparationChecksums[name]}', ${position + 1})`,
).join(',\n    ');

// FLAG: Both audit and EXPLAIN require exactly the effective receipt metadata grants.
// Direct grants alone cannot establish this boundary: inherited/PUBLIC SELECT or even a
// column-only mutation grant must reject the probe before any migration rows are read.
export const multibotPreparationReceiptPrivilegesSql = `SELECT
  pg_has_role(current_user, 'pg_read_all_stats', 'USAGE')
  AND NOT has_table_privilege('public._prisma_migrations', 'SELECT')
  AND NOT has_table_privilege('public._prisma_migrations', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
  AND (SELECT count(*) = 8 FROM pg_attribute attribute
    WHERE attribute.attrelid = 'public._prisma_migrations'::regclass
      AND attribute.attnum > 0 AND NOT attribute.attisdropped
      AND attribute.attname IN (${MULTIBOT_PREPARATION_RECEIPT_COLUMNS.map((name) => `'${name}'`).join(', ')})
      AND has_column_privilege(attribute.attrelid, attribute.attnum, 'SELECT'))
  AND NOT EXISTS (SELECT 1 FROM pg_attribute attribute
    WHERE attribute.attrelid = 'public._prisma_migrations'::regclass
      AND attribute.attnum > 0 AND NOT attribute.attisdropped
      AND ((attribute.attname NOT IN (${MULTIBOT_PREPARATION_RECEIPT_COLUMNS.map((name) => `'${name}'`).join(', ')})
          AND has_column_privilege(attribute.attrelid, attribute.attnum, 'SELECT'))
        OR has_column_privilege(attribute.attrelid, attribute.attnum, 'INSERT,UPDATE,REFERENCES')))
  AS multibot_preparation_receipt_privileges_ready;`;

export function emitMultibotPreparationAuditSql(explain = false) {
  // FLAG: PostgreSQL 16 psql ignores an exit-code argument to \\quit. A fixed SQL
  // error under ON_ERROR_STOP must fail the guard before either audit or EXPLAIN.
  return `\\set ON_ERROR_STOP on
${multibotPreparationReceiptPrivilegesSql.replace(/;$/u, '')}
\\gset
\\if :multibot_preparation_receipt_privileges_ready
${explain ? 'EXPLAIN (FORMAT JSON) ' : ''}${multibotPreparationDiagnosticsSql}
\\else
\\echo MULTIBOT_PREPARATION_RECEIPT_PRIVILEGES_INVALID
SELECT 1 / 0;
\\endif
`;
}

// FLAG: Fixed metadata-only audit, never recovery authority. Read five bounded receipts,
// catalog definitions and worker statistics; never scan application rows or emit raw logs,
// arbitrary index expressions, queries, PIDs or attempt-specific application names.
export const multibotPreparationDiagnosticsSql = `
WITH expected_migrations(name, checksum, position) AS (VALUES
    ${receiptValues}
), expected_indexes(name, keys, predicate, position) AS (VALUES
  ('webhook_events_semantic_order_idx', ARRAY['semantic_key', 'created_at', 'id'], '(semantic_key IS NOT NULL)', 1),
  ('webhook_events_status_created_at_id_idx', ARRAY['status', 'created_at', 'id'], NULL, 2),
  ('webhook_events_semantic_replay_fence_idx', ARRAY['semantic_key', 'id'],
    $predicate$((semantic_key IS NOT NULL) AND ((status = ANY (ARRAY['RECEIVED'::"WebhookStatus", 'QUEUED'::"WebhookStatus"])) OR ((status = 'FAILED'::"WebhookStatus") AND (next_enqueue_at IS NOT NULL)) OR (timeout_quarantine_expires_at IS NOT NULL) OR (COALESCE(error_message, ''::text) ~~* '%ambiguous%'::text) OR (COALESCE(error_message, ''::text) ~~ 'WEBHOOK_HOT_PATH_TIMEOUT%QUARANTINED%'::text)))$predicate$, 3)
), inspected_indexes AS MATERIALIZED (
  SELECT expected.*, relation.oid, relation.relkind, relation.reltablespace, state.*,
    method.amname,
    COALESCE(relation.relkind = 'i'
      AND relation.reltablespace = 0 AND relation.reloptions IS NULL
      AND state.indrelid = to_regclass('public.webhook_events')
      AND method.amname = 'btree'
      AND NOT state.indisunique AND NOT state.indisprimary AND NOT state.indisexclusion
      AND state.indexprs IS NULL
      AND state.indnkeyatts = cardinality(expected.keys)
      AND state.indnatts = cardinality(expected.keys)
      AND ARRAY(SELECT pg_get_indexdef(relation.oid, k, false)
        FROM generate_series(1, state.indnkeyatts) k) = expected.keys
      AND NOT EXISTS (SELECT 1 FROM unnest(state.indoption::smallint[]) value WHERE value <> 0)
      AND NOT EXISTS (SELECT 1 FROM unnest(state.indclass::oid[]) binding
        JOIN pg_opclass definition ON definition.oid = binding
        WHERE NOT definition.opcdefault OR definition.opcnamespace <> 'pg_catalog'::regnamespace)
      AND NOT EXISTS (
        SELECT 1 FROM unnest(state.indcollation::oid[], expected.keys) binding(actual_oid, name)
        JOIN pg_attribute attribute ON attribute.attrelid = state.indrelid AND attribute.attname = binding.name
        WHERE binding.actual_oid <> attribute.attcollation)
      AND pg_get_expr(state.indpred, state.indrelid) IS NOT DISTINCT FROM expected.predicate,
      false) AS definition_matches
  FROM expected_indexes expected
  LEFT JOIN pg_class relation ON relation.oid = to_regclass('public.' || expected.name)
  LEFT JOIN pg_index state ON state.indexrelid = relation.oid
  LEFT JOIN pg_am method ON method.oid = relation.relam
), repair_artifacts AS MATERIALIZED (
  SELECT CASE
    WHEN starts_with(relation.relname, expected.name || '_ccnew') THEN 'CCNEW'
    WHEN starts_with(relation.relname, expected.name || '_ccold') THEN 'CCOLD'
    ELSE 'CC_OTHER' END AS kind
  FROM pg_class relation JOIN expected_indexes expected
    ON starts_with(relation.relname, expected.name || '_cc')
  WHERE relation.relnamespace = 'public'::regnamespace
  LIMIT 33
), tagged_sessions AS MATERIALIZED (
  SELECT state, query_start
  FROM pg_stat_activity
  WHERE datname = current_database() AND pid <> pg_backend_pid()
    AND backend_type = 'client backend' AND application_name LIKE 'maxim-online-%'
  LIMIT 65
), index_sessions AS MATERIALIZED (
  SELECT state, query_start
  FROM pg_stat_activity
  WHERE datname = current_database() AND pid <> pg_backend_pid() AND state = 'active'
    AND query ~* '(CREATE[[:space:]]+(UNIQUE[[:space:]]+)?INDEX|REINDEX)'
    AND (query LIKE '%webhook_events_semantic_order_idx%'
      OR query LIKE '%webhook_events_status_created_at_id_idx%'
      OR query LIKE '%webhook_events_semantic_replay_fence_idx%'
      OR query LIKE '%webhook_events%')
  LIMIT 65
), progress AS MATERIALIZED (
  SELECT CASE
    WHEN phase IN ('initializing', 'waiting for writers before build', 'building index',
      'building index: initializing', 'building index: scanning table',
      'building index: sorting live tuples', 'building index: sorting dead tuples',
      'building index: loading tuples in tree',
      'waiting for writers before validation', 'index validation: scanning index',
      'index validation: sorting tuples', 'index validation: scanning table',
      'waiting for old snapshots', 'waiting for readers before marking dead',
      'waiting for readers before dropping') THEN phase ELSE 'unknown' END AS phase
  FROM pg_stat_progress_create_index
  WHERE datname = current_database() AND relid = to_regclass('public.webhook_events')
  LIMIT 65
), prepared_transactions AS MATERIALIZED (
  SELECT 1 FROM pg_prepared_xacts WHERE database = current_database() LIMIT 65
), prepared_relation_locks AS MATERIALIZED (
  SELECT 1 FROM pg_locks WHERE pid IS NULL AND locktype = 'relation'
    AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
    AND relation = to_regclass('public.webhook_events') LIMIT 65
)
SELECT json_build_object(
  'schema_version', 1, 'audit', 'multibot_preparation', 'sampled_at', clock_timestamp(),
  'read_only', current_setting('transaction_read_only') = 'on',
  'authority', 'DIAGNOSTICS_ONLY',
  'parent_kind', (SELECT relkind FROM pg_class WHERE oid = to_regclass('public.webhook_events')),
  'storage_layout_matches', COALESCE((
    SELECT relation.relpersistence = 'p' AND relation.reltablespace = 0
      AND database.dattablespace = (SELECT oid FROM pg_tablespace WHERE spcname = 'pg_default')
    FROM pg_class relation JOIN pg_database database ON database.datname = current_database()
    WHERE relation.oid = to_regclass('public.webhook_events')
  ), false) AND NOT EXISTS (
    SELECT 1 FROM inspected_indexes WHERE oid IS NOT NULL AND reltablespace <> 0
  ),
  'table_bytes', pg_table_size(to_regclass('public.webhook_events')),
  'settings', (SELECT json_object_agg(name, json_build_object('setting', setting, 'unit', unit))
    FROM pg_settings WHERE name IN ('shared_buffers', 'maintenance_work_mem',
      'max_parallel_maintenance_workers', 'temp_file_limit', 'max_wal_size', 'temp_tablespaces')),
  'columns', (SELECT json_agg(json_build_object(
    'name', expected.name, 'present', attribute.attnum IS NOT NULL,
    'type', format_type(attribute.atttypid, attribute.atttypmod),
    'not_null', attribute.attnotnull, 'default_present', defaults.oid IS NOT NULL,
    'identity', attribute.attidentity, 'generated', attribute.attgenerated,
    'default_collation', attribute.attcollation = type.typcollation
  ) ORDER BY expected.position)
    FROM (VALUES ('semantic_key', 1), ('execution_deadline_at', 2)) expected(name, position)
    LEFT JOIN pg_attribute attribute ON attribute.attrelid = to_regclass('public.webhook_events')
      AND attribute.attname = expected.name AND attribute.attnum > 0 AND NOT attribute.attisdropped
    LEFT JOIN pg_type type ON type.oid = attribute.atttypid
    LEFT JOIN pg_attrdef defaults ON defaults.adrelid = attribute.attrelid AND defaults.adnum = attribute.attnum),
  'indexes', (SELECT json_agg(json_build_object(
    'name', name, 'present', oid IS NOT NULL,
    'kind', relkind, 'parent_matches', indrelid = to_regclass('public.webhook_events'),
    'bytes', CASE WHEN relkind = 'i' THEN pg_relation_size(oid) ELSE NULL END,
    'valid', indisvalid, 'ready', indisready, 'live', indislive,
    'unique', indisunique, 'primary', indisprimary, 'exclusion', indisexclusion,
    'method', amname, 'key_count', indnkeyatts, 'attribute_count', indnatts,
    'expected_keys', keys, 'expected_predicate', predicate,
    'definition_matches', definition_matches,
    'definition', CASE WHEN definition_matches THEN pg_get_indexdef(oid) ELSE NULL END,
    'state', CASE WHEN oid IS NULL THEN 'ABSENT'
      WHEN NOT definition_matches THEN 'DEFINITION_DRIFT'
      WHEN NOT indislive THEN 'NOT_LIVE'
      WHEN NOT indisvalid OR NOT indisready THEN 'INCOMPLETE'
      ELSE 'READY' END
  ) ORDER BY position) FROM inspected_indexes),
  'repair_artifacts', json_build_object(
    'present', EXISTS (SELECT 1 FROM repair_artifacts),
    'sampled_count', (SELECT count(*) FROM repair_artifacts),
    'limited', (SELECT count(*) > 32 FROM repair_artifacts),
    'kinds', (SELECT COALESCE(json_agg(DISTINCT kind), '[]'::json) FROM repair_artifacts)),
  'builders', json_build_object(
    'statistics_visible', pg_has_role(current_user, 'pg_read_all_stats', 'USAGE'),
    'tagged_sessions', (SELECT count(*) FROM tagged_sessions),
    'active_tagged_sessions', (SELECT count(*) FROM tagged_sessions WHERE state = 'active'),
    'active_index_sessions', (SELECT count(*) FROM index_sessions),
    'progress_sessions', (SELECT count(*) FROM progress),
    'prepared_transactions', (SELECT count(*) FROM prepared_transactions),
    'prepared_webhook_relation_locks', (SELECT count(*) FROM prepared_relation_locks),
    'limited', (SELECT count(*) > 64 FROM tagged_sessions)
      OR (SELECT count(*) > 64 FROM index_sessions) OR (SELECT count(*) > 64 FROM progress)
      OR (SELECT count(*) > 64 FROM prepared_transactions)
      OR (SELECT count(*) > 64 FROM prepared_relation_locks),
    'phases', (SELECT COALESCE(json_agg(DISTINCT phase), '[]'::json) FROM progress),
    'absent', CASE WHEN pg_has_role(current_user, 'pg_read_all_stats', 'USAGE') THEN
      NOT EXISTS (SELECT 1 FROM tagged_sessions) AND NOT EXISTS (SELECT 1 FROM index_sessions)
      AND NOT EXISTS (SELECT 1 FROM progress) AND NOT EXISTS (SELECT 1 FROM prepared_transactions)
      AND NOT EXISTS (SELECT 1 FROM prepared_relation_locks)
      ELSE NULL END),
  'metadata_bytes', pg_total_relation_size('public._prisma_migrations'),
  'metadata_limit_exceeded', pg_total_relation_size('public._prisma_migrations') > 8388608,
  'metadata', CASE WHEN pg_total_relation_size('public._prisma_migrations') <= 8388608 THEN
    json_build_object(
      'other_failed', EXISTS (SELECT 1 FROM public._prisma_migrations receipt
        WHERE receipt.finished_at IS NULL AND receipt.rolled_back_at IS NULL
          AND receipt.migration_name NOT IN (SELECT name FROM expected_migrations)),
      'migrations', (SELECT json_agg(json_build_object(
        'name', expected.name, 'expected_checksum', expected.checksum,
        'active_records', (SELECT count(*) FROM public._prisma_migrations receipt
          WHERE receipt.migration_name = expected.name AND receipt.rolled_back_at IS NULL),
        'unfinished_records', (SELECT count(*) FROM public._prisma_migrations receipt
          WHERE receipt.migration_name = expected.name AND receipt.finished_at IS NULL
            AND receipt.rolled_back_at IS NULL),
        'limited', (SELECT count(*) > 8 FROM (
          SELECT 1 FROM public._prisma_migrations receipt WHERE receipt.migration_name = expected.name LIMIT 9
        ) bounded),
        'records', (SELECT COALESCE(json_agg(row_to_json(bounded)), '[]'::json) FROM (
          SELECT encode(sha256(convert_to(id, 'UTF8')), 'hex') AS identity_hash,
            checksum, checksum = expected.checksum AS checksum_matches,
            started_at, finished_at, rolled_back_at, applied_steps_count,
            CASE WHEN finished_at IS NOT NULL AND rolled_back_at IS NOT NULL THEN 'AMBIGUOUS'
              WHEN finished_at IS NOT NULL THEN 'APPLIED'
              WHEN rolled_back_at IS NOT NULL THEN 'ROLLED_BACK'
              ELSE 'UNFINISHED' END AS state,
            CASE WHEN logs IS NULL THEN 'NO_ERROR_RECORDED'
              WHEN octet_length(logs) > 65536 THEN 'LOG_OVERSIZED'
              WHEN logs = '' THEN 'NO_ERROR_RECORDED'
              WHEN logs LIKE '%55P03%' OR logs ILIKE '%lock timeout%' THEN 'LOCK_TIMEOUT'
              WHEN logs LIKE '%57014%' OR logs ILIKE '%statement timeout%' THEN 'QUERY_CANCELLED'
              WHEN logs LIKE '%57P01%' OR logs ILIKE '%terminating connection%' THEN 'CONNECTION_TERMINATED'
              ELSE 'OTHER_ERROR' END AS failure_code
          FROM public._prisma_migrations receipt WHERE receipt.migration_name = expected.name
          ORDER BY started_at DESC, id DESC LIMIT 8
        ) bounded)
      ) ORDER BY expected.position) FROM expected_migrations expected)
    ) ELSE NULL END
);
`;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== '--explain')) {
    process.stderr.write('This fixed audit accepts only --explain.\n');
    process.exitCode = 2;
  } else {
    process.stdout.write(emitMultibotPreparationAuditSql(process.argv[2] === '--explain'));
  }
}
