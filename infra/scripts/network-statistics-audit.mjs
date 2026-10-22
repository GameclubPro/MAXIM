import { pathToFileURL } from 'node:url';

export const NETWORK_STATISTICS_AUDIT_COLUMNS = {
  channel_audience_snapshots: ['chat_id', 'participants_count', 'captured_at'],
  channel_stats_sync_states: [
    'chat_id',
    'membership_coverage_from',
    'views_coverage_from',
    'last_audience_sync_at',
    'last_views_sync_at',
    'last_views_discovery_at',
  ],
  channel_posts: ['id', 'chat_id', 'published_at', 'latest_snapshot_at'],
  channel_post_view_snapshots: ['channel_post_id', 'captured_at'],
};

export const NETWORK_STATISTICS_OBSERVATION_AUDIT_COLUMNS = {
  managed_entity_audience_observations: [
    'chat_id',
    'entity_type',
    'participants_count',
    'observed_at',
    'source',
  ],
  channel_view_observation_states: [
    'channel_post_id',
    'baseline_at',
    'observed_at',
    'observed_views',
    'high_water_views',
    'anomaly_at',
    'source',
  ],
  channel_view_observed_intervals: [
    'channel_post_id',
    'chat_id',
    'from_at',
    'to_at',
    'delta',
    'quality',
    'source',
  ],
  channel_view_archive_states: [
    'chat_id',
    'cursor_at',
    'discovered_from',
    'discovery_complete_at',
    'last_attempt_at',
    'last_success_at',
    'full_refresh_at',
    'stalled_at',
    'observed_post_count',
    'first_observed_at',
    'last_observed_at',
  ],
  marketplace_bindings: [
    'entity_id',
    'kind',
    'profile',
    'state',
    'statistics_consent',
    'collection_owner',
    'collection_metrics',
    'checked_at',
    'valid_until',
    'lease_until',
    'history_complete',
    'history_anomaly',
    'native_history_checked_at',
    'native_full_checked_at',
    'native_audience_checked_at',
  ],
};

function buildPrivilegesSql(columns, key, requireAll) {
  const count = Object.values(columns).flat().length;
  const allowed = Object.entries(columns)
    .flatMap(([table, columns]) => columns.map((column) => `('${table}', '${column}')`))
    .join(',');
  return `WITH allowed(table_name,column_name) AS (VALUES ${allowed}), effective AS (
    SELECT relation.relname AS table_name,attribute.attname AS column_name
    FROM pg_class relation JOIN pg_namespace ns ON ns.oid=relation.relnamespace
    JOIN pg_attribute attribute ON attribute.attrelid=relation.oid
    WHERE ns.nspname='public' AND relation.relname IN (SELECT table_name FROM allowed)
      AND attribute.attnum>0 AND NOT attribute.attisdropped
      AND has_column_privilege('maxim_audit',relation.oid,attribute.attnum,'SELECT')
  ) SELECT NOT EXISTS (SELECT * FROM effective EXCEPT SELECT * FROM allowed)
    AND (SELECT count(*) FROM effective) IN (${requireAll ? '' : '0,'}${count})
    AND NOT EXISTS (SELECT 1 FROM pg_class relation JOIN pg_namespace ns ON ns.oid=relation.relnamespace
      WHERE ns.nspname='public' AND relation.relname IN (SELECT table_name FROM allowed)
        AND (has_table_privilege('maxim_audit',relation.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
          OR EXISTS (SELECT 1 FROM pg_attribute attribute WHERE attribute.attrelid=relation.oid
            AND attribute.attnum>0 AND NOT attribute.attisdropped
            AND has_column_privilege('maxim_audit',relation.oid,attribute.attnum,'INSERT,UPDATE,REFERENCES'))))
    AS ${key}_privileges_ready \\gset
\\if :${key}_privileges_ready
\\else
\\echo MAXIM_${key.toUpperCase()}_PRIVILEGES_INVALID
SELECT 1/0;
\\endif
`;
}

export function buildNetworkStatisticsPrivilegesSql(requireAll = false) {
  return buildPrivilegesSql(NETWORK_STATISTICS_AUDIT_COLUMNS, 'network_statistics', requireAll);
}

export function buildNetworkStatisticsObservationPrivilegesSql(requireAll = false) {
  return buildPrivilegesSql(
    NETWORK_STATISTICS_OBSERVATION_AUDIT_COLUMNS,
    'network_statistics_observations',
    requireAll,
  );
}

