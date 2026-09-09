import { pathToFileURL } from 'node:url';

// FLAG: Fixed catalog-only probe. Never accept table names, SQL, or migration names from callers.
export const publicationPostActionsSchemaAuditSql = `
WITH expected(relation_name, column_name, position) AS (VALUES
  ('publication_content_revisions', 'post_publish', 1),
  ('managed_broadcast_deliveries', 'post_actions_next_at', 2),
  ('managed_broadcast_deliveries', 'post_actions_token', 3),
  ('managed_broadcast_deliveries', 'pin_status', 4),
  ('managed_broadcast_deliveries', 'pin_error', 5),
  ('managed_broadcast_deliveries', 'pin_attempt_count', 6),
  ('managed_broadcast_deliveries', 'delete_status', 7),
  ('managed_broadcast_deliveries', 'delete_at', 8),
  ('managed_broadcast_deliveries', 'deleted_at', 9),
  ('managed_broadcast_deliveries', 'delete_error', 10),
  ('managed_broadcast_deliveries', 'delete_attempt_count', 11)
)
SELECT json_build_object(
  'schema_version', 1,
  'audit', 'publication_post_actions_schema',
  'migration', '20260909130000_add_publication_post_actions',
  'parents_present', to_regclass('public.publication_content_revisions') IS NOT NULL
    AND to_regclass('public.managed_broadcast_deliveries') IS NOT NULL,
  'enum_labels', COALESCE((
    SELECT json_agg(e.enumlabel ORDER BY e.enumsortorder)
    FROM pg_enum e
    WHERE e.enumtypid = to_regtype('public."PublicationPostActionStatus"')
  ), '[]'::json),
  'columns', (
    SELECT json_agg(json_build_object(
      'table', expected.relation_name,
      'column', expected.column_name,
      'present', a.attnum IS NOT NULL,
      'type', format_type(a.atttypid, a.atttypmod),
      'not_null', a.attnotnull,
      'default', pg_get_expr(d.adbin, d.adrelid)
    ) ORDER BY expected.position)
    FROM expected
    LEFT JOIN pg_attribute a ON a.attrelid = to_regclass('public.' || expected.relation_name)
      AND a.attname = expected.column_name AND a.attnum > 0 AND NOT a.attisdropped
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  ),
  'index', (
    SELECT json_build_object(
      'valid', i.indisvalid, 'ready', i.indisready,
      'definition', pg_get_indexdef(i.indexrelid)
    )
    FROM pg_index i
    WHERE i.indexrelid = to_regclass('public.managed_broadcast_deliveries_post_actions_due_idx')
      AND i.indrelid = to_regclass('public.managed_broadcast_deliveries')
  )
);
`;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 2) {
    process.stderr.write('This fixed audit accepts no arguments.\n');
    process.exitCode = 2;
  } else {
    process.stdout.write(publicationPostActionsSchemaAuditSql);
  }
}
