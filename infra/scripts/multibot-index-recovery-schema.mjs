export const MIGRATION = '20261005016100_index_multibot_retention_cursor';
export const ADDITIVE_MIGRATION = '20261005015900_prepare_multibot_webhook_columns';
export const SEMANTIC_ORDER_MIGRATION = '20261005016000_add_multibot_semantic_order_index';
export const MAXIMUM_TABLE_BYTES = 128 * 1024 ** 3;
export const migrationChecksums = Object.freeze({
  [ADDITIVE_MIGRATION]: '84daf9ae34efa2042e851c030b49db092cf915c18ba51b2542c5469adcb2c1fc',
  [SEMANTIC_ORDER_MIGRATION]: '096d0209b62f285e0a8b3c51439510d0892eedc76a836fe8acdfcd8b4c4263e0',
  [MIGRATION]: 'ab23b44fc5a721aefbd982119bf7cc4b642fd113482d7f4e61c6183c7ee14f5f',
});
export const indexes = Object.freeze({
  webhook_events_status_created_at_id_idx: Object.freeze(['status', 'created_at', 'id']),
  webhook_events_semantic_replay_fence_idx: Object.freeze(['semantic_key', 'id']),
});
const prerequisiteIndex = 'webhook_events_semantic_order_idx';
const allIndexes = Object.freeze({
  [prerequisiteIndex]: Object.freeze(['semantic_key', 'created_at', 'id']),
  ...indexes,
});

// FLAG: Keep every replay-fence branch from the immutable migration. PostgreSQL renders
// IN as ANY, ILIKE as ~~*, LIKE as ~~ and inserts explicit text casts in pg_get_expr.
export const indexPredicates = Object.freeze({
  [prerequisiteIndex]: '(semantic_key IS NOT NULL)',
  webhook_events_status_created_at_id_idx: null,
  webhook_events_semantic_replay_fence_idx: `((semantic_key IS NOT NULL) AND ((status = ANY (ARRAY['RECEIVED'::"WebhookStatus", 'QUEUED'::"WebhookStatus"])) OR ((status = 'FAILED'::"WebhookStatus") AND (next_enqueue_at IS NOT NULL)) OR (timeout_quarantine_expires_at IS NOT NULL) OR (COALESCE(error_message, ''::text) ~~* '%ambiguous%'::text) OR (COALESCE(error_message, ''::text) ~~ 'WEBHOOK_HOT_PATH_TIMEOUT%QUARANTINED%'::text)))`,
});
const replayCreatePredicate = `"semantic_key" IS NOT NULL AND (
  "status" IN ('RECEIVED'::public."WebhookStatus", 'QUEUED'::public."WebhookStatus")
  OR ("status" = 'FAILED'::public."WebhookStatus" AND "next_enqueue_at" IS NOT NULL)
  OR "timeout_quarantine_expires_at" IS NOT NULL
  OR COALESCE("error_message", '') ILIKE '%ambiguous%'
  OR COALESCE("error_message", '') LIKE 'WEBHOOK_HOT_PATH_TIMEOUT%QUARANTINED%'
)`;
const expectedColumns = Object.freeze([
  ['semantic_key', 'text', 'pg_catalog', 'b', false, null],
  ['execution_deadline_at', 'timestamp(3) without time zone', 'pg_catalog', 'b', false, null],
  ['id', 'text', 'pg_catalog', 'b', true, null],
  ['created_at', 'timestamp(3) without time zone', 'pg_catalog', 'b', true, 'CURRENT_TIMESTAMP'],
  ['status', '"WebhookStatus"', 'public', 'e', true, `'RECEIVED'::"WebhookStatus"`],
  ['next_enqueue_at', 'timestamp(3) without time zone', 'pg_catalog', 'b', false, null],
  [
    'timeout_quarantine_expires_at',
    'timestamp(3) without time zone',
    'pg_catalog',
    'b',
    false,
    null,
  ],
  ['error_message', 'text', 'pg_catalog', 'b', false, null],
]);