export function buildNetworkStatisticsIndexReadinessSql(observations = false) {
  return `WITH required(name,relation,keys,options,unique_required) AS (VALUES
    ('chats_pkey','chats',ARRAY['id'],ARRAY[0]::smallint[],true),
    ('channel_audience_snapshots_chat_id_captured_at_idx','channel_audience_snapshots',ARRAY['chat_id','captured_at'],ARRAY[0,3]::smallint[],false),
    ('channel_stats_sync_states_chat_id_key','channel_stats_sync_states',ARRAY['chat_id'],ARRAY[0]::smallint[],true),
    ('channel_posts_chat_id_published_at_idx','channel_posts',ARRAY['chat_id','published_at'],ARRAY[0,3]::smallint[],false),
    ('channel_post_view_snapshots_channel_post_id_captured_at_idx','channel_post_view_snapshots',ARRAY['channel_post_id','captured_at'],ARRAY[0,3]::smallint[],false)
    ${
      observations
        ? `,
    ('managed_entity_audience_observations_pkey','managed_entity_audience_observations',ARRAY['chat_id','entity_type'],ARRAY[0,0]::smallint[],true),
    ('channel_view_observation_states_pkey','channel_view_observation_states',ARRAY['channel_post_id'],ARRAY[0]::smallint[],true),
    ('channel_view_observed_intervals_pkey','channel_view_observed_intervals',ARRAY['channel_post_id','to_at'],ARRAY[0,0]::smallint[],true),
    ('channel_view_archive_states_pkey','channel_view_archive_states',ARRAY['chat_id'],ARRAY[0]::smallint[],true),
    ('marketplace_bindings_entity_idx','marketplace_bindings',ARRAY['entity_id','state'],ARRAY[0,0]::smallint[],false)`
        : ''
    }
  ) SELECT NOT EXISTS (SELECT 1 FROM required LEFT JOIN pg_index idx
    ON idx.indexrelid=to_regclass('public.'||required.name)
      AND idx.indrelid=to_regclass('public.'||required.relation)
      AND idx.indisvalid AND idx.indisready AND idx.indislive
      AND (NOT required.unique_required OR idx.indisunique)
      AND idx.indpred IS NULL AND idx.indexprs IS NULL
      AND idx.indnkeyatts=cardinality(required.keys) AND idx.indnatts=cardinality(required.keys)
      AND ARRAY(SELECT unnest(idx.indoption::smallint[]))=required.options
      AND EXISTS (SELECT 1 FROM pg_class index_relation JOIN pg_am method ON method.oid=index_relation.relam
        WHERE index_relation.oid=idx.indexrelid AND method.amname='btree')
      AND ARRAY(SELECT pg_get_indexdef(idx.indexrelid,pos,false)
        FROM generate_series(1,idx.indnkeyatts) AS pos ORDER BY pos)=required.keys
    WHERE idx.indexrelid IS NULL) AS network_statistics_indexes_ready \\gset
\\if :network_statistics_indexes_ready
\\else
\\echo MAXIM_NETWORK_STATISTICS_INDEXES_INVALID
SELECT 1/0;
\\endif
`;
}

