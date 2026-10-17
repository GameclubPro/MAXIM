import { OUTCOME_COHORT_TARGETS } from '../../scripts/agent/outcome-cohort-online-targets.mjs';
import {
  parseCapacityFilesystem,
  validateMultibotComposeArgs,
} from './multibot-prepare-capacity.mjs';
import { readOutcomeCohortState, runOutcomeCohortCommand } from './outcome-cohort-online-state.mjs';

export const OUTCOME_COHORT_MINIMUM_FREE_BYTES = 10 * 1024 ** 3;
const fail = (code) => {
  throw new Error(`OUTCOME_COHORT_${code}`);
};
export const outcomeCohortCapacitySql = `BEGIN READ ONLY;
SET LOCAL statement_timeout = '2500ms';
SET LOCAL lock_timeout = '250ms';
SET LOCAL max_parallel_workers_per_gather = 0;
WITH expected(selector, table_name, index_name, keys) AS (VALUES
${OUTCOME_COHORT_TARGETS.map((t) => `('${t.selector}','${t.table}','${t.comparableIndex}',ARRAY[${t.comparableKeys.map((key) => `'${key}'`)}])`).join(',\n')}
), tables AS (
 SELECT expected.selector, pg_table_size(parent.oid) AS "tableBytes", parent.reltuples AS "approxRows",
   pg_relation_size(relation.oid) AS "orderedIndexBytes",
   COALESCE(parent.relkind = 'r' AND parent.relpersistence = 'p' AND parent.reltablespace = 0
     AND NOT parent.relhassubclass AND NOT parent.relispartition
     AND NOT EXISTS (SELECT 1 FROM pg_inherits inheritance
       WHERE inheritance.inhrelid=parent.oid OR inheritance.inhparent=parent.oid)
     AND relation.relkind = 'i' AND relation.relpersistence = 'p' AND relation.reltablespace = 0
     AND relation.reloptions IS NULL AND method.amname = 'btree'
     AND state.indrelid = parent.oid AND state.indisvalid AND state.indisready AND state.indislive
     AND NOT state.indisunique AND NOT state.indisprimary AND NOT state.indisexclusion
     AND state.indimmediate
     AND state.indexprs IS NULL AND state.indpred IS NULL
     AND state.indnkeyatts = cardinality(expected.keys) AND state.indnatts = cardinality(expected.keys)
     AND 0 = ALL(state.indoption::smallint[])
     AND ARRAY(SELECT pg_get_indexdef(relation.oid,k,false)
       FROM generate_series(1,cardinality(expected.keys)) k ORDER BY k) =
       ARRAY(SELECT quote_ident(key) FROM unnest(expected.keys) key)
     AND NOT EXISTS (SELECT 1 FROM unnest(state.indclass::oid[]) binding
       JOIN pg_opclass definition ON definition.oid=binding
       WHERE NOT definition.opcdefault OR definition.opcnamespace <> 'pg_catalog'::regnamespace)
     AND NOT EXISTS (SELECT 1 FROM unnest(state.indcollation::oid[],expected.keys) binding(actual_oid,name)
       JOIN pg_attribute attribute ON attribute.attrelid=parent.oid AND attribute.attname=binding.name
       WHERE binding.actual_oid <> attribute.attcollation),false) AS exact
 FROM expected LEFT JOIN pg_class parent ON parent.oid=to_regclass('public.' || expected.table_name)
 LEFT JOIN pg_class relation ON relation.oid=to_regclass('public.' || expected.index_name)
 LEFT JOIN pg_index state ON state.indexrelid=relation.oid
 LEFT JOIN pg_am method ON method.oid=relation.relam
)
SELECT json_build_object('tables',(SELECT json_agg(tables) FROM tables),
 'maxWalBytes',pg_size_bytes(current_setting('max_wal_size')),
 'dataDirectory',current_setting('data_directory'),
 'tempTablespaces',current_setting('temp_tablespaces'),
 'defaultLayout',dattablespace=1663 AND current_setting('default_tablespace')='')
FROM pg_database WHERE datname=current_database();
COMMIT;`;