// FLAG: Fixed catalog plus capped Prisma receipts only. Never select webhook rows or
// return raw logs. SQLSTATE 57014 alone also denotes user cancellation, so it is not
// timeout proof: require the complete Prisma/server error block for that exact family.
export const recoveryAuditSql = `SELECT json_build_object(
  'migration', '${MIGRATION}',
  'parent_kind', (SELECT relkind FROM pg_catalog.pg_class WHERE oid = to_regclass('public.webhook_events')),
  'parent_persistence', (SELECT relpersistence FROM pg_catalog.pg_class WHERE oid = to_regclass('public.webhook_events')),
  'table_bytes', pg_table_size(to_regclass('public.webhook_events')),
  'active_owned_sessions', EXISTS (
    SELECT 1 FROM pg_catalog.pg_stat_activity
    WHERE datname = current_database() AND usename = current_user
      AND backend_type = 'client backend' AND pid <> pg_backend_pid()
      AND starts_with(application_name, 'maxim-online-')
  ),
  'repair_artifacts', EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND (
      starts_with(c.relname, '${prerequisiteIndex}_cc') OR
      starts_with(c.relname, 'webhook_events_status_created_at_id_idx_cc') OR
      starts_with(c.relname, 'webhook_events_semantic_replay_fence_idx_cc'))
  ),
  'status_enum', (SELECT json_agg(e.enumlabel ORDER BY e.enumsortorder)
    FROM pg_catalog.pg_enum e
    JOIN pg_catalog.pg_type t ON t.oid = e.enumtypid
    JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typname = 'WebhookStatus' AND t.typtype = 'e'),
  'columns', (SELECT json_agg(json_build_object(
    'name', e.name, 'type', format_type(a.atttypid, a.atttypmod),
    'type_namespace', n.nspname, 'type_kind', t.typtype,
    'not_null', a.attnotnull, 'default', pg_get_expr(d.adbin, d.adrelid),
    'identity', a.attidentity, 'generated', a.attgenerated,
    'default_collation', a.attcollation = t.typcollation
  ) ORDER BY e.position) FROM (VALUES
    ${expectedColumns.map(([name], position) => `('${name}', ${position + 1})`).join(',\n    ')}
  ) e(name, position)
  LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid = to_regclass('public.webhook_events')
    AND a.attname = e.name AND a.attnum > 0 AND NOT a.attisdropped
  LEFT JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
  LEFT JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
  LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum),
  'indexes', (SELECT json_agg(json_build_object(
    'name', e.name, 'present', c.oid IS NOT NULL, 'kind', c.relkind,
    'parent_matches', i.indrelid = to_regclass('public.webhook_events'),
    'valid', i.indisvalid, 'ready', i.indisready, 'live', i.indislive,
    'unique', i.indisunique, 'primary', i.indisprimary, 'exclusion', i.indisexclusion,
    'method', am.amname, 'attributes', i.indnatts, 'keys', i.indnkeyatts,
    'predicate', pg_get_expr(i.indpred, i.indrelid),
    'expressions', pg_get_expr(i.indexprs, i.indrelid),
    'default_tablespace', c.reltablespace = 0, 'options', c.reloptions,
    'default_key_options', (SELECT count(*) = i.indnkeyatts AND bool_and(i.indoption[k] = 0
        AND i.indcollation[k] = a.attcollation AND op.opcdefault
        AND op.opcnamespace = 'pg_catalog'::regnamespace)
      FROM generate_series(0, i.indnkeyatts - 1) k
      JOIN pg_catalog.pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[k]
      JOIN pg_catalog.pg_opclass op ON op.oid = i.indclass[k]),
    'columns', (SELECT json_agg(pg_get_indexdef(i.indexrelid, k, true) ORDER BY k)
      FROM generate_series(1, i.indnatts) k)
  ) ORDER BY e.position) FROM (VALUES
    ${Object.keys(allIndexes)
      .map((name, position) => `('${name}', ${position + 1})`)
      .join(',\n    ')}
  ) e(name, position)
  LEFT JOIN pg_catalog.pg_class c ON c.oid = to_regclass('public.' || e.name)
  LEFT JOIN pg_catalog.pg_index i ON i.indexrelid = c.oid
  LEFT JOIN pg_catalog.pg_am am ON am.oid = c.relam),
  'metadata', CASE WHEN
    (SELECT relkind = 'r' AND relpersistence = 'p' FROM pg_catalog.pg_class
      WHERE oid = to_regclass('public._prisma_migrations'))
    AND pg_total_relation_size('public._prisma_migrations') <= 8388608 THEN (
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
      'semantic_order', (SELECT COALESCE(json_agg(x), '[]'::json) FROM (
        SELECT id, checksum, finished_at IS NOT NULL AS finished, applied_steps_count
        FROM public._prisma_migrations
        WHERE migration_name = '${SEMANTIC_ORDER_MIGRATION}' AND rolled_back_at IS NULL
        ORDER BY id LIMIT 2
      ) x),
      'records', (SELECT COALESCE(json_agg(x), '[]'::json) FROM (
        SELECT id, checksum, finished_at IS NOT NULL AS finished, applied_steps_count,
          CASE WHEN octet_length(logs) > 65536 THEN 'oversized'
            WHEN regexp_count(logs, E'(^|\\n)Database error code:') <> 1
              OR regexp_count(logs, E'(^|\\n)ERROR:') <> 1 THEN 'other'
            WHEN logs ~ E'(^|\\n)Database error code: 55P03\\r?\\n\\r?\\nDatabase error:\\r?\\nERROR: canceling statement due to lock timeout(\\r?\\n|$)'
              THEN 'lock_timeout'
            WHEN logs ~ E'(^|\\n)Database error code: 57014\\r?\\n\\r?\\nDatabase error:\\r?\\nERROR: canceling statement due to statement timeout(\\r?\\n|$)'
              THEN 'statement_timeout'
            ELSE 'other' END AS failure
        FROM public._prisma_migrations
        WHERE migration_name = '${MIGRATION}' AND rolled_back_at IS NULL
        ORDER BY id LIMIT 2
      ) x)
    )
  ) ELSE NULL END
);`;