export function buildNetworkStatisticsAuditSql(args) {
  if (
    args.length < 1 ||
    args.length > 3 ||
    args.slice(1).some((arg) => !['--explain', '--observations'].includes(arg)) ||
    new Set(args.slice(1)).size !== args.length - 1
  )
    throw new Error(
      'Usage: network-statistics <negative-chat-ID-CSV, max 12> [--observations] [--explain]',
    );
  const observations = args.includes('--observations');
  const ids = [...new Set(args[0].split(','))];
  if (ids.length < 1 || ids.length > 12 || ids.some((id) => !/^-[1-9][0-9]{0,19}$/.test(id)))
    throw new Error('Expected 1..12 distinct negative numeric entity IDs');
  // FLAG: Fixed bounded catalog. Every history probe starts at an explicit entity
  // index; never accept SQL/table names or fetch message bodies and user identities.
  return `${args.includes('--explain') ? 'EXPLAIN (FORMAT JSON)\n' : ''}
WITH selected(id) AS (VALUES ${ids.map((id) => `('${id}'::text)`).join(',')}),
entities AS MATERIALIZED (
  SELECT c.id,c.entity_type FROM selected s JOIN chats c ON c.id=s.id
), post_heads AS MATERIALIZED (
  SELECT e.id AS entity_id,p.id,p.published_at,p.latest_snapshot_at FROM entities e
  CROSS JOIN LATERAL (SELECT id,published_at,latest_snapshot_at FROM channel_posts
    WHERE chat_id=e.id ORDER BY published_at DESC LIMIT 25) p
), sampled AS MATERIALIZED (
  SELECT e.id AS entity_id,p.id,p.published_at,p.latest_snapshot_at FROM entities e
  CROSS JOIN LATERAL (SELECT id,published_at,latest_snapshot_at FROM post_heads
    WHERE entity_id=e.id ORDER BY published_at DESC,id LIMIT 24) p
), evidence AS (
  SELECT e.id,e.entity_type,
    audience.participants_count,audience.captured_at AS audience_at,
    earliest.captured_at AS first_audience_at,
    state.membership_coverage_from,state.views_coverage_from,
    state.last_audience_sync_at,state.last_views_sync_at,state.last_views_discovery_at,
    posts.sample_count,posts.capped,posts.oldest_post_at,posts.newest_post_at,
    posts.latest_poll_at,posts.raw_snapshot_sample,posts.oldest_snapshot_at
    ${observations ? ',observation.payload AS observations' : ''}
  FROM entities e
  LEFT JOIN LATERAL (SELECT participants_count,captured_at FROM channel_audience_snapshots
    WHERE chat_id=e.id ORDER BY captured_at DESC LIMIT 1) audience ON true
  LEFT JOIN LATERAL (SELECT captured_at FROM channel_audience_snapshots
    WHERE chat_id=e.id ORDER BY captured_at ASC LIMIT 1) earliest ON true
  LEFT JOIN channel_stats_sync_states state ON state.chat_id=e.id
  LEFT JOIN LATERAL (
    WITH samples AS MATERIALIZED (
      SELECT p.id,p.published_at,p.latest_snapshot_at,s.captured_at
      FROM sampled p LEFT JOIN LATERAL (
        SELECT captured_at FROM channel_post_view_snapshots WHERE channel_post_id=p.id
        ORDER BY captured_at DESC LIMIT 2
      ) s ON true WHERE p.entity_id=e.id
    )
    SELECT (SELECT count(*) FROM sampled WHERE entity_id=e.id)::int AS sample_count,
      (SELECT count(*) FROM post_heads WHERE entity_id=e.id)>24 AS capped,
      min(published_at) AS oldest_post_at,max(published_at) AS newest_post_at,
      max(latest_snapshot_at) AS latest_poll_at,count(captured_at)::int AS raw_snapshot_sample,
      min(captured_at) AS oldest_snapshot_at FROM samples
  ) posts ON true
  ${observations ? observationEvidenceSql() : ''}
)
SELECT json_build_object('audit','network_statistics','schema_version',${observations ? 2 : 1},'observed_at',now(),
  'scope',json_build_object('requested_entities',${ids.length},'post_cap_per_entity',24,'snapshots_per_post',2,
    'observations',${observations},'intervals_per_post',${observations ? 2 : 0},'owner_bindings_per_entity',${observations ? 8 : 0}),
  'v2_schema_present',to_regclass('public.channel_view_observation_states') IS NOT NULL,
  'entities',coalesce((SELECT json_agg(row_to_json(evidence) ORDER BY id) FROM evidence),'[]'::json));
`;
}

