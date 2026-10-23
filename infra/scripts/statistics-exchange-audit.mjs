import { pathToFileURL } from 'node:url';

export const STATISTICS_EXCHANGE_AUDIT_COLUMNS = {
  statistics_exchange_grants: [
    'id',
    'actor_user_id',
    'revision',
    'state',
    'updated_at',
    'next_pull_at',
    'last_pull_at',
    'last_error',
    'producer_revision',
    'last_remote_access_at',
    'remote_access_error',
  ],
  statistics_exchange_entities: [
    'grant_id',
    'entity_id',
    'kind',
    'binding_id',
    'error',
    'remote_valid_until',
    'remote_binding_id',
  ],
  statistics_exchange_imports: [
    'grant_id',
    'grant_revision',
    'entity_id',
    'kind',
    'producer_revision',
    'manifest',
    'rows',
    'updated_at',
    'remote_valid_until',
  ],
  statistics_exchange_generations: [
    'id',
    'grant_id',
    'grant_revision',
    'entity_id',
    'kind',
    'origin',
    'producer_revision',
    'manifest',
    'rows',
    'created_at',
  ],
};

const allowedValues = Object.entries(STATISTICS_EXCHANGE_AUDIT_COLUMNS)
  .flatMap(([table, columns]) => columns.map((column) => `('${table}','${column}')`))
  .join(',');
const columnCount = Object.values(STATISTICS_EXCHANGE_AUDIT_COLUMNS).flat().length;

export function parseStatisticsExchangeAuditArgs(args) {
  if (
    !Array.isArray(args) ||
    args.length < 1 ||
    args.length > 2 ||
    typeof args[0] !== 'string' ||
    !/^[1-9][0-9]{0,19}$/u.test(args[0]) ||
    (args.length === 2 && args[1] !== '--explain')
  )
    throw new Error('Usage: statistics-exchange <exact-positive-actor-id> [--explain]');
  return { actor: args[0], explain: args.length === 2 };
}

export function buildStatisticsExchangePrivilegesSql(requireAll = false) {
  return `WITH allowed(table_name,column_name) AS (VALUES ${allowedValues}), effective AS (
    SELECT relation.relname AS table_name,attribute.attname AS column_name
    FROM pg_class relation JOIN pg_namespace ns ON ns.oid=relation.relnamespace
    JOIN pg_attribute attribute ON attribute.attrelid=relation.oid
    WHERE ns.nspname='public' AND relation.relname IN (SELECT table_name FROM allowed)
      AND attribute.attnum>0 AND NOT attribute.attisdropped
      AND has_column_privilege('maxim_audit',relation.oid,attribute.attnum,'SELECT')
  ) SELECT NOT EXISTS (SELECT * FROM effective EXCEPT SELECT * FROM allowed)
    AND (SELECT count(*) FROM effective) IN (${requireAll ? '' : '0,'}${columnCount})
    AND NOT EXISTS (SELECT 1 FROM pg_class relation JOIN pg_namespace ns ON ns.oid=relation.relnamespace
      WHERE ns.nspname='public' AND relation.relname IN (SELECT table_name FROM allowed)
        AND (has_table_privilege('maxim_audit',relation.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
          OR EXISTS (SELECT 1 FROM pg_attribute attribute WHERE attribute.attrelid=relation.oid
            AND attribute.attnum>0 AND NOT attribute.attisdropped
            AND has_column_privilege('maxim_audit',relation.oid,attribute.attnum,'INSERT,UPDATE,REFERENCES'))))
    AS statistics_exchange_privileges_ready \\gset
\\if :statistics_exchange_privileges_ready
\\else
\\echo MAXIM_STATISTICS_EXCHANGE_PRIVILEGES_INVALID
SELECT 1/0;
\\endif
`;
}

