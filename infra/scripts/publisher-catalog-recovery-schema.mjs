export const MIGRATION = '20260928121000_index_publisher_catalog_page';
export const indexes = Object.freeze({
  managed_entity_access_edges_publisher_page_idx: Object.freeze([
    'user_id',
    'bot_id',
    'state',
    'chat_id',
  ]),
});

// FLAG: Fixed catalog and bounded migration metadata only; never read publication contents.
export const recoveryAuditSql = `SELECT json_build_object(
  'migration', '${MIGRATION}',
  'parent_kind', (SELECT relkind FROM pg_class WHERE oid = to_regclass('public.managed_entity_access_edges')),
  'table_bytes', pg_table_size(to_regclass('public.managed_entity_access_edges')),
  'repair_artifacts', EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND (
      starts_with(c.relname, 'managed_entity_access_edges_publisher_page_idx_cc'))
  ),
  'indexes', (SELECT json_agg(json_build_object(
    'name', e.name, 'present', c.oid IS NOT NULL, 'kind', c.relkind,
    'parent_matches', i.indrelid = to_regclass('public.managed_entity_access_edges'),
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
    ('managed_entity_access_edges_publisher_page_idx', 1)
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

export function verifyRecoveryState(report, checksum) {
  if (
    report?.migration !== MIGRATION ||
    report.parent_kind !== 'r' ||
    !Number.isSafeInteger(report.table_bytes) ||
    report.table_bytes < 0 ||
    report.table_bytes > 512 * 1024 * 1024 ||
    report.repair_artifacts !== false ||
    !Array.isArray(report.indexes) ||
    report.indexes.length !== 1
  )
    throw new Error('Catalog is outside the bounded publisher-catalog recovery scope.');
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
      index.attributes !== 4 ||
      index.keys !== 4 ||
      index.predicate !== null ||
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
    metadata.records.length !== 1
  )
    throw new Error('Expected exactly one active record and no other failed migration.');
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

// FLAG: Caller input can select only the exact concurrent index repair.
export function recoveryIndexSql(name, action) {
  if (!Object.hasOwn(indexes, name) || !['create', 'reindex'].includes(action))
    throw new Error('Unknown index recovery operation.');
  return action === 'reindex'
    ? `REINDEX INDEX CONCURRENTLY public.${name};`
    : `CREATE INDEX CONCURRENTLY "${name}" ON public."managed_entity_access_edges"(${indexes[name].map((column) => `"${column}"`).join(', ')});`;
}
