import { pathToFileURL } from 'node:url';

export const CENTRAL_STATISTICS_AUDIT_COLUMNS = {
  stats_entities: ['id', 'kind', 'max_id', 'data_revision'],
  stats_authorities: [
    'entity_id',
    'issuer',
    'role',
    'producer',
    'consumer',
    'actor_max_id',
    'bot_ref',
    'purpose',
    'state',
    'peer_valid_until',
    'checked_at',
  ],
  stats_measurements: [
    'entity_id',
    'producer',
    'metric',
    'horizon',
    'method_id',
    'day',
    'deleted',
    'observed_from',
    'observed_to',
    'updated_at',
  ],
  stats_ingest_requests: [
    'producer',
    'producer_epoch',
    'record_kind',
    'operation_key',
    'created_at',
  ],
  stats_changes: ['id', 'cause', 'created_at', 'published_seq', 'published_at'],
};

export function parseCentralStatisticsAuditArgs(args) {
  if (
    !Array.isArray(args) ||
    args.length < 1 ||
    args.length > 2 ||
    typeof args[0] !== 'string' ||
    (args.length === 2 && args[1] !== '--explain')
  )
    throw new Error('Usage: central-statistics <exact-negative-ID-CSV, max 12> [--explain]');
  const ids = args[0].split(',');
  if (
    ids.length > 12 ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !/^-[1-9][0-9]{0,19}$/u.test(id))
  )
    throw new Error('Expected at most twelve distinct exact negative IDs');
  return { ids, explain: args.length === 2 };
}

const allowedValues = Object.entries(CENTRAL_STATISTICS_AUDIT_COLUMNS)
  .flatMap(([table, columns]) => columns.map((column) => `('${table}','${column}')`))
  .join(',');
const columnCount = Object.values(CENTRAL_STATISTICS_AUDIT_COLUMNS).flat().length;