export function buildStatisticsExchangeProvisionSql() {
  return `-- FLAG: Optional exchange metadata grants are all-or-none; JSON is measurement
-- transport, never message content. Join keys and raw errors never leave the report.
DO $statistics_exchange_grants$
BEGIN
  IF NOT EXISTS (
    WITH allowed(table_name,column_name) AS (VALUES ${allowedValues})
    SELECT 1 FROM allowed LEFT JOIN pg_attribute attribute
      ON attribute.attrelid=to_regclass('public.'||allowed.table_name)
      AND attribute.attname=allowed.column_name AND attribute.attnum>0 AND NOT attribute.attisdropped
    WHERE attribute.attnum IS NULL
  ) THEN
${Object.entries(STATISTICS_EXCHANGE_AUDIT_COLUMNS)
  .map(
    ([table, columns]) =>
      `    GRANT SELECT (${columns.join(',')}) ON TABLE public.${table} TO maxim_audit;`,
  )
  .join('\n')}
  END IF;
  IF EXISTS (
    WITH allowed(table_name,column_name) AS (VALUES ${allowedValues}), effective AS (
      SELECT relation.relname AS table_name,attribute.attname AS column_name
      FROM pg_class relation JOIN pg_namespace ns ON ns.oid=relation.relnamespace
      JOIN pg_attribute attribute ON attribute.attrelid=relation.oid
      WHERE ns.nspname='public' AND relation.relname IN (SELECT table_name FROM allowed)
        AND attribute.attnum>0 AND NOT attribute.attisdropped
        AND has_column_privilege('maxim_audit',relation.oid,attribute.attnum,'SELECT')
    ) SELECT 1 WHERE EXISTS (SELECT * FROM effective EXCEPT SELECT * FROM allowed)
      OR (SELECT count(*) FROM effective) NOT IN (0,${columnCount})
      OR EXISTS (SELECT 1 FROM pg_class relation JOIN pg_namespace ns ON ns.oid=relation.relnamespace
        WHERE ns.nspname='public' AND relation.relname IN (SELECT table_name FROM allowed)
          AND (has_table_privilege('maxim_audit',relation.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
            OR EXISTS (SELECT 1 FROM pg_attribute attribute WHERE attribute.attrelid=relation.oid
              AND attribute.attnum>0 AND NOT attribute.attisdropped
              AND has_column_privilege('maxim_audit',relation.oid,attribute.attnum,'INSERT,UPDATE,REFERENCES'))))
  ) THEN RAISE EXCEPTION 'maxim_audit statistics-exchange metadata privileges are not exact'; END IF;
END
$statistics_exchange_grants$;
`;
}

export function buildStatisticsExchangeIndexReadinessSql() {
  return `WITH required(name,relation,keys,options,unique_required) AS (VALUES
    ('statistics_exchange_grants_actor_user_id_key','statistics_exchange_grants',ARRAY['actor_user_id'],ARRAY[0]::smallint[],true),
    ('statistics_exchange_entities_pkey','statistics_exchange_entities',ARRAY['grant_id','entity_id','kind'],ARRAY[0,0,0]::smallint[],true),
    ('statistics_exchange_imports_pkey','statistics_exchange_imports',ARRAY['grant_id','grant_revision','entity_id','kind'],ARRAY[0,0,0,0]::smallint[],true),
    ('statistics_exchange_generations_latest_idx','statistics_exchange_generations',ARRAY['grant_id','grant_revision','entity_id','kind','origin','producer_revision','created_at','id'],ARRAY[0,0,0,0,0,3,3,3]::smallint[],false)
  ) SELECT NOT EXISTS (SELECT 1 FROM required LEFT JOIN pg_index idx
    ON idx.indexrelid=to_regclass('public.'||required.name)
      AND idx.indrelid=to_regclass('public.'||required.relation)
      AND idx.indisvalid AND idx.indisready AND idx.indislive
      AND (NOT required.unique_required OR idx.indisunique)
      AND NOT idx.indisexclusion AND idx.indimmediate
      AND idx.indpred IS NULL AND idx.indexprs IS NULL
      AND idx.indnkeyatts=cardinality(required.keys) AND idx.indnatts=cardinality(required.keys)
      AND ARRAY(SELECT unnest(idx.indoption::smallint[]))=required.options
      AND EXISTS (SELECT 1 FROM pg_class index_relation JOIN pg_am method ON method.oid=index_relation.relam
        JOIN pg_class parent ON parent.oid=idx.indrelid
        WHERE index_relation.oid=idx.indexrelid AND method.amname='btree' AND parent.relkind='r'
          AND NOT parent.relrowsecurity AND NOT parent.relispartition
          AND NOT EXISTS (SELECT 1 FROM pg_inherits WHERE inhparent=parent.oid OR inhrelid=parent.oid))
      AND NOT EXISTS (SELECT 1 FROM unnest(idx.indclass::oid[]) c JOIN pg_opclass op ON op.oid=c
        WHERE NOT op.opcdefault OR op.opcnamespace<>'pg_catalog'::regnamespace)
      AND ARRAY(SELECT pg_get_indexdef(idx.indexrelid,pos,false)
        FROM generate_series(1,idx.indnkeyatts) AS pos ORDER BY pos)=required.keys
    WHERE idx.indexrelid IS NULL) AS statistics_exchange_indexes_ready \\gset
\\if :statistics_exchange_indexes_ready
\\else
\\echo MAXIM_STATISTICS_EXCHANGE_INDEXES_INVALID
SELECT 1/0;
\\endif
`;
}

