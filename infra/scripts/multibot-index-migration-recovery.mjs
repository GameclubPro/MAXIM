import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  MIGRATION,
  ADDITIVE_MIGRATION,
  SEMANTIC_ORDER_MIGRATION,
  indexes,
  migrationChecksums,
  recoveryAuditSql,
  recoveryIndexSql,
  verifyRecoveryState,
} from './multibot-index-recovery-schema.mjs';
import {
  checkMultibotPrepareCapacity,
  MULTIBOT_PREPARE_MINIMUM_FREE_BYTES,
  validateMultibotComposeArgs,
} from './multibot-prepare-capacity.mjs';
import {
  readMultibotMigrationFilesystems,
  stopOwnedMigration,
  waitForMultibotTick,
} from './multibot-online-supervisor.mjs';

export const recoveryApplicationPattern =
  /^maxim-online-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export async function recoverMultibotIndexes(operations, apply) {
  const read = async () =>
    verifyRecoveryState(
      await operations.read(),
      operations.checksum,
      operations.additiveChecksum,
      operations.semanticOrderChecksum,
    );
  let state = await read();
  const summary = () => ({
    actions: state.actions,
    recordState: state.recordState,
    applied: false,
  });
  if (!apply || state.recordState === 'applied') return summary();
  const identity = state.recordIdentity;
  const assertSame = (current) => {
    if (current.recordIdentity !== identity) throw new Error('MULTIBOT_RECOVERY_RECEIPT_CHANGED');
  };
  for (const initial of state.actions) {
    await operations.assertHealthy();
    state = await read();
    assertSame(state);
    const current = state.actions.find(({ name }) => name === initial.name);
    if (current.action !== initial.action) throw new Error('MULTIBOT_RECOVERY_INDEX_CHANGED');
    if (current.action !== 'ready') {
      await operations.repair(current.name, current.action);
      state = await read();
      assertSame(state);
      if (state.actions.find(({ name }) => name === current.name).action !== 'ready')
        throw new Error('MULTIBOT_RECOVERY_INDEX_NOT_READY');
    }
  }
  await operations.assertHealthy();
  state = await read();
  assertSame(state);
  if (state.actions.some(({ action }) => action !== 'ready'))
    throw new Error('MULTIBOT_RECOVERY_INDEX_NOT_READY');
  await operations.resolve();
  state = await read();
  if (state.recordState !== 'applied') throw new Error('MULTIBOT_RECOVERY_RESOLUTION_UNCONFIRMED');
  return { ...summary(), applied: true };
}

function requireReserve(filesystems) {
  if (
    !Array.isArray(filesystems) ||
    !filesystems.length ||
    filesystems.some(
      (filesystem) =>
        !Number.isSafeInteger(filesystem.availableBytes) ||
        filesystem.availableBytes < MULTIBOT_PREPARE_MINIMUM_FREE_BYTES,
    )
  )
    throw new Error('MULTIBOT_RECOVERY_RESERVE_EXHAUSTED');
}

// FLAG: One fixed concurrent statement at a time; a lost sample, signal, device or
// reserve aborts only this UUID-owned operation. Failed receipts remain untouched.
export async function superviseMultibotIndexRepair(
  composeArgs,
  applicationName,
  args,
  query,
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
  if (!recoveryApplicationPattern.test(applicationName))
    throw new Error('MULTIBOT_RECOVERY_APPLICATION_INVALID');
  if (
    JSON.stringify(args) !==
      JSON.stringify(multibotRecoverySqlArgs(composeArgs, applicationName, true)) ||
    !Object.keys(indexes).some((name) =>
      ['create', 'reindex'].some((action) => query === recoveryIndexSql(name, action)),
    )
  )
    throw new Error('MULTIBOT_RECOVERY_OPERATION_INVALID');
  let interrupted = false;
  const interrupt = () => {
    interrupted = true;
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) signals.on(signal, interrupt);
  const startedAt = now();
  const requireActive = () => {
    if (interrupted) throw new Error('MULTIBOT_RECOVERY_INTERRUPTED');
    if (now() - startedAt >= 1_840_000) throw new Error('MULTIBOT_RECOVERY_DEADLINE_EXHAUSTED');
  };
  let child;
  let attempted = false;
  try {
    const initial = await checkCapacity(composeArgs);
    requireReserve(initial?.devices);
    requireActive();
    attempted = true;
    child = start('docker', args, { stdio: ['pipe', 'ignore', 'ignore'] });
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
      child.stdin.on('error', () => {});
      child.stdin.end(query);
    });
    while (!result) {
      await waitForTick(done, 2_000);
      requireActive();
      if (result) break;
      requireReserve(await readFilesystems(composeArgs, initial));
      requireActive();
    }
    requireActive();
    if (result.error || result.signal || result.code !== 0)
      throw new Error('MULTIBOT_RECOVERY_INDEX_COMMAND_FAILED');
    // The final device/reserve sample is bounded and parallel; do not start a second
    // series of synchronous catalog probes after the long statement has completed.
    requireReserve(await readFilesystems(composeArgs, initial));
    requireActive();
  } catch (error) {
    if (attempted) await stop(composeArgs, child, applicationName, applicationName);
    throw error;
  } finally {
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) signals.off(signal, interrupt);
  }
}

