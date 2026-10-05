#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const GiB = 1024 ** 3;
const runtimeHeadroomBytes = 8 * GiB;
const catalogSql = `BEGIN READ ONLY;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '10s';
SET LOCAL max_parallel_workers_per_gather = 0;
SELECT json_build_object(
  'tableBytes', pg_table_size('public.webhook_events'),
  'approxRows', relation.reltuples,
  'orderedIndexBytes', pg_relation_size('public.webhook_events_status_created_at_idx'),
  'maxWalBytes', pg_size_bytes(current_setting('max_wal_size')),
  'dataDirectory', current_setting('data_directory'),
  'tempTablespaces', current_setting('temp_tablespaces'),
  'defaultLayout', relation.reltablespace = 0 AND database.dattablespace = 1663
) FROM pg_catalog.pg_class relation
JOIN pg_catalog.pg_database database ON database.datname = current_database()
WHERE relation.oid = 'public.webhook_events'::regclass;
COMMIT;`;

export function parseCapacityFilesystem(output) {
  const rows = output.trim().split('\n');
  const match = rows.at(-1)?.match(/^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+\d+%\s+(.+)$/u);
  if (!match) throw new Error('MULTIBOT_PREPARE_FILESYSTEM_UNKNOWN');
  const availableBytes = Number(match[4]) * 1024;
  if (!Number.isSafeInteger(availableBytes) || availableBytes < 0)
    throw new Error('MULTIBOT_PREPARE_FILESYSTEM_UNKNOWN');
  return { device: match[1], mount: match[5], availableBytes };
}

export function assessMultibotPrepareCapacity(metadata, filesystems) {
  for (const field of ['tableBytes', 'approxRows', 'orderedIndexBytes', 'maxWalBytes'])
    if (
      !Number.isFinite(metadata[field]) ||
      metadata[field] < 0 ||
      (field !== 'approxRows' && !Number.isSafeInteger(metadata[field]))
    )
      throw new Error('MULTIBOT_PREPARE_STORAGE_METADATA_UNKNOWN');
  if (!metadata.defaultLayout || metadata.tempTablespaces !== '')
    throw new Error('MULTIBOT_PREPARE_EXTERNAL_TABLESPACE_UNSUPPORTED');
  // FLAG: This is a conservative capacity estimate, not a promise of build speed or a
  // PostgreSQL worst-case bound. Builds stay serialized; a failed receipt is never resolved here.
  const indexEstimateBytes = Math.ceil(
    Math.max(metadata.approxRows * 112, metadata.orderedIndexBytes * 2),
  );
  if (!Number.isSafeInteger(indexEstimateBytes * 5 + 10 * GiB))
    throw new Error('MULTIBOT_PREPARE_STORAGE_METADATA_UNKNOWN');
  const budgets = {
    // The online-only nullable semantic column remains NULL for old writers. Its IS NOT
    // NULL index starts empty; the replay fence also requires a non-NULL semantic key.
    // Reserve a visible 1 GiB allowance per partial index, separately from the full index.
    data: indexEstimateBytes + 2 * GiB,
    temp: indexEstimateBytes * 2,
    wal: Math.max(indexEstimateBytes * 2, metadata.maxWalBytes * 2),
    docker: 0,
  };
  const devices = new Map();
  for (const kind of ['data', 'temp', 'wal', 'docker']) {
    const filesystem = filesystems[kind];
    if (
      !filesystem?.device ||
      !filesystem.mount ||
      !Number.isSafeInteger(filesystem.availableBytes) ||
      filesystem.availableBytes < 0
    )
      throw new Error('MULTIBOT_PREPARE_FILESYSTEM_UNKNOWN');
    let device = devices.get(filesystem.device);
    if (!device) {
      device = { ...filesystem, roles: [], requiredBytes: runtimeHeadroomBytes };
      devices.set(filesystem.device, device);
    }
    device.roles.push(kind);
    device.availableBytes = Math.min(device.availableBytes, filesystem.availableBytes);
    device.requiredBytes += budgets[kind];
    if (!Number.isSafeInteger(device.requiredBytes))
      throw new Error('MULTIBOT_PREPARE_STORAGE_METADATA_UNKNOWN');
  }
  return {
    code: 'MULTIBOT_PREPARE_CAPACITY',
    tableBytes: metadata.tableBytes,
    approxRows: metadata.approxRows,
    indexEstimateBytes,
    fullIndexes: 1,
    partialIndexes: 2,
    partialIndexAllowanceBytes: GiB,
    serializedIndexBuilds: true,
    devices: [...devices.values()].map((device) => ({
      ...device,
      sufficient: device.availableBytes >= device.requiredBytes,
    })),
  };
}

