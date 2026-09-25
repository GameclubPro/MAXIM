// FLAG: Exact catalog shapes for this immutable migration, not caller-selected relations or DDL.
export const addedColumns = [
  ['channel_settings', 'post_suggestions_require_subscription', 'boolean', true, 'false'],
  ['channel_settings', 'post_suggestions_delete_on_unsubscribe', 'boolean', true, 'false'],
  [
    'publisher_entity_settings',
    'channel_suggestions_require_subscription',
    'boolean',
    true,
    'false',
  ],
  [
    'publisher_entity_settings',
    'channel_suggestions_delete_on_unsubscribe',
    'boolean',
    true,
    'false',
  ],
  ['managed_broadcast_deliveries', 'subscription_delete_id', 'text', false, null],
  ['moderation_delete_intents', 'suggestion_subscription_id', 'text', false, null],
];
const timestamp = 'timestamp(3) without time zone';
export const expectedTables = [
  {
    name: 'suggestion_subscription_publications',
    columns: [
      ['id', 'text', true, null],
      ['watch_id', 'text', true, null],
      ['publication_id', 'text', false, null],
      ['message_id', 'text', false, null],
      ['delivery_id', 'text', false, null],
      ['published_at', timestamp, true, 'CURRENT_TIMESTAMP'],
      ['deleted_at', timestamp, false, null],
      ['delete_intent_id', 'text', false, null],
    ],
    constraints: [
      ['p', 'PRIMARY KEY (id)'],
      [
        'f',
        'FOREIGN KEY (watch_id) REFERENCES suggestion_subscription_watches(id) ON UPDATE CASCADE ON DELETE CASCADE',
      ],
    ],
    indexes: [
      ['suggestion_subscription_publications_pkey', true, ['id']],
      ['suggestion_subscription_publications_publication_idx', false, ['publication_id']],
      ['suggestion_subscription_publications_watch_idx', false, ['watch_id', 'deleted_at', 'id']],
    ],
  },
  {
    name: 'suggestion_subscription_watches',
    columns: [
      ['id', 'text', true, null],
      ['chat_id', 'text', true, null],
      ['author_user_id', 'text', true, null],
      ['profile', 'text', true, null],
      ['bot_id', 'text', true, null],
      ['next_check_at', timestamp, true, 'CURRENT_TIMESTAMP'],
      ['missing_since', timestamp, false, null],
      ['checked_at', timestamp, false, null],
      ['lease_token', 'text', false, null],
      ['lease_until', timestamp, false, null],
      ['publication_cursor', 'text', false, null],
      ['revision', 'integer', true, '0'],
    ],
    constraints: [
      ['p', 'PRIMARY KEY (id)'],
      ['c', "CHECK ((profile = ANY (ARRAY['moderation'::text, 'publisher'::text])))"],
    ],
    indexes: [
      ['suggestion_subscription_watch_due_idx', false, ['profile', 'next_check_at', 'id']],
      [
        'suggestion_subscription_watch_owner_key',
        true,
        ['chat_id', 'author_user_id', 'profile', 'bot_id'],
      ],
      ['suggestion_subscription_watches_pkey', true, ['id']],
    ],
  },
];

export const schemaAuditFieldsSql = `
  'columns', (
    SELECT json_agg(json_build_array(e.table_name, e.column_name,
      format_type(a.atttypid, a.atttypmod), a.attnotnull, pg_get_expr(d.adbin, d.adrelid)) ORDER BY e.position)
    FROM (VALUES ${addedColumns.map(([table, column], index) => `('${table}', '${column}', ${index})`).join(', ')}) e(table_name, column_name, position)
    LEFT JOIN pg_attribute a ON a.attrelid = to_regclass('public.' || e.table_name)
      AND a.attname = e.column_name AND a.attnum > 0 AND NOT a.attisdropped
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  ),
  'tables', (
    SELECT COALESCE(json_agg(json_build_object(
      'name', c.relname, 'kind', c.relkind, 'rls', c.relrowsecurity,
      'columns', (SELECT json_agg(json_build_array(a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull, pg_get_expr(d.adbin, d.adrelid)) ORDER BY a.attnum)
        FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped),
      'constraints', (SELECT json_agg(json_build_array(k.contype, pg_get_constraintdef(k.oid), k.convalidated, k.condeferrable, k.condeferred) ORDER BY k.conname)
        FROM pg_constraint k WHERE k.conrelid = c.oid),
      'indexes', (SELECT json_agg(json_build_object(
        'name', ic.relname, 'unique', i.indisunique, 'valid', i.indisvalid, 'ready', i.indisready,
        'method', am.amname, 'attributes', i.indnatts, 'keys', i.indnkeyatts,
        'predicate', pg_get_expr(i.indpred, i.indrelid), 'expressions', pg_get_expr(i.indexprs, i.indrelid),
        'columns', (SELECT json_agg(a.attname ORDER BY k.position) FROM unnest(i.indkey) WITH ORDINALITY k(attribute_number, position)
          JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attribute_number)
      ) ORDER BY ic.relname) FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid JOIN pg_am am ON am.oid = ic.relam WHERE i.indrelid = c.oid)
    ) ORDER BY c.relname), '[]'::json) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname IN ('suggestion_subscription_watches', 'suggestion_subscription_publications')
  ),`;