function verifyIndex(index, name, columns) {
  if (
    !index ||
    index.name !== name ||
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
    index.default_tablespace !== true ||
    index.options !== null ||
    index.default_key_options !== true ||
    JSON.stringify(index.columns) !== JSON.stringify(columns)
  )
    throw new Error('MULTIBOT_INDEX_RECOVERY_INDEX_DRIFT');
  return { name, action: index.valid ? 'ready' : 'reindex' };
}

function verifyPrerequisite(records, checksum) {
  const receipt = records?.[0];
  if (
    !Array.isArray(records) ||
    records.length !== 1 ||
    !receipt ||
    typeof receipt.id !== 'string' ||
    !receipt.id ||
    receipt.checksum !== checksum ||
    receipt.finished !== true ||
    receipt.applied_steps_count !== 1
  )
    throw new Error('MULTIBOT_INDEX_RECOVERY_PREREQUISITE_INVALID');
}

export function verifyRecoveryState(report, checksum, additiveChecksum, semanticOrderChecksum) {
  if (
    checksum !== migrationChecksums[MIGRATION] ||
    additiveChecksum !== migrationChecksums[ADDITIVE_MIGRATION] ||
    semanticOrderChecksum !== migrationChecksums[SEMANTIC_ORDER_MIGRATION]
  )
    throw new Error('MULTIBOT_INDEX_RECOVERY_SOURCE_CHECKSUM_MISMATCH');
  if (
    report?.migration !== MIGRATION ||
    report.parent_kind !== 'r' ||
    report.parent_persistence !== 'p' ||
    !Number.isSafeInteger(report.table_bytes) ||
    report.table_bytes < 0 ||
    report.table_bytes > MAXIMUM_TABLE_BYTES ||
    report.repair_artifacts !== false ||
    report.active_owned_sessions !== false ||
    !Array.isArray(report.indexes) ||
    report.indexes.length !== 3 ||
    !Array.isArray(report.columns) ||
    report.columns.length !== expectedColumns.length ||
    JSON.stringify(report.status_enum) !==
      JSON.stringify(['RECEIVED', 'PROCESSED', 'DUPLICATE', 'FAILED', 'QUEUED'])
  )
    throw new Error('MULTIBOT_INDEX_RECOVERY_CATALOG_OUTSIDE_SCOPE');
  for (const [name, type, namespace, kind, notNull, defaultValue] of expectedColumns) {
    const matches = report.columns.filter((column) => column?.name === name);
    const column = matches[0];
    if (
      matches.length !== 1 ||
      column.type !== type ||
      column.type_namespace !== namespace ||
      column.type_kind !== kind ||
      column.not_null !== notNull ||
      column.default !== defaultValue ||
      column.identity !== '' ||
      column.generated !== '' ||
      column.default_collation !== true
    )
      throw new Error('MULTIBOT_INDEX_RECOVERY_COLUMN_DRIFT');
  }
  const actions = [];
  for (const [name, columns] of Object.entries(allIndexes)) {
    const matches = report.indexes.filter((index) => index?.name === name);
    if (matches.length !== 1) throw new Error('MULTIBOT_INDEX_RECOVERY_INDEX_DRIFT');
    const index = matches[0];
    if (name !== prerequisiteIndex && index.present === false) {
      if (
        [
          'kind',
          'parent_matches',
          'valid',
          'ready',
          'live',
          'unique',
          'primary',
          'exclusion',
          'method',
          'attributes',
          'keys',
          'predicate',
          'expressions',
          'default_tablespace',
          'options',
          'default_key_options',
          'columns',
        ].some((field) => index[field] !== null)
      )
        throw new Error('MULTIBOT_INDEX_RECOVERY_INDEX_DRIFT');
      actions.push({ name, action: 'create' });
      continue;
    }
    const state = verifyIndex(index, name, columns);
    if (name === prerequisiteIndex) {
      if (state.action !== 'ready')
        throw new Error('MULTIBOT_INDEX_RECOVERY_PREREQUISITE_INDEX_INVALID');
    } else actions.push(state);
  }
  const metadata = report.metadata;
  if (
    !metadata ||
    metadata.other_failed !== false ||
    !Number.isSafeInteger(metadata.rolled_back_count) ||
    metadata.rolled_back_count < 0 ||
    !Array.isArray(metadata.records) ||
    metadata.records.length !== 1
  )
    throw new Error('MULTIBOT_INDEX_RECOVERY_RECEIPTS_OUTSIDE_SCOPE');
  verifyPrerequisite(metadata.prerequisite, additiveChecksum);
  verifyPrerequisite(metadata.semantic_order, semanticOrderChecksum);
  const record = metadata.records[0];
  if (
    !record ||
    record.checksum !== checksum ||
    typeof record.id !== 'string' ||
    !record.id ||
    typeof record.finished !== 'boolean' ||
    !Number.isSafeInteger(record.applied_steps_count) ||
    record.applied_steps_count < 0
  )
    throw new Error('MULTIBOT_INDEX_RECOVERY_RECEIPT_INVALID');
  if (record.finished) {
    if (actions.some(({ action }) => action !== 'ready'))
      throw new Error('MULTIBOT_INDEX_RECOVERY_APPLIED_INDEX_DRIFT');
  } else if (
    record.applied_steps_count !== 0 ||
    !['lock_timeout', 'statement_timeout'].includes(record.failure)
  )
    throw new Error('MULTIBOT_INDEX_RECOVERY_FAILURE_UNPROVEN');
  return {
    actions,
    recordState: record.finished ? 'applied' : 'failed',
    recordIdentity: JSON.stringify(metadata),
  };
}

// FLAG: Only the two immutable concurrent index operations are executable here.
// A failure preserves its Prisma receipt and partial index; never DROP or skip a name.
export function recoveryIndexSql(name, action) {
  if (!Object.hasOwn(indexes, name) || !['create', 'reindex'].includes(action))
    throw new Error('MULTIBOT_INDEX_RECOVERY_OPERATION_INVALID');
  if (action === 'reindex') return `REINDEX INDEX CONCURRENTLY public.${name};`;
  const columns = indexes[name].map((column) => `"${column}"`).join(', ');
  const predicate =
    name === 'webhook_events_semantic_replay_fence_idx' ? ` WHERE ${replayCreatePredicate}` : '';
  return `CREATE INDEX CONCURRENTLY "${name}" ON public."webhook_events" (${columns})${predicate};`;
}