export function checkMultibotPrepareCapacity(composeArgs, run = execFileSync) {
  if (!Array.isArray(composeArgs) || !composeArgs.length || composeArgs.length % 2 !== 0)
    throw new Error('MULTIBOT_PREPARE_COMPOSE_ARGUMENTS_INVALID');
  // FLAG: Validate the complete global-option prefix before any probe. Preserve its
  // exact env/project scope; commands and mutation flags never belong in this prefix.
  const seen = new Set();
  for (let index = 0; index < composeArgs.length; index += 2) {
    const option = composeArgs[index];
    const value = composeArgs[index + 1];
    const canonicalOption = option === '--project-name' ? '-p' : option;
    if (
      !['-f', '--env-file', '-p'].includes(canonicalOption) ||
      typeof value !== 'string' ||
      !value.trim() ||
      value.startsWith('-') ||
      /\p{Cc}/u.test(value) ||
      (canonicalOption !== '-f' && seen.has(canonicalOption)) ||
      (canonicalOption === '-p' && !/^[a-z0-9][a-z0-9_-]*$/u.test(value))
    )
      throw new Error('MULTIBOT_PREPARE_COMPOSE_ARGUMENTS_INVALID');
    seen.add(canonicalOption);
  }
  if (!seen.has('-f')) throw new Error('MULTIBOT_PREPARE_COMPOSE_ARGUMENTS_INVALID');
  const options = { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 };
  const pgCommand = ['compose', ...composeArgs, 'exec', '-T', 'postgres'];
  const catalog = run(
    'docker',
    [...pgCommand, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'maxim', '-d', 'maxim', '-Atq'],
    { ...options, input: catalogSql },
  );
  const metadata = JSON.parse(catalog.trim());
  if (!metadata.dataDirectory?.startsWith('/'))
    throw new Error('MULTIBOT_PREPARE_DATA_DIRECTORY_UNKNOWN');
  const walPath = run(
    'docker',
    [...pgCommand, 'sh', '-c', 'readlink -f "$1/pg_wal"', 'multibot-wal', metadata.dataDirectory],
    options,
  ).trim();
  if (!walPath.startsWith('/')) throw new Error('MULTIBOT_PREPARE_WAL_DIRECTORY_UNKNOWN');
  const pgFilesystem = (path) =>
    parseCapacityFilesystem(run('docker', [...pgCommand, 'df', '-Pk', path], options));
  const data = pgFilesystem(metadata.dataDirectory);
  const wal = pgFilesystem(walPath);
  const docker = parseCapacityFilesystem(run('df', ['-Pk', '/var/lib/docker'], options));
  return assessMultibotPrepareCapacity(metadata, { data, temp: data, wal, docker });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const report = checkMultibotPrepareCapacity(process.argv.slice(2));
    console.log(JSON.stringify(report));
    if (report.devices.some((device) => !device.sufficient)) {
      console.error('MULTIBOT_PREPARE_CAPACITY_INSUFFICIENT; old API roles remain live.');
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(
      `${error.message.startsWith('MULTIBOT_') ? error.message : 'MULTIBOT_PREPARE_CAPACITY_PROBE_FAILED'}; old API roles remain live.`,
    );
    process.exitCode = 1;
  }
}
