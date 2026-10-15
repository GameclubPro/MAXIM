import { pathToFileURL } from 'node:url';

export const POLL_AUDIT_COLUMNS = {
  managed_polls: [
    'id',
    'chat_id',
    'status',
    'publication_message_id',
    'publication_bot_id',
    'render_revision',
    'rendered_revision',
    'render_format_version',
    'last_render_error',
    'published_at',
    'closed_at',
    'updated_at',
  ],
  chat_bot_memberships: [
    'chat_id',
    'bot_id',
    'status',
    'bot_access_state',
    'bot_access_checked_at',
    'bot_access_source',
    'lifecycle_event_at',
  ],
};

export function buildPollPublicationPrivilegesSql(requireAll = false) {
  const allowed = Object.entries(POLL_AUDIT_COLUMNS)
    .flatMap(([table, columns]) => columns.map((column) => `('${table}', '${column}')`))
    .join(',');
  return `WITH allowed(table_name, column_name) AS (VALUES ${allowed}),
effective AS (
  SELECT relation.relname AS table_name, attribute.attname AS column_name
  FROM pg_class relation JOIN pg_namespace ns ON ns.oid = relation.relnamespace
  JOIN pg_attribute attribute ON attribute.attrelid = relation.oid
  WHERE ns.nspname = 'public' AND relation.relname IN (SELECT table_name FROM allowed)
    AND attribute.attnum > 0 AND NOT attribute.attisdropped
    AND has_column_privilege('maxim_audit', relation.oid, attribute.attnum, 'SELECT')
)
SELECT NOT EXISTS (SELECT * FROM effective EXCEPT SELECT * FROM allowed)
  AND NOT EXISTS (
    SELECT 1 FROM (SELECT DISTINCT table_name FROM allowed) tables
    WHERE has_table_privilege('maxim_audit', to_regclass('public.' || tables.table_name), 'SELECT')
      OR (SELECT count(*) FROM effective WHERE table_name = tables.table_name)
        NOT IN (${requireAll ? '' : '0,'} (SELECT count(*) FROM allowed WHERE table_name = tables.table_name))
  ) AS poll_publication_audit_ready \\gset
\\if :poll_publication_audit_ready
\\else
\\echo MAXIM_POLL_AUDIT_PRIVILEGES_INVALID
SELECT 1 / 0;
\\endif
`;
}

export function buildPollPublicationAuditSql(pollId, explain = false) {
  if (typeof pollId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(pollId))
    throw new Error('One exact poll ID required');
  // FLAG: One primary-key poll and one exact unique membership lookup. Publication
  // identities are join-only; no content, voter, actor, token or raw error leaves this report.
  const query = `SELECT json_build_object(
    'schema_version', 1, 'audit', 'poll_publication', 'observed_at', statement_timestamp(),
    'found', poll.id IS NOT NULL, 'status', poll.status,
    'has_publication', poll.publication_message_id IS NOT NULL,
    'has_original_bot', poll.publication_bot_id IS NOT NULL,
    'render_revision', poll.render_revision, 'rendered_revision', poll.rendered_revision,
    'render_format_version', poll.render_format_version,
    'render_error_kind', CASE WHEN poll.last_render_error IS NULL THEN 'none'
      WHEN poll.last_render_error ~ '(^|[^0-9])404([^0-9]|$)' THEN 'http_404_unknown_presence'
      WHEN poll.last_render_error ~ '(^|[^0-9])403([^0-9]|$)' THEN 'http_403_unknown_access'
      WHEN poll.last_render_error ~ '(^|[^0-9])429([^0-9]|$)' THEN 'rate_limit'
      WHEN poll.last_render_error ILIKE '%timeout%' THEN 'timeout'
      ELSE 'other' END,
    'published_at', poll.published_at, 'closed_at', poll.closed_at, 'updated_at', poll.updated_at,
    'original_membership_exists', member.bot_id IS NOT NULL,
    'original_membership_status', member.status, 'original_access_state', member.bot_access_state,
    'original_access_checked_at', member.bot_access_checked_at,
    'original_access_source_present', member.bot_access_source IS NOT NULL,
    'original_lifecycle_event_at', member.lifecycle_event_at,
    'capabilities_and_activation_checked', false, 'remote_presence_proven', false
  )
  FROM (VALUES (1)) singleton(value)
  LEFT JOIN managed_polls poll ON poll.id = '${pollId}'
  LEFT JOIN chat_bot_memberships member
    ON member.chat_id = poll.chat_id AND member.bot_id = poll.publication_bot_id;`;
  return `${explain ? 'EXPLAIN (FORMAT JSON) ' : ''}${query}\n`;
}

export function buildPollPublicationIndexReadinessSql() {
  return `WITH required(name, relation, keys) AS (VALUES
    ('managed_polls_pkey', 'managed_polls', ARRAY['id']),
    ('chat_bot_memberships_chat_id_bot_id_key', 'chat_bot_memberships', ARRAY['chat_id', 'bot_id'])
  )
SELECT NOT EXISTS (
  SELECT 1 FROM required LEFT JOIN pg_index idx
    ON idx.indexrelid = to_regclass('public.' || required.name)
      AND idx.indrelid = to_regclass('public.' || required.relation)
      AND idx.indisvalid AND idx.indisready AND idx.indislive AND idx.indisunique
      AND idx.indpred IS NULL AND idx.indexprs IS NULL
      AND idx.indnkeyatts = cardinality(required.keys) AND idx.indnatts = cardinality(required.keys)
      AND ARRAY(SELECT pg_get_indexdef(idx.indexrelid, pos, false)
        FROM generate_series(1, idx.indnkeyatts) AS pos ORDER BY pos) = required.keys
  WHERE idx.indexrelid IS NULL
) AS poll_publication_indexes_ready \\gset
\\if :poll_publication_indexes_ready
\\else
\\echo MAXIM_POLL_AUDIT_INDEXES_INVALID
SELECT 1 / 0;
\\endif
`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [id, option, ...extra] = process.argv.slice(2);
  if (extra.length || (option !== undefined && !['--explain', '--require-all'].includes(option)))
    throw new Error('Invalid poll-publication audit arguments');
  if (id === '--privileges') {
    if (option && option !== '--require-all') throw new Error('Invalid privilege arguments');
    process.stdout.write(buildPollPublicationPrivilegesSql(option === '--require-all'));
  } else {
    if (option && option !== '--explain') throw new Error('Invalid report arguments');
    process.stdout.write(
      buildPollPublicationIndexReadinessSql() +
        buildPollPublicationAuditSql(id, option === '--explain'),
    );
  }
}
