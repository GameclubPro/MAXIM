export const MIGRATION = '20261002020100_index_retention_reconciliation';
export const ADDITIVE_MIGRATION = '20261002020000_add_retention_reconciliation';
export const indexes = Object.freeze({
  message_retention_candidates_chat_reconcile_idx: Object.freeze([
    'chat_id',
    'reconcile_after',
    'message_id',
  ]),
  message_retention_candidates_outcome_idx: Object.freeze([
    'chat_id',
    'outcome_code',
    'message_id',
  ]),
  message_retention_candidates_shadow_source_idx: Object.freeze([
    'chat_id',
    'status',
    'shadow_only',
    'source_at',
    'message_id',
  ]),
});
export const indexPredicates = Object.freeze({
  message_retention_candidates_chat_reconcile_idx: '(reconcile_after IS NOT NULL)',
  message_retention_candidates_outcome_idx: null,
  message_retention_candidates_shadow_source_idx: null,
});

// FLAG: Inspect only the fixed schema and bounded receipts, never message candidates or contents.
export const recoveryAuditSql = `SELECT json_build_object(
  'migration', '${MIGRATION}',
  'parent_kind', (SELECT relkind FROM pg_class WHERE oid = to_regclass('public.message_retention_candidates')),
  'table_bytes', pg_table_size(to_regclass('public.message_retention_candidates')),
  'repair_artifacts', EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND (
      starts_with(c.relname, 'message_retention_candidates_chat_reconcile_idx_cc') OR
      starts_with(c.relname, 'message_retention_candidates_outcome_idx_cc') OR
      starts_with(c.relname, 'message_retention_candidates_shadow_source_idx_cc'))
  ),
  'columns', (SELECT json_agg(json_build_object(
    'name', e.name, 'type', format_type(a.atttypid, a.atttypmod),
    'not_null', a.attnotnull, 'default', pg_get_expr(d.adbin, d.adrelid),
    'identity', a.attidentity, 'generated', a.attgenerated,
    'default_collation', a.attcollation = t.typcollation
  ) ORDER BY e.position) FROM (VALUES ('outcome_code', 1), ('reconcile_after', 2)) e(name, position)
  LEFT JOIN pg_attribute a ON a.attrelid = to_regclass('public.message_retention_candidates')
    AND a.attname = e.name AND a.attnum > 0 AND NOT a.attisdropped
  LEFT JOIN pg_type t ON t.oid = a.atttypid
  LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum),
  'indexes', (SELECT json_agg(json_build_object(
    'name', e.name, 'present', c.oid IS NOT NULL, 'kind', c.relkind,
    'parent_matches', i.indrelid = to_regclass('public.message_retention_candidates'),
    'valid', i.indisvalid, 'ready', i.indisready, 'live', i.indislive,
    'unique', i.indisunique, 'primary', i.indisprimary, 'exclusion', i.indisexclusion,
    'method', am.amname, 'attributes', i.indnatts, 'keys', i.indnkeyatts,
    'predicate', pg_get_expr(i.indpred, i.indrelid),
    'expressions', pg_get_expr(i.indexprs, i.indrelid),
    'default_key_options', (SELECT bool_and(i.indoption[k] = 0
        AND i.indcollation[k] = a.attcollation AND op.opcdefault
        AND op.opcnamespace = 'pg_catalog'::regnamespace)
      FROM generate_series(0, i.indnkeyatts - 1) k
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[k]
      JOIN pg_opclass op ON op.oid = i.indclass[k]),
    'columns', (SELECT json_agg(pg_get_indexdef(i.indexrelid, k, true) ORDER BY k)
      FROM generate_series(1, i.indnatts) k)
  ) ORDER BY e.position) FROM (VALUES
    ('message_retention_candidates_chat_reconcile_idx', 1),
    ('message_retention_candidates_outcome_idx', 2),
    ('message_retention_candidates_shadow_source_idx', 3)
  ) e(name, position)
  LEFT JOIN pg_class c ON c.oid = to_regclass('public.' || e.name)
  LEFT JOIN pg_index i ON i.indexrelid = c.oid
  LEFT JOIN pg_am am ON am.oid = c.relam),
  'metadata', CASE WHEN pg_total_relation_size('public._prisma_migrations') <= 8388608 THEN (
    SELECT json_build_object(
      'other_failed', EXISTS (SELECT 1 FROM public._prisma_migrations
        WHERE migration_name <> '${MIGRATION}' AND finished_at IS NULL AND rolled_back_at IS NULL),
      'rolled_back_count', (SELECT count(*) FROM public._prisma_migrations
        WHERE migration_name = '${MIGRATION}' AND rolled_back_at IS NOT NULL),
      'prerequisite', (SELECT COALESCE(json_agg(x), '[]'::json) FROM (
        SELECT id, checksum, finished_at IS NOT NULL AS finished, applied_steps_count
        FROM public._prisma_migrations
        WHERE migration_name = '${ADDITIVE_MIGRATION}' AND rolled_back_at IS NULL
        ORDER BY id LIMIT 2
      ) x),
      'records', (SELECT COALESCE(json_agg(x), '[]'::json) FROM (
        SELECT id, checksum, finished_at IS NOT NULL AS finished, applied_steps_count,
          CASE WHEN octet_length(logs) > 65536 THEN 'oversized'
            WHEN logs LIKE '%55P03%' OR logs LIKE '%lock timeout%' THEN 'lock_timeout'
            ELSE 'other' END AS failure
        FROM public._prisma_migrations
        WHERE migration_name = '${MIGRATION}' AND rolled_back_at IS NULL
        ORDER BY id LIMIT 2
      ) x)
    )
  ) ELSE NULL END
);`;