function observationEvidenceSql() {
  return `LEFT JOIN LATERAL (
    SELECT json_build_object(
      'audience',(SELECT json_build_object('entity_type',a.entity_type,'participants_count',a.participants_count,
        'observed_at',a.observed_at,'writer_source',CASE WHEN a.source IN ('major','marketplace') THEN a.source ELSE 'other' END)
        FROM managed_entity_audience_observations a WHERE a.chat_id=e.id AND a.entity_type=e.entity_type),
      'archive',(SELECT json_build_object('cursor_at',a.cursor_at,'discovered_from',a.discovered_from,
        'discovery_complete_at',a.discovery_complete_at,'last_attempt_at',a.last_attempt_at,'last_success_at',a.last_success_at,
        'full_refresh_at',a.full_refresh_at,'stalled_at',a.stalled_at,'observed_post_count',a.observed_post_count,
        'first_observed_at',a.first_observed_at,'last_observed_at',a.last_observed_at)
        FROM channel_view_archive_states a WHERE a.chat_id=e.id),
      'posts',coalesce((SELECT json_agg(json_build_object('published_at',p.published_at,
        'baseline_at',v.baseline_at,'observed_at',v.observed_at,'observed_views',v.observed_views,
        'high_water_views',v.high_water_views,'anomaly_at',v.anomaly_at,
        'writer_source',CASE WHEN v.source IN ('major','marketplace') THEN v.source WHEN v.source IS NOT NULL THEN 'other' END,
        'intervals',coalesce(i.items,'[]'::json)) ORDER BY p.published_at DESC,p.id)
        FROM sampled p LEFT JOIN channel_view_observation_states v ON v.channel_post_id=p.id
        LEFT JOIN LATERAL (SELECT json_agg(json_build_object('from_at',x.from_at,'to_at',x.to_at,'delta',x.delta::text,
          'chat_matches',x.chat_id=e.id,
          'quality',CASE WHEN x.quality IN ('ready','gap','correction') THEN x.quality ELSE 'other' END,
          'writer_source',CASE WHEN x.source IN ('major','marketplace') THEN x.source ELSE 'other' END) ORDER BY x.to_at DESC) AS items
          FROM (SELECT chat_id,from_at,to_at,delta,quality,source FROM channel_view_observed_intervals
            WHERE channel_post_id=p.id ORDER BY to_at DESC LIMIT 2) x) i ON true
        WHERE p.entity_id=e.id),'[]'::json),
      'collector_metadata',(WITH candidates AS MATERIALIZED (
        SELECT kind,profile,state,statistics_consent,collection_owner,collection_metrics,checked_at,valid_until,lease_until,
          history_complete,history_anomaly,native_history_checked_at,native_full_checked_at,native_audience_checked_at
        FROM marketplace_bindings WHERE entity_id=e.id LIMIT 9
      ), bounded AS MATERIALIZED (SELECT kind,profile,state,statistics_consent,collection_owner,collection_metrics,
        checked_at,valid_until,lease_until,history_complete,history_anomaly,native_history_checked_at,
        native_full_checked_at,native_audience_checked_at FROM candidates LIMIT 8)
        SELECT json_build_object('authority_verified',false,'scope','stored_binding_metadata',
          'sample_count',(SELECT count(*) FROM bounded),'capped',(SELECT count(*) FROM candidates)>8,
          'bindings',coalesce((SELECT json_agg(json_build_object(
            'kind',CASE WHEN kind IN ('CHAT','CHANNEL') THEN kind ELSE 'other' END,
            'profile',CASE WHEN profile IN ('moderation','publisher') THEN profile ELSE 'other' END,
            'state',CASE WHEN state IN ('ACTIVE','UNKNOWN','DISABLED','DENIED','EXPIRED') THEN state ELSE 'other' END,
            'statistics_consent',statistics_consent,
            'collection_owner',CASE WHEN collection_owner IN ('MAXIM','SHADOW') THEN collection_owner ELSE 'other' END,
            'audience_metric',collection_metrics ? 'AUDIENCE','reach_metric',collection_metrics ? 'REACH',
            'publication_hour_metric',collection_metrics ? 'PUBLICATION_HOUR',
            'checked_at',checked_at,'valid_until',valid_until,'lease_until',lease_until,
            'history_complete',history_complete,'history_anomaly',history_anomaly,
            'native_history_checked_at',native_history_checked_at,'native_full_checked_at',native_full_checked_at,
            'native_audience_checked_at',native_audience_checked_at)) FROM bounded),'[]'::json)))
    ) AS payload
  ) observation ON true`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args[0] === '--privileges') {
      if (
        args.length > 3 ||
        args.slice(1).some((arg) => !['--require-all', '--observations'].includes(arg)) ||
        new Set(args.slice(1)).size !== args.length - 1
      )
        throw new Error('Invalid privilege arguments');
      process.stdout.write(buildNetworkStatisticsPrivilegesSql(args.includes('--require-all')));
      process.stdout.write(
        buildNetworkStatisticsObservationPrivilegesSql(
          args.includes('--require-all') && args.includes('--observations'),
        ),
      );
    } else {
      const report = buildNetworkStatisticsAuditSql(args);
      process.stdout.write(
        buildNetworkStatisticsIndexReadinessSql(args.includes('--observations')),
      );
      process.stdout.write(report);
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