export function assessOutcomeCohortPrepareCapacity(metadata, filesystems, pending) {
  if (
    !Array.isArray(pending) ||
    !pending.length ||
    new Set(pending).size !== pending.length ||
    pending.some((selector) => !OUTCOME_COHORT_TARGETS.some((t) => t.selector === selector)) ||
    !metadata?.defaultLayout ||
    metadata.tempTablespaces !== '' ||
    !Number.isSafeInteger(metadata.maxWalBytes) ||
    metadata.maxWalBytes < 0 ||
    !Array.isArray(metadata.tables) ||
    metadata.tables.length !== 2
  )
    fail('CAPACITY_METADATA_INVALID');
  const estimates = pending.map((selector) => {
    const target = OUTCOME_COHORT_TARGETS.find((t) => t.selector === selector);
    const tables = metadata.tables.filter((table) => table.selector === selector);
    const table = tables[0];
    if (
      tables.length !== 1 ||
      table.exact !== true ||
      !['tableBytes', 'orderedIndexBytes'].every(
        (key) => Number.isSafeInteger(table[key]) && table[key] >= 0,
      ) ||
      !Number.isFinite(table.approxRows) ||
      table.approxRows < 0
    )
      fail('CAPACITY_METADATA_INVALID');
    if (table.tableBytes > target.tableCeilingBytes) fail('TABLE_SCOPE_EXCEEDED');
    // FLAG: Native fixtures check the visible bytes/row estimate; comparable live index and
    // table bytes preserve headroom for wider retained identities. This is not a WAL cap.
    const indexBytes = Math.ceil(
      Math.max(
        table.approxRows * target.estimateBytesPerRow,
        table.orderedIndexBytes * 2,
        table.tableBytes,
      ),
    );
    if (!Number.isSafeInteger(indexBytes)) fail('CAPACITY_METADATA_INVALID');
    return { selector, indexBytes, tempBytes: target.tempBytes, tableBytes: table.tableBytes };
  });
  const dataBytes = estimates.reduce((sum, estimate) => sum + estimate.indexBytes, 0);
  const budgets = {
    data: dataBytes,
    temp: Math.max(...estimates.map((e) => e.tempBytes)),
    wal: Math.max(dataBytes * 2, metadata.maxWalBytes * 2),
    docker: 0,
  };
  const devices = new Map();
  for (const role of ['data', 'temp', 'wal', 'docker']) {
    const fs = filesystems[role];
    if (
      !fs?.device ||
      !fs.mount ||
      !Number.isSafeInteger(fs.availableBytes) ||
      fs.availableBytes < 0
    )
      fail('FILESYSTEM_INVALID');
    const device = devices.get(fs.device) ?? {
      ...fs,
      roles: [],
      requiredBytes: OUTCOME_COHORT_MINIMUM_FREE_BYTES,
    };
    device.availableBytes = Math.min(device.availableBytes, fs.availableBytes);
    device.roles.push(role);
    device.requiredBytes += budgets[role];
    if (!Number.isSafeInteger(device.requiredBytes)) fail('CAPACITY_METADATA_INVALID');
    devices.set(fs.device, device);
  }
  return {
    estimates,
    budgets,
    minimumFreeBytes: OUTCOME_COHORT_MINIMUM_FREE_BYTES,
    devices: [...devices.values()].map((device) => ({
      ...device,
      sufficient: device.availableBytes >= device.requiredBytes,
    })),
  };
}

export async function checkOutcomeCohortPrepareCapacity(
  composeArgs,
  { run = runOutcomeCohortCommand, state, root = process.cwd() } = {},
) {
  validateMultibotComposeArgs(composeArgs);
  const current = state ?? (await readOutcomeCohortState(composeArgs, { root, run }));
  // FLAG: Exact completed receipts/catalogs are checked first. Future table growth is not a
  // reason to prevent an ordinary release once these one-time builds are complete.
  if (current.state === 'already_applied') return { state: current, skipped: true };
  try {
    const pg = ['compose', ...composeArgs, 'exec', '-T', 'postgres'];
    const result = await run(
      'docker',
      [...pg, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'maxim', '-d', 'maxim', '-Atq'],
      { input: outcomeCohortCapacitySql },
    );
    const metadata = JSON.parse(result.stdout.trim());
    if (typeof metadata.dataDirectory !== 'string' || !metadata.dataDirectory.startsWith('/'))
      fail('FILESYSTEM_INVALID');
    const wal = (
      await run('docker', [
        ...pg,
        'sh',
        '-c',
        'readlink -f "$1/pg_wal"',
        'outcome-wal',
        metadata.dataDirectory,
      ])
    ).stdout.trim();
    if (!wal.startsWith('/')) fail('FILESYSTEM_INVALID');
    const dataFs = parseCapacityFilesystem(
      (await run('docker', [...pg, 'df', '-Pk', metadata.dataDirectory])).stdout,
    );
    const walFs = parseCapacityFilesystem((await run('docker', [...pg, 'df', '-Pk', wal])).stdout);
    const dockerFs = parseCapacityFilesystem((await run('df', ['-Pk', '/var/lib/docker'])).stdout);
    const capacity = assessOutcomeCohortPrepareCapacity(
      metadata,
      { data: dataFs, temp: dataFs, wal: walFs, docker: dockerFs },
      current.pending,
    );
    if (capacity.devices.some((device) => !device.sufficient)) fail('CAPACITY_INSUFFICIENT');
    return {
      ...capacity,
      state: current,
      skipped: false,
      monitorPaths: { data: metadata.dataDirectory, wal, docker: '/var/lib/docker' },
    };
  } catch (error) {
    if (/^OUTCOME_COHORT_[A-Z_]+$/u.test(error?.message ?? '')) throw error;
    fail('CAPACITY_UNAVAILABLE');
  }
}