export function multibotRecoverySqlArgs(composeArgs, appName, mutate = false) {
  validateMultibotComposeArgs(composeArgs);
  if (!recoveryApplicationPattern.test(appName))
    throw new Error('MULTIBOT_RECOVERY_APPLICATION_INVALID');
  return [
    'compose',
    ...composeArgs,
    'exec',
    '-T',
    '-e',
    `PGAPPNAME=${appName}`,
    '-e',
    `PGOPTIONS=-c statement_timeout=${mutate ? '1800s' : '2500ms'} -c lock_timeout=${mutate ? '5s' : '250ms'} -c default_transaction_read_only=${mutate ? 'off' : 'on'} -c idle_in_transaction_session_timeout=4s -c max_parallel_workers_per_gather=0 -c max_parallel_maintenance_workers=0 -c maintenance_work_mem=64MB -c temp_file_limit=${mutate ? '10GB' : '8MB'} -c work_mem=1MB -c search_path=pg_catalog,public`,
    'postgres',
    'psql',
    '-X',
    '-v',
    'ON_ERROR_STOP=1',
    '-v',
    'VERBOSITY=sqlstate',
    '-A',
    '-t',
    '-q',
    '-U',
    'maxim',
    '-d',
    'maxim',
  ];
}

export function multibotRecoveryResolveArgs(composeArgs, appName, rootDir) {
  validateMultibotComposeArgs(composeArgs);
  if (!recoveryApplicationPattern.test(appName))
    throw new Error('MULTIBOT_RECOVERY_APPLICATION_INVALID');
  return [
    'compose',
    ...composeArgs,
    '-f',
    'infra/docker-compose.runtime-no-build.yml',
    'run',
    '--rm',
    '--no-deps',
    '--pull',
    'never',
    '--name',
    appName,
    '--label',
    `com.maxim.multibot-index-recovery=${appName}`,
    '--volume',
    `${rootDir}/apps/api/prisma/migrations:/app/apps/api/prisma/migrations:ro`,
    '--volume',
    `${rootDir}/scripts/agent/multibot-online-prepare.mjs:/app/scripts/agent/multibot-online-prepare.mjs:ro`,
    '--volume',
    `${rootDir}/infra/scripts/multibot-index-resolve.mjs:/app/infra/scripts/multibot-index-resolve.mjs:ro`,
    '-e',
    `MAXIM_MULTIBOT_PREPARE_APPLICATION_NAME=${appName}`,
    'api-ingress',
    'node',
    'infra/scripts/multibot-index-resolve.mjs',
  ];
}

function command(binary, args, options = {}) {
  const result = spawnSync(binary, args, {
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 128 * 1024,
    ...options,
  });
  if (result.error || result.status !== 0) throw new Error('MULTIBOT_RECOVERY_COMMAND_FAILED');
  return result.stdout.trim();
}

export function summarizeMultibotRecoveryCatalog(report) {
  const records = Array.isArray(report?.metadata?.records) ? report.metadata.records : [];
  const families = new Set(['lock_timeout', 'statement_timeout', 'other', 'oversized']);
  return {
    migration: MIGRATION,
    tableBytes:
      Number.isSafeInteger(report?.table_bytes) && report.table_bytes >= 0
        ? report.table_bytes
        : null,
    activeOwnedSessions:
      typeof report?.active_owned_sessions === 'boolean' ? report.active_owned_sessions : null,
    repairArtifacts: typeof report?.repair_artifacts === 'boolean' ? report.repair_artifacts : null,
    otherFailed:
      typeof report?.metadata?.other_failed === 'boolean' ? report.metadata.other_failed : null,
    targetReceiptCount: records.length,
    targetChecksumMatches:
      records.length === 1 && records[0]?.checksum === migrationChecksums[MIGRATION],
    failureFamily:
      records.length === 1 && families.has(records[0]?.failure) ? records[0].failure : 'unknown',
    indexes: Object.keys(indexes).map((name) => {
      const matching = Array.isArray(report?.indexes)
        ? report.indexes.filter((index) => index?.name === name)
        : [];
      const index = matching.length === 1 ? matching[0] : null;
      return {
        name,
        present: typeof index?.present === 'boolean' ? index.present : null,
        valid: typeof index?.valid === 'boolean' ? index.valid : null,
        ready: typeof index?.ready === 'boolean' ? index.ready : null,
      };
    }),
  };
}