export function buildCentralStatisticsPrivilegesSql(requireAll = false) {
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
    AS central_statistics_privileges_ready \\gset
\\if :central_statistics_privileges_ready
\\else
\\echo MAXIM_CENTRAL_STATISTICS_PRIVILEGES_INVALID
SELECT 1/0;
\\endif
`;
}

export function buildCentralStatisticsProvisionSql() {
  return `-- FLAG: Optional central metadata grants are exact and all-or-none. Join keys
-- stay inside SQL; values, payloads, hashes and native permission fields are excluded.
DO $central_statistics_grants$
BEGIN
  IF NOT EXISTS (
    WITH allowed(table_name,column_name) AS (VALUES ${allowedValues})
    SELECT 1 FROM allowed LEFT JOIN pg_attribute attribute
      ON attribute.attrelid=to_regclass('public.'||allowed.table_name)
      AND attribute.attname=allowed.column_name AND attribute.attnum>0 AND NOT attribute.attisdropped
    WHERE attribute.attnum IS NULL
  ) THEN
${Object.entries(CENTRAL_STATISTICS_AUDIT_COLUMNS)
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
  ) THEN RAISE EXCEPTION 'maxim_audit central-statistics metadata privileges are not exact'; END IF;
END
$central_statistics_grants$;
`;
}

export function buildCentralStatisticsIndexReadinessSql() {
  return `WITH required(name,relation,keys,options,unique_required,predicate) AS (VALUES
    ('stats_entities_kind_max_id_key','stats_entities',ARRAY['kind','max_id'],ARRAY[0,0]::smallint[],true,NULL::text),
    ('stats_authorities_scope_key','stats_authorities',ARRAY['issuer','role','entity_id','producer','consumer','actor_max_id','bot_ref','purpose'],ARRAY[0,0,0,0,0,0,0,0]::smallint[],true,NULL),
    ('stats_measurements_entity_day_idx','stats_measurements',ARRAY['entity_id','day','metric','horizon'],ARRAY[0,0,0,0]::smallint[],false,NULL),
    ('stats_ingest_requests_retention_idx','stats_ingest_requests',ARRAY['created_at','producer','producer_epoch','record_kind','operation_key'],ARRAY[0,0,0,0,0]::smallint[],false,NULL),
    ('stats_changes_retention_idx','stats_changes',ARRAY['created_at','id'],ARRAY[0,0]::smallint[],false,NULL),
    ('stats_changes_unpublished_idx','stats_changes',ARRAY['created_at','id'],ARRAY[0,0]::smallint[],false,'(published_seq IS NULL)'),
    ('managed_entity_audience_observations_pkey','managed_entity_audience_observations',ARRAY['chat_id','entity_type'],ARRAY[0,0]::smallint[],true,NULL),
    ('channel_audience_snapshots_chat_id_captured_at_idx','channel_audience_snapshots',ARRAY['chat_id','captured_at'],ARRAY[0,3]::smallint[],false,NULL),
    ('channel_posts_chat_id_latest_snapshot_at_idx','channel_posts',ARRAY['chat_id','latest_snapshot_at'],ARRAY[0,3]::smallint[],false,NULL)
  ) SELECT NOT EXISTS (SELECT 1 FROM required LEFT JOIN pg_index idx
    ON idx.indexrelid=to_regclass('public.'||required.name)
      AND idx.indrelid=to_regclass('public.'||required.relation)
      AND idx.indisvalid AND idx.indisready AND idx.indislive
      AND (NOT required.unique_required OR idx.indisunique)
      AND NOT idx.indisexclusion AND idx.indimmediate
      AND pg_get_expr(idx.indpred,idx.indrelid) IS NOT DISTINCT FROM required.predicate AND idx.indexprs IS NULL
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
    WHERE idx.indexrelid IS NULL) AS central_statistics_indexes_ready \\gset
\\if :central_statistics_indexes_ready
\\else
\\echo MAXIM_CENTRAL_STATISTICS_INDEXES_INVALID
SELECT 1/0;
\\endif
`;
}

// FLAG: Every application-table input is capped at its indexed source before
// aggregation. Lease/sample metadata never establishes current runtime rights.
export function buildCentralStatisticsAuditSql(args) {
  const { ids, explain } = parseCentralStatisticsAuditArgs(args);
  const idsSql = explain ? '$1' : `ARRAY[${ids.map((id) => `'${id}'`).join(',')}]::text[]`;
  const query = `WITH requested AS MATERIALIZED (
    SELECT max_id FROM unnest(${idsSql}) AS max_id
  ), entities AS MATERIALIZED (
    SELECT e.id,e.kind,e.max_id,e.data_revision FROM requested r
    CROSS JOIN (VALUES ('CHANNEL'),('CHAT')) k(kind)
    CROSS JOIN LATERAL (SELECT id,kind,max_id,data_revision FROM public.stats_entities
      WHERE kind=k.kind AND max_id=r.max_id LIMIT 1) e
  ), authority_probe AS MATERIALIZED (
    SELECT e.id AS entity_id,e.kind,a.issuer,a.role,a.producer,a.consumer,a.actor_max_id,
      a.purpose,a.state,a.peer_valid_until,a.checked_at
    FROM entities e CROSS JOIN (VALUES ('MAXIM','SOURCE'),('MAXIM','CONSUMER'),
      ('EXCHANGE','SOURCE'),('EXCHANGE','CONSUMER')) k(issuer,role)
    CROSS JOIN LATERAL (SELECT issuer,role,producer,consumer,actor_max_id,purpose,state,peer_valid_until,checked_at
      FROM public.stats_authorities WHERE issuer=k.issuer AND role=k.role AND entity_id=e.id
      ORDER BY producer,consumer,actor_max_id,bot_ref,purpose LIMIT 65) a
  ), authority_groups AS MATERIALIZED (
    SELECT entity_id,kind,issuer,role,count(*) AS sampled_rows,count(*)>64 AS capped,
      count(*) FILTER (WHERE state='ACTIVE' AND peer_valid_until>statement_timestamp()) AS active_leases,
      count(*) FILTER (WHERE state='ACTIVE' AND peer_valid_until<=statement_timestamp()) AS expired_leases,
      count(*) FILTER (WHERE state='REVOKED') AS revoked_leases,
      min(peer_valid_until) AS earliest_lease_until,max(peer_valid_until) AS latest_lease_until,
      max(checked_at) AS latest_check_at
    FROM authority_probe GROUP BY entity_id,kind,issuer,role
  ), paired_entities AS MATERIALIZED (
    SELECT e.kind,count(*) AS entities_with_candidate_pairs FROM entities e
    WHERE NOT EXISTS (SELECT 1 FROM authority_groups g WHERE g.entity_id=e.id AND g.capped)
      AND EXISTS (SELECT 1 FROM authority_probe s JOIN authority_probe c
        ON s.entity_id=c.entity_id AND s.actor_max_id=c.actor_max_id AND s.purpose=c.purpose
          AND s.consumer=c.consumer
        WHERE s.entity_id=e.id AND s.role='SOURCE' AND c.role='CONSUMER'
          AND s.state='ACTIVE' AND c.state='ACTIVE'
          AND s.peer_valid_until>statement_timestamp() AND c.peer_valid_until>statement_timestamp())
    GROUP BY e.kind
  ), authority_summary AS MATERIALIZED (
    SELECT kind,issuer,role,sum(sampled_rows) AS sampled_rows,bool_or(capped) AS capped,
      sum(active_leases) AS active_leases,sum(expired_leases) AS expired_leases,
      sum(revoked_leases) AS revoked_leases,min(earliest_lease_until) AS earliest_lease_until,
      max(latest_lease_until) AS latest_lease_until,max(latest_check_at) AS latest_check_at
    FROM authority_groups GROUP BY kind,issuer,role
  ), fact_probe AS MATERIALIZED (
    SELECT e.id AS entity_id,e.kind,m.producer,m.metric,m.horizon,m.method_id,m.day,
      m.deleted,m.observed_from,m.observed_to,m.updated_at FROM entities e
    CROSS JOIN LATERAL (SELECT producer,metric,horizon,method_id,day,deleted,observed_from,observed_to,updated_at
      FROM public.stats_measurements WHERE entity_id=e.id
        AND day >= (statement_timestamp() AT TIME ZONE 'UTC')::date-89
        AND day <= (statement_timestamp() AT TIME ZONE 'UTC')::date
      ORDER BY day,metric,horizon LIMIT 1441) m
  ), metrics AS MATERIALIZED (
    SELECT kind,producer,metric,horizon,method_id,count(*) AS sampled_rows,
      count(*) FILTER (WHERE deleted) AS deleted_rows,
      min(day) AS first_day,max(day) AS last_day,
      min(observed_from) FILTER (WHERE NOT deleted) AS first_actual_observation_at,
      max(observed_to) FILTER (WHERE NOT deleted) AS last_actual_observation_at,
      max(updated_at) AS last_stored_at
    FROM fact_probe GROUP BY kind,producer,metric,horizon,method_id
  ), native_probe AS MATERIALIZED (
    SELECT r.max_id,k.kind,a.observed_at,s.captured_at,p.latest_snapshot_at
    FROM requested r CROSS JOIN (VALUES ('CHANNEL'),('CHAT')) k(kind)
    LEFT JOIN LATERAL (SELECT observed_at FROM public.managed_entity_audience_observations
      WHERE chat_id=r.max_id AND entity_type=k.kind LIMIT 1) a ON true
    LEFT JOIN LATERAL (SELECT captured_at FROM public.channel_audience_snapshots
      WHERE chat_id=r.max_id AND k.kind='CHANNEL' ORDER BY captured_at DESC LIMIT 1) s ON true
    LEFT JOIN LATERAL (SELECT latest_snapshot_at FROM public.channel_posts
      WHERE chat_id=r.max_id AND k.kind='CHANNEL' AND latest_snapshot_at IS NOT NULL
      ORDER BY latest_snapshot_at DESC LIMIT 1) p ON true
  ), native_summary AS MATERIALIZED (
    SELECT kind,count(*) FILTER (WHERE observed_at IS NOT NULL OR captured_at IS NOT NULL) AS entities_with_audience_observations,
      max(greatest(observed_at,captured_at AT TIME ZONE 'UTC')) AS last_raw_audience_observation_at,
      max(latest_snapshot_at AT TIME ZONE 'UTC') AS last_raw_views_observation_at
    FROM native_probe GROUP BY kind
  ), receipt_probe AS MATERIALIZED (
    SELECT producer,record_kind,created_at FROM public.stats_ingest_requests
      ORDER BY created_at DESC,producer DESC,producer_epoch DESC,record_kind DESC,operation_key DESC LIMIT 257
  ), receipt_sample AS MATERIALIZED (SELECT producer,record_kind,created_at FROM receipt_probe
    ORDER BY created_at DESC LIMIT 256),
  receipt_summary AS MATERIALIZED (
    SELECT producer,record_kind,count(*) AS sampled_rows,min(created_at) AS oldest_sampled_at,
      max(created_at) AS latest_sampled_at FROM receipt_sample GROUP BY producer,record_kind
  ), change_probe AS MATERIALIZED (
    SELECT id,cause,created_at,published_seq,published_at FROM public.stats_changes
      ORDER BY created_at DESC,id DESC LIMIT 257
  ), change_sample AS MATERIALIZED (SELECT cause,created_at,published_seq,published_at FROM change_probe
    ORDER BY created_at DESC,id DESC LIMIT 256),
  unpublished_probe AS MATERIALIZED (
    SELECT created_at FROM public.stats_changes WHERE published_seq IS NULL
      ORDER BY created_at,id LIMIT 257
  ) SELECT json_build_object(
    'schema_version',1,'audit','central_statistics','scope','EXACT_REQUESTED_ENTITIES_AND_GLOBAL_RECENT_METADATA',
    'sampled_at',statement_timestamp(),'requested_id_count',(SELECT count(*) FROM requested),
    'entity_count',(SELECT count(*) FROM entities),'retention_days',90,
    'channel_entities',(SELECT count(*) FROM entities WHERE kind='CHANNEL'),
    'chat_entities',(SELECT count(*) FROM entities WHERE kind='CHAT'),
    'entity_revision_min',(SELECT min(data_revision) FROM entities),
    'entity_revision_max',(SELECT max(data_revision) FROM entities),
    'authority_cap_per_entity_issuer_role',64,
    'authority_groups_capped',(SELECT count(*) FROM authority_groups WHERE capped),
    'authorities',coalesce((SELECT json_agg(authority_summary ORDER BY kind,issuer,role) FROM authority_summary),'[]'::json),
    'candidate_pairs',coalesce((SELECT json_agg(paired_entities ORDER BY kind) FROM paired_entities),'[]'::json),
    'metric_cap_per_entity',1440,
    'measurement_entities_capped',(SELECT count(*) FROM (SELECT entity_id FROM fact_probe GROUP BY entity_id HAVING count(*)>1440) capped),
    'metrics',coalesce((SELECT json_agg(metrics ORDER BY kind,producer,metric,horizon,method_id) FROM metrics),'[]'::json),
    'native_observations',coalesce((SELECT json_agg(native_summary ORDER BY kind) FROM native_summary),'[]'::json),
    'global_recent_receipts_cap',256,'global_recent_receipts_capped',(SELECT count(*)>256 FROM receipt_probe),
    'global_recent_receipts',coalesce((SELECT json_agg(receipt_summary ORDER BY producer,record_kind) FROM receipt_summary),'[]'::json),
    'global_recent_changes_cap',256,'global_recent_changes_capped',(SELECT count(*)>256 FROM change_probe),
    'global_latest_change_at',(SELECT max(created_at) FROM change_sample),
    'global_latest_sampled_published_at',(SELECT max(published_at) FROM change_sample),
    'global_latest_sampled_published_sequence',(SELECT max(published_seq) FROM change_sample),
    'global_unpublished_sample_count',(SELECT least(count(*),256) FROM unpublished_probe),
    'global_unpublished_sample_capped',(SELECT count(*)>256 FROM unpublished_probe),
    'global_oldest_unpublished_at',(SELECT min(created_at) FROM unpublished_probe),
    'coverage_basis','BOUNDED_METADATA_NOT_VALUES_OR_FULL_HISTORY',
    'native_history_is_virtual',true,'remote_rights_proven',false,'metric_scopes_proven',false,
    'producer_epoch_proven',false,'collection_handoff_proven',false
  );`;
  if (explain)
    return `SET LOCAL enable_sort=off;
SET LOCAL plan_cache_mode=force_generic_plan;
PREPARE central_statistics_audit_plan(text[]) AS ${query}
EXPLAIN (FORMAT JSON) EXECUTE central_statistics_audit_plan(ARRAY[${ids.map((id) => `'${id}'`).join(',')}]::text[]);
DEALLOCATE central_statistics_audit_plan;
`;
  return 'SET LOCAL enable_sort=off;\n' + query + '\n';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args[0] === '--validate-scope') parseCentralStatisticsAuditArgs(args.slice(1));
    else if (args[0] === '--privileges') {
      if (args.length > 2 || (args.length === 2 && args[1] !== '--require-all'))
        throw new Error('Invalid privilege arguments');
      process.stdout.write(buildCentralStatisticsPrivilegesSql(args.length === 2));
    } else if (args.length === 1 && args[0] === '--provision')
      process.stdout.write(buildCentralStatisticsProvisionSql());
    else {
      const sql = buildCentralStatisticsAuditSql(args);
      process.stdout.write(buildCentralStatisticsIndexReadinessSql());
      process.stdout.write(sql);
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
