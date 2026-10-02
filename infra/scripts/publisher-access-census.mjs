import { pathToFileURL } from 'node:url';

export const PUBLISHER_ACCESS_CENSUS_CAP = 50_000;

export function buildPublisherAccessCensusReadinessSql() {
  return `SELECT EXISTS (
  SELECT 1 FROM pg_index i JOIN pg_attribute a
    ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
  WHERE i.indexrelid = to_regclass('public.publisher_entity_bindings_pkey')
    AND i.indrelid = to_regclass('public.publisher_entity_bindings')
    AND i.indisprimary AND i.indisvalid AND i.indisready
    AND i.indnkeyatts = 1 AND i.indnatts = 1 AND a.attname = 'chat_id'
) AND NOT EXISTS (
  SELECT 1 FROM unnest(ARRAY['chat_id', 'publisher_bot_id', 'status',
    'bot_access_state', 'bot_access_checked_at', 'bot_access_expires_at']) AS required(column_name)
  WHERE NOT has_column_privilege('maxim_audit', 'public.publisher_entity_bindings', column_name, 'SELECT')
) AS publisher_access_census_ready \\gset
\\if :publisher_access_census_ready
\\else
\\echo 'Publisher census requires the binding primary key and existing metadata grants.'
\\quit 4
\\endif
`;
}

export function buildPublisherAccessCensusSql(explain = false) {
  // FLAG: Walk the unfiltered primary key under a hard source cap before any filter/hash/count.
  // Identifiers remain SQL-local. These snapshots measure population, never send authority,
  // historical confirmation deadlines or binding-hours between sparse observations.
  const query = `WITH source AS MATERIALIZED (
  SELECT chat_id, publisher_bot_id, status, bot_access_state,
    bot_access_checked_at, bot_access_expires_at
  FROM publisher_entity_bindings ORDER BY chat_id LIMIT ${PUBLISHER_ACCESS_CENSUS_CAP + 1}
), sample AS NOT MATERIALIZED (
  SELECT * FROM source LIMIT ${PUBLISHER_ACCESS_CENSUS_CAP}
), active AS NOT MATERIALIZED (
  SELECT *, sha256(convert_to('[' || to_json(publisher_bot_id)::text || ',' ||
    to_json(chat_id)::text || ']', 'UTF8')) AS cohort_hash
  FROM sample WHERE status = 'ACTIVE'
), classified AS NOT MATERIALIZED (
  SELECT *, CASE WHEN (
    get_byte(cohort_hash, 0)::bigint * 16777216 + get_byte(cohort_hash, 1)::bigint * 65536 +
    get_byte(cohort_hash, 2)::bigint * 256 + get_byte(cohort_hash, 3)::bigint
  ) % 10 = 0 THEN 'separated' ELSE 'legacy' END AS cohort,
    bot_access_state IN ('CONFIRMED_ADMIN', 'CONFIRMED_OWNER') AS confirmed_admin,
    bot_access_expires_at > statement_timestamp()
      AND bot_access_checked_at <= statement_timestamp()
      AND bot_access_checked_at >= statement_timestamp() - interval '15 minutes' AS fresh
  FROM active
), cohorts(cohort) AS (VALUES ('legacy'), ('separated')),
cohort_counts AS (
  SELECT b.cohort, count(*) AS active_bindings,
    count(*) FILTER (WHERE b.confirmed_admin) AS confirmed_admin_bindings,
    count(*) FILTER (WHERE b.confirmed_admin AND b.fresh) AS fresh_admin_bindings,
    count(*) FILTER (WHERE b.confirmed_admin AND b.bot_access_expires_at <= statement_timestamp()) AS expired_admin_bindings,
    count(*) FILTER (WHERE b.confirmed_admin AND b.bot_access_expires_at IS NULL) AS missing_admin_expiry,
    count(*) FILTER (WHERE b.confirmed_admin AND b.fresh AND
      b.bot_access_expires_at <= statement_timestamp() + interval '60 seconds') AS expiring_admin_in_60s,
    count(*) FILTER (WHERE b.confirmed_admin AND
      (b.bot_access_checked_at IS NULL OR b.bot_access_checked_at > statement_timestamp() OR
        b.bot_access_checked_at < statement_timestamp() - interval '15 minutes')) AS invalid_or_stale_admin_check
  FROM classified b GROUP BY b.cohort
), counts AS (
  SELECT c.cohort, coalesce(b.active_bindings, 0) AS active_bindings,
    coalesce(b.confirmed_admin_bindings, 0) AS confirmed_admin_bindings,
    coalesce(b.fresh_admin_bindings, 0) AS fresh_admin_bindings,
    coalesce(b.expired_admin_bindings, 0) AS expired_admin_bindings,
    coalesce(b.missing_admin_expiry, 0) AS missing_admin_expiry,
    coalesce(b.expiring_admin_in_60s, 0) AS expiring_admin_in_60s,
    coalesce(b.invalid_or_stale_admin_check, 0) AS invalid_or_stale_admin_check
  FROM cohorts c LEFT JOIN cohort_counts b USING (cohort)
)
SELECT json_build_object(
  'schema_version', 1, 'audit', 'publisher_access_census',
  'observed_at', statement_timestamp(), 'source_row_cap', ${PUBLISHER_ACCESS_CENSUS_CAP},
  'source_rows_sampled', (SELECT count(*) FROM sample),
  'source_truncated', (SELECT count(*) > ${PUBLISHER_ACCESS_CENSUS_CAP} FROM source),
  'active_bot_scopes', (SELECT count(DISTINCT publisher_bot_id) FROM active),
  'cohort_basis', 'sha256_bot_entity_mod10',
  'cohorts', (SELECT json_agg(counts ORDER BY cohort) FROM counts)
);`;
  return `${explain ? 'EXPLAIN (FORMAT JSON) ' : ''}${query}\n`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--explain')) {
    throw new Error('Usage: publisher-access-census.mjs [--explain]');
  }
  process.stdout.write(
    buildPublisherAccessCensusReadinessSql() +
      buildPublisherAccessCensusSql(args[0] === '--explain'),
  );
}
