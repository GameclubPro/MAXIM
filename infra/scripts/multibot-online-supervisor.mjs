#!/usr/bin/env node

import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import {
  checkMultibotPrepareCapacity,
  MULTIBOT_PREPARE_MINIMUM_FREE_BYTES,
  parseCapacityFilesystem,
  validateMultibotComposeArgs,
} from './multibot-prepare-capacity.mjs';

const commandOptions = { encoding: 'utf8', timeout: 3_000, maxBuffer: 1024 * 1024 };
const intervalMs = 2_000;
const deadlineMs = 5_700_000;
const interruptionSignals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const ownedNamePattern =
  /^maxim-online-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const failureCodes = new Set([
  'MULTIBOT_PREPARE_COMPOSE_ARGUMENTS_INVALID',
  'MULTIBOT_PREPARE_CAPACITY_INSUFFICIENT',
  'MULTIBOT_PREPARE_CLEANUP_IDENTITY_INVALID',
  'MULTIBOT_PREPARE_CLEANUP_UNCONFIRMED',
  'MULTIBOT_PREPARE_INTERRUPTED',
  'MULTIBOT_PREPARE_DEADLINE_EXHAUSTED',
  'MULTIBOT_PREPARE_PRISMA_DEPLOY_FAILED',
  'MULTIBOT_PREPARE_MONITOR_PATHS_UNKNOWN',
  'MULTIBOT_PREPARE_MONITOR_UNAVAILABLE',
  'MULTIBOT_PREPARE_STORAGE_DEVICE_CHANGED',
  'MULTIBOT_PREPARE_RESERVE_EXHAUSTED',
]);

export function multibotSupervisorFailureCode(error) {
  return failureCodes.has(error?.message) ? error.message : 'MULTIBOT_PREPARE_SUPERVISOR_FAILED';
}

// execFile has no input option: explicitly close stdin so psql cannot wait for EOF.
export function runMultibotSupervisorCommand(command, args, { input, ...options } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      { ...commandOptions, ...options, killSignal: 'SIGKILL' },
      (error, stdout, stderr) => (error ? reject(error) : resolve({ stdout, stderr })),
    );
    child.stdin.on('error', () => {}); // Early exit/EPIPE is handled by execFile's result.
    child.stdin.end(input);
  });
}

const ownedSessionPredicate = `datname = current_database() AND usename = current_user
  AND backend_type = 'client backend'
  AND application_name = :'owned_application_name' AND pid <> pg_backend_pid()`;
const ownedQuery = (select) => `BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '2s';
SET LOCAL max_parallel_workers_per_gather = 0;
${select};
COMMIT;`;
export const cancelOwnedMigrationSql = ownedQuery(
  `SELECT pg_cancel_backend(pid) FROM pg_catalog.pg_stat_activity WHERE ${ownedSessionPredicate}`,
);
export const terminateOwnedMigrationSql = ownedQuery(
  `SELECT pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity WHERE ${ownedSessionPredicate}`,
);
export const countOwnedMigrationSql = ownedQuery(
  `SELECT count(*) FROM pg_catalog.pg_stat_activity WHERE ${ownedSessionPredicate}`,
);

export async function readMultibotMigrationFilesystems(
  composeArgs,
  initial,
  run = runMultibotSupervisorCommand,
) {
  validateMultibotComposeArgs(composeArgs);
  const paths = initial.monitorPaths;
  if (
    !paths?.data?.startsWith('/') ||
    !paths.wal?.startsWith('/') ||
    paths.docker !== '/var/lib/docker'
  )
    throw new Error('MULTIBOT_PREPARE_MONITOR_PATHS_UNKNOWN');
  const pgCommand = ['compose', ...composeArgs, 'exec', '-T', 'postgres', 'df', '-Pk'];
  const results = await Promise.allSettled([
    run('docker', [...pgCommand, paths.data], commandOptions),
    run('docker', [...pgCommand, paths.wal], commandOptions),
    run('df', ['-Pk', paths.docker], commandOptions),
  ]);
  if (results.some((result) => result.status !== 'fulfilled'))
    throw new Error('MULTIBOT_PREPARE_MONITOR_UNAVAILABLE');
  let current;
  try {
    const [data, wal, docker] = results.map((result) =>
      parseCapacityFilesystem(result.value.stdout),
    );
    current = { data, temp: data, wal, docker };
  } catch {
    throw new Error('MULTIBOT_PREPARE_MONITOR_UNAVAILABLE');
  }
  for (const device of initial.devices)
    for (const role of device.roles)
      if (current[role]?.device !== device.device)
        throw new Error('MULTIBOT_PREPARE_STORAGE_DEVICE_CHANGED');
  return Object.values(current);
}