async function main() {
  if (
    process.argv.length > 3 ||
    (process.argv[2] && !['--apply', '--cleanup'].includes(process.argv[2]))
  )
    throw new Error('MULTIBOT_RECOVERY_ARGUMENTS_INVALID');
  const appName = process.env.MAXIM_MULTIBOT_INDEX_RECOVERY_APP_NAME;
  if (!recoveryApplicationPattern.test(appName ?? ''))
    throw new Error('MULTIBOT_RECOVERY_APPLICATION_INVALID');
  const compose = ['--env-file', '.env', '-p', 'infra', '-f', 'infra/docker-compose.yml'];
  if (process.argv[2] === '--cleanup') {
    await stopOwnedMigration(compose, undefined, appName, appName);
    return;
  }
  const sha = command('git', ['rev-parse', 'HEAD']);
  if (!/^[a-f0-9]{40}$/u.test(sha) || process.env.MAXIM_EXPECTED_DEPLOY_SHA !== sha)
    throw new Error('MULTIBOT_RECOVERY_SOURCE_IDENTITY_INVALID');
  command('git', [
    'diff',
    '--quiet',
    'HEAD',
    '--',
    'infra',
    'apps/api/prisma/migrations',
    'scripts/agent/multibot-online-prepare.mjs',
  ]);
  for (const file of [
    'multibot-index-migration-recovery.mjs',
    'multibot-index-recovery-schema.mjs',
    'multibot-index-resolve.mjs',
    'vps-recover-multibot-index-migration.sh',
  ])
    command('git', ['cat-file', '-e', `HEAD:infra/scripts/${file}`]);
  const checksum = (migration) =>
    createHash('sha256')
      .update(readFileSync(`apps/api/prisma/migrations/${migration}/migration.sql`))
      .digest('hex');
  const read = () =>
    JSON.parse(
      command('docker', multibotRecoverySqlArgs(compose, appName), { input: recoveryAuditSql }),
    );
  const assertHealthy = () => {
    for (const port of [3001, 3002]) {
      const health = JSON.parse(
        command('curl', ['-fsS', '--max-time', '10', `http://127.0.0.1:${port}/api/health/ready`]),
      );
      if (
        health.ok !== true ||
        health.checks?.queueLag?.rawOk !== true ||
        health.systemMode?.mode !== 'normal'
      )
        throw new Error('MULTIBOT_RECOVERY_RUNTIME_NOT_HEALTHY');
    }
  };
  process.stdout.write(`${JSON.stringify(summarizeMultibotRecoveryCatalog(read()))}\n`);
  const result = await recoverMultibotIndexes(
    {
      checksum: checksum(MIGRATION),
      additiveChecksum: checksum(ADDITIVE_MIGRATION),
      semanticOrderChecksum: checksum(SEMANTIC_ORDER_MIGRATION),
      read,
      assertHealthy,
      repair: async (name, action) => {
        process.stdout.write(`${action}: ${name}\n`);
        await superviseMultibotIndexRepair(
          compose,
          appName,
          multibotRecoverySqlArgs(compose, appName, true),
          recoveryIndexSql(name, action),
        );
      },
      resolve: async () => {
        const container = command('docker', ['compose', ...compose, 'ps', '-q', 'api-ingress']);
        if (!/^[a-f0-9]{12,64}$/u.test(container))
          throw new Error('MULTIBOT_RECOVERY_IMAGE_INVALID');
        const image = command('docker', ['inspect', '--format', '{{.Config.Image}}', container]);
        if (
          !/^maxim-api:[a-f0-9]{40}$/u.test(image) ||
          command('docker', [
            'image',
            'inspect',
            '--format',
            '{{index .Config.Labels "org.opencontainers.image.revision"}}|{{index .Config.Labels "com.maxim.release-protected"}}',
            image,
          ]) !== `${image.slice('maxim-api:'.length)}|true` ||
          command('docker', ['inspect', '--format', '{{.Image}}', container]) !==
            command('docker', ['image', 'inspect', '--format', '{{.Id}}', image])
        )
          throw new Error('MULTIBOT_RECOVERY_IMAGE_INVALID');
        try {
          command('docker', multibotRecoveryResolveArgs(compose, appName, process.cwd()), {
            timeout: 120_000,
            env: { ...process.env, MAXIM_MIGRATION_API_IMAGE: image },
          });
        } catch (error) {
          await stopOwnedMigration(compose, undefined, appName, appName);
          throw error;
        }
      },
    },
    process.argv[2] === '--apply',
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    process.stderr.write(
      `${error.message.startsWith('MULTIBOT_') ? error.message : 'MULTIBOT_RECOVERY_STATE_REJECTED'}; runtime unchanged; migration state requires a fresh preview.\n`,
    );
    process.exitCode = 1;
  });
