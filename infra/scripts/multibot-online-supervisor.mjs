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
import {
  createMultibotRuntimeGuard,
  readMultibotRuntimePressure,
} from './multibot-runtime-pressure.mjs';
import { createMultibotOnlineClientLauncher } from './multibot-online-client.mjs';

const commandOptions = { encoding: 'utf8', timeout: 3_000, maxBuffer: 1024 * 1024 };
const intervalMs = 2_000;
const deadlineMs = 5_700_000;
const runtimeIntervalMs = 10_000;
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
  'MULTIBOT_PREPARE_RUNTIME_UNAVAILABLE',
  'MULTIBOT_PREPARE_RUNTIME_INVALID',
  'MULTIBOT_PREPARE_RUNTIME_STALE',
  'MULTIBOT_PREPARE_RUNTIME_NOT_READY',
  'MULTIBOT_PREPARE_RUNTIME_CLOCK_INVALID',
  'MULTIBOT_PREPARE_RUNTIME_ADMISSION_BLOCKED',
  'MULTIBOT_PREPARE_RUNTIME_FINAL_BLOCKED',
  'MULTIBOT_PREPARE_RUNTIME_QUEUE_LAG',
  'MULTIBOT_PREPARE_CLIENT_SOURCE_SHA_INVALID',
  'MULTIBOT_PREPARE_CLIENT_CONFIGURATION_INVALID',
  'MULTIBOT_PREPARE_CLIENT_DATABASE_SCOPE_INVALID',
  'MULTIBOT_PREPARE_CLIENT_IMAGE_INVALID',
  'MULTIBOT_PREPARE_CLIENT_NETWORK_INVALID',
  'MULTIBOT_PREPARE_CLIENT_NETWORK_CHANGED',
  'MULTIBOT_PREPARE_CLIENT_IDENTITY_INVALID',
  'MULTIBOT_PREPARE_CLIENT_ALREADY_PREPARED',
  'MULTIBOT_PREPARE_CLIENT_START_WITHOUT_PREPARATION',
  'MULTIBOT_PREPARE_CLIENT_COMMAND_FAILED',
  'MULTIBOT_PREPARE_CLIENT_METADATA_INVALID',
  'MULTIBOT_PREPARE_CLIENT_CREATE_UNCONFIRMED',
]);

export function multibotSupervisorFailureCode(error) {
  return failureCodes.has(error?.message) ? error.message : 'MULTIBOT_PREPARE_SUPERVISOR_FAILED';
}

// FLAG: An SSH output pipe can close without delivering a terminal signal. Route
// its error through the same owned cleanup instead of an unhandled stream exit.
export function installMultibotOutputFence({
  signals = process,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const interrupt = () => signals.emit('SIGHUP');
  stdout.on('error', interrupt);
  stderr.on('error', interrupt);
  return () => {
    stdout.off('error', interrupt);
    stderr.off('error', interrupt);
  };
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
    // FLAG: An exited/created client can still be the target of a queued start.
    // Remove this exact UUID before accepting absence; never touch a service container.
    await run('docker', ['rm', '--force', containerName], {
      ...commandOptions,
      timeout: 5_000,
    });
  } catch {
    /* --rm clients may already be gone. Exact absence below is mandatory. */
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
      if (sessions.stdout.trim() === '0' && rows.length === 0) return;
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
    checkRuntime = readMultibotRuntimePressure,
    prepare,
    createLauncher = createMultibotOnlineClientLauncher,
    onAttempt = () => {},
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
  let preparationUnconfirmed = false;
  const startedAt = now();
  const runtimeGuard = createMultibotRuntimeGuard({ now });
  let nextRuntimeAtMs;
  const requireActive = () => {
    if (interrupted) throw new Error('MULTIBOT_PREPARE_INTERRUPTED');
    if (now() - startedAt >= deadlineMs) throw new Error('MULTIBOT_PREPARE_DEADLINE_EXHAUSTED');
  };
  try {
    onAttempt({
      phase: 'admission',
      attemptName: applicationName,
      startedAt: new Date(startedAt).toISOString(),
    });
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
    runtimeGuard.admit(await checkRuntime());
    requireActive();
    nextRuntimeAtMs = now() + runtimeIntervalMs;
    // FLAG: Production defaults use an awaited minimal named client. Injected
    // launchers retain their command contract for isolated lifecycle tests.
    const defaultLauncher =
      start === spawn && prepare === undefined ? await createLauncher(composeArgs) : null;
    requireActive();
    attempted = true;
    preparationUnconfirmed = true;
    await (defaultLauncher?.prepare ?? prepare ?? (async () => {}))(applicationName);
    preparationUnconfirmed = false;
    requireActive();
    // FLAG: Preparation may spend time creating a client. Its earlier health/capacity
    // observation cannot authorize a later heavy statement.
    requireReserve({ devices: await readFilesystems(composeArgs, initial) });
    requireActive();
    runtimeGuard.admit(await checkRuntime());
    requireActive();
    nextRuntimeAtMs = now() + runtimeIntervalMs;
    child = defaultLauncher
      ? defaultLauncher.start(applicationName)
      : start(
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
      // FLAG: Disk headroom never grants permission to starve live work. Fresh local
      // readiness samples have their own bounded cadence and abort only this owned attempt.
      if (now() >= nextRuntimeAtMs) {
        runtimeGuard.observe(await checkRuntime());
        requireActive();
        nextRuntimeAtMs = now() + runtimeIntervalMs;
      }
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
    runtimeGuard.finish(await checkRuntime());
    requireActive();
    return final;
  } catch (error) {
    if (attempted) await stop(composeArgs, child, applicationName, applicationName);
    if (preparationUnconfirmed) throw new Error('MULTIBOT_PREPARE_CLEANUP_UNCONFIRMED');
    throw new Error(multibotSupervisorFailureCode(error));
  } finally {
    for (const signal of interruptionSignals) signals.off(signal, interrupt);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  installMultibotOutputFence();
  try {
    await superviseMultibotOnlinePrepare(process.argv.slice(2), {
      onAttempt: (attempt) =>
        console.log(
          JSON.stringify({
            stage: 'multibot_prepare_attempt',
            ...attempt,
            sourceSha: /^[a-f0-9]{40}$/u.test(process.env.MAXIM_EXPECTED_DEPLOY_SHA ?? '')
              ? process.env.MAXIM_EXPECTED_DEPLOY_SHA
              : null,
          }),
        ),
    });
    console.log('Supervised online multibot preparation completed with a 10 GiB reserve.');
  } catch (error) {
    console.error(
      `${multibotSupervisorFailureCode(error)}; old API roles remain live; migration receipts preserved.`,
    );
    process.exitCode = 1;
  }
}