export function verifySchema(report) {
  if (
    report?.parents_present !== true ||
    !Array.isArray(report.columns) ||
    report.columns.length !== 6 ||
    !Array.isArray(report.tables)
  )
    throw new Error('Invalid recovery schema metadata.');
  const isColumn = (index, present) =>
    JSON.stringify(report.columns[index]) ===
    JSON.stringify(
      present ? addedColumns[index] : [...addedColumns[index].slice(0, 2), null, null, null],
    );
  if (
    report.columns_present === 0 &&
    report.relations_present === 0 &&
    report.types_present === 0 &&
    report.tables.length === 0 &&
    addedColumns.every((_, index) => isColumn(index, false))
  )
    return 'absent';
  if (
    report.columns_present === 5 &&
    report.relations_present === 0 &&
    report.types_present === 0 &&
    report.tables.length === 0 &&
    addedColumns.every((_, index) => isColumn(index, index < 5))
  )
    return 'five-column-prefix';
  if (
    report.columns_present !== 6 ||
    report.relations_present !== 8 ||
    report.types_present !== 2 ||
    !addedColumns.every((_, index) => isColumn(index, true)) ||
    report.tables.length !== 2
  )
    throw new Error('Schema is neither absent, the exact five-column prefix, nor complete.');
  for (const expected of expectedTables) {
    const table = report.tables.find((item) => item.name === expected.name);
    if (
      !table ||
      table.kind !== 'r' ||
      table.rls !== false ||
      JSON.stringify(table.columns) !== JSON.stringify(expected.columns) ||
      !Array.isArray(table.constraints) ||
      table.constraints.length !== expected.constraints.length ||
      !Array.isArray(table.indexes) ||
      table.indexes.length !== expected.indexes.length
    )
      throw new Error('Recovery table definition differs from the immutable migration.');
    for (const [type, definition] of expected.constraints) {
      if (
        table.constraints.filter(
          (item) => JSON.stringify(item) === JSON.stringify([type, definition, true, false, false]),
        ).length !== 1
      )
        throw new Error('Recovery constraint definition differs from the immutable migration.');
    }
    for (const [name, unique, columns] of expected.indexes) {
      const index = table.indexes.find((item) => item.name === name);
      if (
        !index ||
        index.unique !== unique ||
        index.valid !== true ||
        index.ready !== true ||
        index.method !== 'btree' ||
        index.attributes !== columns.length ||
        index.keys !== columns.length ||
        index.predicate !== null ||
        index.expressions !== null ||
        JSON.stringify(index.columns) !== JSON.stringify(columns)
      )
        throw new Error('Recovery index definition differs from the immutable migration.');
    }
  }
  return 'complete';
}

// FLAG: The known missing suffix is atomic; failed lock acquisition changes nothing and never waits behind live work.
export function recoveryCompletionSql(migrationSql) {
  const marker =
    'ALTER TABLE "moderation_delete_intents" ADD COLUMN "suggestion_subscription_id" TEXT;';
  const offset = migrationSql.indexOf(marker);
  if (offset < 0 || migrationSql.indexOf(marker, offset + 1) >= 0)
    throw new Error('Immutable migration suffix not found.');
  return `BEGIN;
SET LOCAL lock_timeout = '750ms';
SET LOCAL statement_timeout = '10s';
SET LOCAL idle_in_transaction_session_timeout = '4s';
LOCK TABLE public.moderation_delete_intents IN ACCESS EXCLUSIVE MODE NOWAIT;
${migrationSql.slice(offset)}
COMMIT;`;
}