export function verifyRecoveryState(report, checksum, additiveChecksum) {
  if (
    report?.migration !== MIGRATION ||
    report.parent_kind !== 'r' ||
    !Number.isSafeInteger(report.table_bytes) ||
    report.table_bytes < 0 ||
    report.table_bytes > 512 * 1024 * 1024 ||
    report.repair_artifacts !== false ||
    !Array.isArray(report.indexes) ||
    report.indexes.length !== 3 ||
    !Array.isArray(report.columns) ||
    report.columns.length !== 2
  )
    throw new Error('Catalog is outside the bounded message-retention recovery scope.');
  for (const [name, type] of [
    ['outcome_code', 'text'],
    ['reconcile_after', 'timestamp(3) without time zone'],
  ]) {
    const matches = report.columns.filter((column) => column.name === name);
    const column = matches[0];
    if (
      matches.length !== 1 ||
      column.type !== type ||
      column.not_null !== false ||
      column.default !== null ||
      column.identity !== '' ||
      column.generated !== '' ||
      column.default_collation !== true
    )
      throw new Error('Additive receipt column definition differs from the immutable migration.');
  }
  const actions = Object.entries(indexes).map(([name, columns]) => {
    const matches = report.indexes.filter((index) => index.name === name);
    if (matches.length !== 1) throw new Error('Unexpected index catalog entry.');
    const index = matches[0];
    if (index.present === false) return { name, action: 'create' };
    if (
      index.present !== true ||
      index.kind !== 'i' ||
      index.parent_matches !== true ||
      typeof index.valid !== 'boolean' ||
      typeof index.ready !== 'boolean' ||
      index.live !== true ||
      (index.valid && !index.ready) ||
      index.unique !== false ||
      index.primary !== false ||
      index.exclusion !== false ||
      index.method !== 'btree' ||
      index.attributes !== columns.length ||
      index.keys !== columns.length ||
      index.predicate !== indexPredicates[name] ||
      index.expressions !== null ||
      index.default_key_options !== true ||
      JSON.stringify(index.columns) !== JSON.stringify(columns)
    )
      throw new Error('Index definition differs from the immutable migration.');
    return { name, action: index.valid ? 'ready' : 'reindex' };
  });
  const metadata = report.metadata;
  if (
    !metadata ||
    metadata.other_failed !== false ||
    !Number.isSafeInteger(metadata.rolled_back_count) ||
    metadata.rolled_back_count < 0 ||
    !Array.isArray(metadata.records) ||
    metadata.records.length !== 1 ||
    !Array.isArray(metadata.prerequisite) ||
    metadata.prerequisite.length !== 1
  )
    throw new Error(
      'Expected exact prerequisite and active receipt, with no other failed migration.',
    );
  const prerequisite = metadata.prerequisite[0];
  if (
    !/^[a-f0-9]{64}$/u.test(additiveChecksum) ||
    prerequisite.checksum !== additiveChecksum ||
    typeof prerequisite.id !== 'string' ||
    !prerequisite.id ||
    prerequisite.finished !== true ||
    prerequisite.applied_steps_count !== 1
  )
    throw new Error('The exact additive migration must already have a successful receipt.');
  const record = metadata.records[0];
  if (
    !/^[a-f0-9]{64}$/u.test(checksum) ||
    record.checksum !== checksum ||
    typeof record.id !== 'string' ||
    !record.id ||
    typeof record.finished !== 'boolean' ||
    !Number.isSafeInteger(record.applied_steps_count) ||
    record.applied_steps_count < 0
  )
    throw new Error('Invalid or checksum-mismatched migration record.');
  if (record.finished) {
    if (actions.some(({ action }) => action !== 'ready'))
      throw new Error('Applied migration has index drift.');
  } else if (record.applied_steps_count !== 0 || record.failure !== 'lock_timeout') {
    throw new Error('Only the exact zero-step lock-timeout failure is recoverable.');
  }
  return {
    actions,
    recordState: record.finished ? 'applied' : 'failed',
    recordIdentity: JSON.stringify(metadata),
  };
}

// FLAG: Only these three concurrent index operations are allowed; no row writes or DROP repair.
export function recoveryIndexSql(name, action) {
  if (!Object.hasOwn(indexes, name) || !['create', 'reindex'].includes(action))
    throw new Error('Unknown index recovery operation.');
  if (action === 'reindex') return `REINDEX INDEX CONCURRENTLY public.${name};`;
  const predicate = indexPredicates[name];
  return `CREATE INDEX CONCURRENTLY "${name}" ON public."message_retention_candidates"(${indexes[name].map((column) => `"${column}"`).join(', ')}${predicate ? `) WHERE ${predicate}` : ')'};`;
}