// FLAG: Bound decoded JSON before any value operation, including compressed PG16
// storage. A rejected datum remains unknown; never replace its measurements by zero.
const admittedJson = (column, bytes) => `CASE
  WHEN ${column} IS NULL THEN false
  WHEN pg_column_compression(${column}) IS NULL THEN pg_column_size(${column})<=${bytes}
  WHEN current_setting('server_version_num')::integer/10000<>16 THEN false
  WHEN pg_column_compression(${column})='pglz' THEN pg_column_size(${column})<=${Math.floor((bytes - 4) / 91)}
  WHEN pg_column_compression(${column})='lz4' THEN pg_column_size(${column})<=${Math.floor((bytes - 4) / 255)}
  ELSE false END`;
const isoTimestamp = (value) => `CASE WHEN jsonb_typeof(${value})='string'
  AND (${value}#>>'{}') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,9})?Z$'
  AND pg_input_is_valid(${value}#>>'{}','timestamptz') THEN (${value}#>>'{}')::timestamptz ELSE NULL END`;

export function buildStatisticsExchangeAuditSql(args) {
  const { actor, explain } = parseStatisticsExchangeAuditArgs(args);
  const query = `WITH actor_grant AS MATERIALIZED (
    SELECT id,revision,state,updated_at,next_pull_at,last_pull_at,last_error,producer_revision,
      last_remote_access_at,remote_access_error
    FROM public.statistics_exchange_grants WHERE actor_user_id=${explain ? '$1' : `'${actor}'`} LIMIT 1
  ), entity_probe AS MATERIALIZED (
    SELECT e.entity_id,e.kind,e.binding_id,e.error,e.remote_valid_until,e.remote_binding_id FROM actor_grant g
    CROSS JOIN LATERAL (SELECT entity_id,kind,binding_id,error,remote_valid_until,remote_binding_id FROM public.statistics_exchange_entities
      WHERE grant_id=g.id ORDER BY entity_id,kind LIMIT 7) e
  ), entities AS MATERIALIZED (SELECT entity_id,kind,binding_id,error,remote_valid_until,remote_binding_id FROM entity_probe ORDER BY entity_id,kind LIMIT 6),
  snapshots AS MATERIALIZED (
    SELECT e.kind,'EXCHANGE'::text AS origin,i.producer_revision,i.manifest,i.rows,i.updated_at AS stored_at,
      i.remote_valid_until FROM actor_grant g CROSS JOIN entities e
    CROSS JOIN LATERAL (SELECT producer_revision,
      CASE WHEN ${admittedJson('manifest', 65536)} THEN manifest ELSE NULL END AS manifest,
      CASE WHEN ${admittedJson('rows', 4194304)} THEN rows ELSE NULL END AS rows,updated_at,remote_valid_until
      FROM public.statistics_exchange_imports WHERE grant_id=g.id AND grant_revision=g.revision
        AND entity_id=e.entity_id AND kind=e.kind LIMIT 1) i
    UNION ALL
    SELECT e.kind,'MAXIM'::text,n.producer_revision,n.manifest,n.rows,n.created_at,NULL::timestamptz
    FROM actor_grant g CROSS JOIN entities e
    CROSS JOIN LATERAL (SELECT producer_revision,
      CASE WHEN ${admittedJson('manifest', 65536)} THEN manifest ELSE NULL END AS manifest,
      CASE WHEN ${admittedJson('rows', 4194304)} THEN rows ELSE NULL END AS rows,created_at
      FROM public.statistics_exchange_generations WHERE grant_id=g.id AND grant_revision=g.revision
        AND entity_id=e.entity_id AND kind=e.kind AND origin='MAXIM'
      ORDER BY producer_revision DESC,created_at DESC,id DESC LIMIT 1) n
  ), admitted AS MATERIALIZED (
    SELECT kind,origin,producer_revision,stored_at,remote_valid_until,
      CASE WHEN jsonb_typeof(manifest)='object' THEN manifest ELSE NULL END AS manifest,
      CASE WHEN jsonb_typeof(rows)='array' THEN
        CASE WHEN jsonb_array_length(rows)<=3000 THEN rows ELSE NULL END ELSE NULL END AS rows
    FROM snapshots
  ), measurements AS MATERIALIZED (
    SELECT s.kind,s.origin,s.producer_revision,row.value,
      ${isoTimestamp("row.value->'data'->'observedAt'")} AS observed_at
    FROM admitted s CROSS JOIN LATERAL jsonb_array_elements(s.rows) WITH ORDINALITY row(value,n)
    WHERE row.n<=3000
  ), metrics AS MATERIALIZED (
    SELECT kind,origin,CASE WHEN value->'data'->>'metric' IN ('AUDIENCE','MEMBERSHIP','REACH','PUBLICATION_HOUR')
      THEN value->'data'->>'metric' ELSE 'UNKNOWN' END AS metric,count(*) AS rows,
      count(*) FILTER (WHERE observed_at IS NOT NULL) AS observed_rows,
      min(observed_at) AS first_observed_at,max(observed_at) AS last_observed_at,
      count(*) FILTER (WHERE CASE value->'data'->>'metric'
        WHEN 'AUDIENCE' THEN jsonb_typeof(value->'data'->'value')='number' AND observed_at IS NOT NULL
        WHEN 'REACH' THEN value->'data'->'incomplete'='false'::jsonb
          AND value->'data'->'samples'=value->'data'->'posts'
        WHEN 'MEMBERSHIP' THEN value->'data'->'complete'='true'::jsonb
        WHEN 'PUBLICATION_HOUR' THEN value->'data'->'complete'='true'::jsonb ELSE false END) AS complete_rows,
      count(*) FILTER (WHERE value->>'origin' IS DISTINCT FROM origin
        OR value->>'method' IS DISTINCT FROM 'utc-buckets-v1'
        OR NOT CASE WHEN origin='EXCHANGE' THEN CASE
          WHEN jsonb_typeof(value->'revision')='number'
            AND value->>'revision' ~ '^(0|[1-9][0-9]{0,15})$'
          THEN (value->>'revision')::numeric BETWEEN 0 AND least(producer_revision,9007199254740991) ELSE false END
          ELSE (value->>'revision') IS NOT DISTINCT FROM producer_revision::text END) AS provenance_mismatch_rows
    FROM measurements GROUP BY kind,origin,metric
  ) SELECT json_build_object(
    'schema_version',1,'audit','statistics_exchange','scope','ONE_EXACT_ACTOR',
    'sampled_at',statement_timestamp(),'entity_sample_cap',6,'measurement_cap_per_snapshot',3000,
    'grant_present',EXISTS(SELECT 1 FROM actor_grant),'grant_state',(SELECT state FROM actor_grant),
    'grant_revision',(SELECT revision FROM actor_grant),'producer_revision',(SELECT producer_revision FROM actor_grant),
    'grant_updated_at',(SELECT updated_at FROM actor_grant),'next_pull_at',(SELECT next_pull_at FROM actor_grant),
    'last_pull_at',(SELECT last_pull_at FROM actor_grant),
    'last_error',(SELECT last_error IS NOT NULL FROM actor_grant),
    'last_remote_access_at',(SELECT last_remote_access_at FROM actor_grant),
    'remote_access_error',(SELECT remote_access_error IS NOT NULL FROM actor_grant),
    'sampled_entities',(SELECT count(*) FROM entities),
    'entities_capped',(SELECT count(*)>6 FROM entity_probe),
    'bound_entities',(SELECT count(*) FROM entities WHERE binding_id IS NOT NULL),
    'entity_errors',(SELECT count(*) FROM entities WHERE error IS NOT NULL),
    'remote_bound_entities',(SELECT count(*) FROM entities WHERE remote_binding_id IS NOT NULL),
    'valid_entity_authorities',(SELECT count(*) FROM entities WHERE remote_valid_until>statement_timestamp()),
    'expired_entity_authorities',(SELECT count(*) FROM entities WHERE remote_valid_until<=statement_timestamp()),
    'unproven_entity_authorities',(SELECT count(*) FROM entities WHERE remote_valid_until IS NULL),
    'oldest_entity_authority_until',(SELECT min(remote_valid_until) FROM entities),
    'newest_entity_authority_until',(SELECT max(remote_valid_until) FROM entities),
    'channel_entities',(SELECT count(*) FROM entities WHERE kind='CHANNEL'),
    'chat_entities',(SELECT count(*) FROM entities WHERE kind='CHAT'),
    'snapshots',(SELECT count(*) FROM admitted),
    'import_snapshots',(SELECT count(*) FROM admitted WHERE origin='EXCHANGE'),
    'native_export_snapshots',(SELECT count(*) FROM admitted WHERE origin='MAXIM'),
    'rejected_json_snapshots',(SELECT count(*) FROM admitted WHERE manifest IS NULL OR rows IS NULL),
    'oldest_import_authority_until',(SELECT min(remote_valid_until) FROM admitted WHERE origin='EXCHANGE'),
    'newest_import_authority_until',(SELECT max(remote_valid_until) FROM admitted WHERE origin='EXCHANGE'),
    'expired_import_authorities',(SELECT count(*) FROM admitted WHERE origin='EXCHANGE' AND remote_valid_until<=statement_timestamp()),
    'unproven_import_authorities',(SELECT count(*) FROM admitted WHERE origin='EXCHANGE' AND remote_valid_until IS NULL),
    'import_revision_min',(SELECT min(producer_revision) FROM admitted WHERE origin='EXCHANGE'),
    'import_revision_max',(SELECT max(producer_revision) FROM admitted WHERE origin='EXCHANGE'),
    'native_export_revision_min',(SELECT min(producer_revision) FROM admitted WHERE origin='MAXIM'),
    'native_export_revision_max',(SELECT max(producer_revision) FROM admitted WHERE origin='MAXIM'),
    'native_only',(SELECT CASE WHEN count(*)=0 THEN NULL ELSE
      bool_and(manifest IS NOT NULL AND rows IS NOT NULL
        AND (manifest->>'origin') IS NOT DISTINCT FROM origin
        AND (manifest->>'method') IS NOT DISTINCT FROM 'utc-buckets-v1'
        AND (manifest->>'producerRevision') IS NOT DISTINCT FROM producer_revision::text)
      AND NOT EXISTS(SELECT 1 FROM metrics WHERE provenance_mismatch_rows>0) END FROM admitted),
    'provenance_mismatch_rows',coalesce((SELECT sum(provenance_mismatch_rows) FROM metrics),0),
    'latest_actual_observation_at',(SELECT max(observed_at) FROM measurements),
    'latest_stored_at',(SELECT max(stored_at) FROM admitted),
    'coverage_basis','SAMPLED_ROWS_NOT_FULL_GRANT_OR_ELIGIBLE_INPUTS',
    'remote_rights_proven',false,'checksum_recomputed',false,'collection_handoff_proven',false,
    'metrics',coalesce((SELECT json_agg(metrics ORDER BY kind,origin,metric) FROM metrics),'[]'::json)
  );`;
  // FLAG: Generic plain EXPLAIN does not execute the query or print the private actor.
  if (explain)
    return `SET LOCAL plan_cache_mode=force_generic_plan;
PREPARE statistics_exchange_audit_plan(text) AS ${query}
EXPLAIN (FORMAT JSON) EXECUTE statistics_exchange_audit_plan('${actor}');
DEALLOCATE statistics_exchange_audit_plan;
`;
  return query + '\n';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args[0] === '--validate-scope') {
      parseStatisticsExchangeAuditArgs(args.slice(1));
    } else if (args[0] === '--privileges') {
      if (args.length > 2 || (args.length === 2 && args[1] !== '--require-all'))
        throw new Error('Invalid privilege arguments');
      process.stdout.write(buildStatisticsExchangePrivilegesSql(args.length === 2));
    } else if (args.length === 1 && args[0] === '--provision') {
      process.stdout.write(buildStatisticsExchangeProvisionSql());
    } else {
      const sql = buildStatisticsExchangeAuditSql(args);
      process.stdout.write(buildStatisticsExchangeIndexReadinessSql());
      process.stdout.write(sql);
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
