import { pathToFileURL } from 'node:url';

// FLAG: Catalog/statistics only, under the bounded maxim_audit session. Never read
// application rows or accept caller SQL/names. Size functions stat relation files;
// estimates and dead tuples do not establish reclaimable bytes or authorize deletion.
export const postgresStorageAuditSql = `
WITH relations AS MATERIALIZED (
  SELECT c.oid, c.relname, c.reltoastrelid, c.reloptions
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'm')
  ORDER BY c.oid LIMIT 513
), measured AS MATERIALIZED (
  SELECT r.*,
    pg_total_relation_size(r.oid) AS total_bytes,
    pg_table_size(r.oid) AS table_bytes,
    pg_indexes_size(r.oid) AS indexes_bytes,
    CASE WHEN r.reltoastrelid = 0 THEN 0
      ELSE pg_total_relation_size(r.reltoastrelid) END AS toast_bytes,
    s.n_live_tup AS estimated_live_rows, s.n_dead_tup AS estimated_dead_rows,
    s.n_tup_ins AS inserted_since_stats_reset,
    s.n_tup_upd AS updated_since_stats_reset,
    s.n_tup_del AS deleted_since_stats_reset,
    s.last_vacuum, s.last_autovacuum, s.last_analyze, s.last_autoanalyze,
    s.vacuum_count, s.autovacuum_count
  FROM relations r LEFT JOIN pg_stat_user_tables s ON s.relid = r.oid
  WHERE (SELECT count(*) FROM relations) <= 512
), index_candidates AS MATERIALIZED (
  SELECT i.indexrelid, i.indrelid, i.indisvalid, i.indisready, i.indisunique
  FROM pg_index i JOIN measured r ON r.oid = i.indrelid
  ORDER BY i.indexrelid LIMIT 4097
), measured_indexes AS MATERIALIZED (
  SELECT r.relname AS table_name, c.relname AS index_name,
    pg_relation_size(i.indexrelid) AS bytes,
    i.indisvalid AS valid, i.indisready AS ready, i.indisunique AS unique_index,
    s.idx_scan AS scans_since_stats_reset
  FROM index_candidates i JOIN pg_class c ON c.oid = i.indexrelid
  JOIN measured r ON r.oid = i.indrelid
  LEFT JOIN pg_stat_user_indexes s ON s.indexrelid = i.indexrelid
  WHERE (SELECT count(*) FROM index_candidates) <= 4096
)
SELECT json_build_object(
  'schema_version', 1, 'audit', 'postgres_storage', 'sampled_at', clock_timestamp(),
  'postmaster_started_at', pg_postmaster_start_time(),
  'stats_reset_at', (SELECT stats_reset FROM pg_stat_database WHERE datname = current_database()),
  'relation_limit_exceeded', (SELECT count(*) > 512 FROM relations),
  'index_limit_exceeded', (SELECT count(*) > 4096 FROM index_candidates),
  'relations_measured', (SELECT count(*) FROM measured),
  'indexes_measured', (SELECT count(*) FROM measured_indexes),
  'public_total_bytes', (SELECT sum(total_bytes) FROM measured),
  'public_table_bytes_including_toast', (SELECT sum(table_bytes) FROM measured),
  'public_indexes_bytes_excluding_toast', (SELECT sum(indexes_bytes) FROM measured),
  'public_toast_bytes_including_indexes', (SELECT sum(toast_bytes) FROM measured),
  'settings', (SELECT json_object_agg(name, setting) FROM pg_settings WHERE name IN (
    'autovacuum', 'autovacuum_max_workers', 'autovacuum_naptime',
    'autovacuum_vacuum_threshold', 'autovacuum_vacuum_scale_factor',
    'autovacuum_vacuum_insert_threshold', 'autovacuum_vacuum_insert_scale_factor',
    'autovacuum_analyze_threshold', 'autovacuum_analyze_scale_factor',
    'autovacuum_vacuum_cost_delay', 'autovacuum_vacuum_cost_limit',
    'max_wal_size', 'min_wal_size', 'wal_keep_size', 'archive_mode'
  )),
  'largest_relations', (SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) FROM (
    SELECT relname AS table_name, total_bytes, table_bytes, indexes_bytes, toast_bytes,
      estimated_live_rows, estimated_dead_rows, inserted_since_stats_reset,
      updated_since_stats_reset, deleted_since_stats_reset,
      last_vacuum, last_autovacuum, last_analyze, last_autoanalyze,
      vacuum_count, autovacuum_count, reloptions AS storage_options
    FROM measured ORDER BY total_bytes DESC, relname LIMIT 32
  ) t),
  'largest_indexes', (SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) FROM (
    SELECT * FROM measured_indexes ORDER BY bytes DESC, index_name LIMIT 32
  ) t)
);
`;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length > 3 || (process.argv.length === 3 && process.argv[2] !== '--explain')) {
    process.stderr.write('This fixed audit accepts only --explain.\n');
    process.exitCode = 2;
  } else {
    process.stdout.write(
      `${process.argv[2] === '--explain' ? 'EXPLAIN (FORMAT JSON) ' : ''}${postgresStorageAuditSql}`,
    );
  }
}