export async function stopOwnedMigration(
  composeArgs,
  child,
  applicationName,
  containerName,
  { run = runMultibotSupervisorCommand, wait = delay } = {},
) {
  validateMultibotComposeArgs(composeArgs);
  if (!ownedNamePattern.test(applicationName) || containerName !== applicationName)
    throw new Error('MULTIBOT_PREPARE_CLEANUP_IDENTITY_INVALID');
  const queryArgs = [
    'compose',
    ...composeArgs,
    'exec',
    '-T',
    'postgres',
    'psql',
    '-X',
    '-v',
    'ON_ERROR_STOP=1',
    '-v',
    `owned_application_name=${applicationName}`,
    '-U',
    'maxim',
    '-d',
    'maxim',
    '-Atq',
  ];
  // FLAG: Cancel only this attempt's exact UUID-tagged DB sessions and one-off container.
  // Never stop a production role, clear a migration receipt, resolve it or retry its SQL.
  // Kill the launcher before checking absence: it must not create/reconnect after cleanup.
  child?.kill('SIGKILL');
  try {
    await run('docker', queryArgs, { ...commandOptions, input: cancelOwnedMigrationSql });
  } catch {
    /* Termination and verified absence below remain mandatory. */
  }
  try {
    await run('docker', ['stop', '--time', '3', containerName], {
      ...commandOptions,
      timeout: 5_000,
    });
  } catch {
    /* A failed launcher may never have created the container. Verify below. */
  }
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await run('docker', queryArgs, { ...commandOptions, input: terminateOwnedMigrationSql });
      await wait(100);
      const sessions = await run('docker', queryArgs, {
        ...commandOptions,
        input: countOwnedMigrationSql,
      });
      const containers = await run(
        'docker',
        [
          'container',
          'ls',
          '--all',
          '--filter',
          `name=^/${containerName}$`,
          '--format',
          '{{.Names}} {{.State}}',
        ],
        commandOptions,
      );
      const rows = containers.stdout.trim().split('\n').filter(Boolean);
      const containerStopped =
        rows.length === 0 || (rows.length === 1 && rows[0] === `${containerName} exited`);
      if (sessions.stdout.trim() === '0' && containerStopped) return;
    }
  } catch {
    /* Unknown state must be reported as unconfirmed cleanup. */
  }
  throw new Error('MULTIBOT_PREPARE_CLEANUP_UNCONFIRMED');
}

export async function waitForMultibotTick(done, ms) {
  let timer;
  try {
    await Promise.race([
      done,
      new Promise((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function requireReserve(report) {
  if (
    !report?.devices?.length ||
    report.devices.some(
      (device) =>
        !Number.isSafeInteger(device.availableBytes) ||
        device.availableBytes < MULTIBOT_PREPARE_MINIMUM_FREE_BYTES,
    )
  )
    throw new Error('MULTIBOT_PREPARE_RESERVE_EXHAUSTED');
}

export async function superviseMultibotOnlinePrepare(
  composeArgs,
  {
    checkCapacity = checkMultibotPrepareCapacity,
    readFilesystems = readMultibotMigrationFilesystems,
    start = spawn,
    stop = stopOwnedMigration,
    waitForTick = waitForMultibotTick,
    now = Date.now,
    signals = process,
  } = {},
) {
  validateMultibotComposeArgs(composeArgs);
  let interrupted = false;
  const interrupt = () => {
    interrupted = true;
  };
  for (const signal of interruptionSignals) signals.on(signal, interrupt);
  const applicationName = `maxim-online-${randomUUID()}`;
  let child;
  let attempted = false;
  const startedAt = now();
  const requireActive = () => {
    if (interrupted) throw new Error('MULTIBOT_PREPARE_INTERRUPTED');
    if (now() - startedAt >= deadlineMs) throw new Error('MULTIBOT_PREPARE_DEADLINE_EXHAUSTED');
  };
  try {
    const initial = await checkCapacity(composeArgs);
    requireActive();
    if (
      !initial?.devices?.length ||
      initial.devices.some(
        (device) =>
          !Number.isSafeInteger(device.availableBytes) ||
          device.availableBytes < MULTIBOT_PREPARE_MINIMUM_FREE_BYTES,
      )
    )
      throw new Error('MULTIBOT_PREPARE_CAPACITY_INSUFFICIENT');
    attempted = true;
    child = start(
      'docker',
      [
        'compose',
        ...composeArgs,
        'run',
        '--rm',
        '--no-deps',
        '--pull',
        'never',
        '--name',
        applicationName,
        '-e',
        `MAXIM_MULTIBOT_PREPARE_APPLICATION_NAME=${applicationName}`,
        'api-ingress',
        'node',
        'scripts/agent/multibot-online-prepare.mjs',
      ],
      { stdio: 'inherit' },
    );
    let result;
    const done = new Promise((resolve) => {
      const finish = (value) => {
        if (!result) {
          result = value;
          resolve();
        }
      };
      child.once('error', () => finish({ error: true }));
      child.once('exit', (code, signal) => finish({ code, signal }));
    });
    // FLAG: The 10 GiB admission replaces the estimated peak only with live supervision.
    // Samples never overlap; any lost sample, device drift, deadline or signal aborts this attempt.
    while (!result) {
      await waitForTick(done, intervalMs);
      requireActive();
      if (result) break;
      const filesystems = await readFilesystems(composeArgs, initial);
      requireActive();
      if (
        !filesystems.length ||
        filesystems.some(
          (filesystem) =>
            !Number.isSafeInteger(filesystem.availableBytes) ||
            filesystem.availableBytes < MULTIBOT_PREPARE_MINIMUM_FREE_BYTES,
        )
      )
        throw new Error('MULTIBOT_PREPARE_RESERVE_EXHAUSTED');
    }
    requireActive();
    if (result.error || result.signal || result.code !== 0)
      throw new Error('MULTIBOT_PREPARE_PRISMA_DEPLOY_FAILED');
    const final = await checkCapacity(composeArgs);
    requireActive();
    requireReserve(final);
    // Reuse the same device attestation after success, before releasing the rollout.
    requireReserve({ devices: await readFilesystems(composeArgs, initial) });
    requireActive();
    return final;
  } catch (error) {
    if (attempted) await stop(composeArgs, child, applicationName, applicationName);
    throw new Error(multibotSupervisorFailureCode(error));
  } finally {
    for (const signal of interruptionSignals) signals.off(signal, interrupt);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    await superviseMultibotOnlinePrepare(process.argv.slice(2));
    console.log('Supervised online multibot preparation completed with a 10 GiB reserve.');
  } catch (error) {
    console.error(
      `${multibotSupervisorFailureCode(error)}; old API roles remain live; migration receipts preserved.`,
    );
    process.exitCode = 1;
  }
}
