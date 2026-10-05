import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { PRODUCTION_API_SERVICES } from './release-rollback-plan.mjs';
import { listRecoveryBaseManifestPaths, readRecoveryBaseManifest } from './release-manifest.mjs';
import {
  recoverMultibotPreparation,
  MULTIBOT_PREPARATION_RECOVERY_MIGRATION,
} from './multibot-preparation-recovery-state.mjs';
import { multibotPreparationChecksums } from './multibot-prepare-diagnostics.mjs';
import {
  readMultibotRuntimePressure,
  createMultibotRuntimeGuard,
} from './multibot-runtime-pressure.mjs';
import {
  runMultibotSupervisorCommand,
  superviseMultibotOnlinePrepare,
  installMultibotOutputFence,
} from './multibot-online-supervisor.mjs';

const shaPattern = /^[a-f0-9]{40}$/u;
const digestPattern = /^[a-f0-9]{64}$/u;
const tagPattern =
  /^maxim-online-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const fail = (code) => {
  throw new Error(`MULTIBOT_RECOVERY_${code}`);
};
const hash = (value) => createHash('sha256').update(value).digest('hex');
const compose = [
  '--env-file',
  '.env',
  '-p',
  'infra',
  '-f',
  'infra/docker-compose.yml',
  '-f',
  'infra/docker-compose.runtime-no-build.yml',
];

export function parseMultibotRecoveryArgs(args) {
  const allowed = new Set([
    '--cancelled-source',
    '--baseline-source',
    '--attempt-name',
    '--attempt-start',
    '--attempt-abort',
    '--receipt-sha',
    '--journal-sha',
  ]);
  const parsed = { apply: false };
  for (let i = 0; i < args.length; i += 1) {
    const key = args[i];
    if (key === '--apply') {
      if (parsed.apply) fail('ARGUMENTS_INVALID');
      parsed.apply = true;
    } else {
      if (
        !allowed.has(key) ||
        parsed[key] !== undefined ||
        !args[i + 1] ||
        args[i + 1].startsWith('--')
      )
        fail('ARGUMENTS_INVALID');
      parsed[key] = args[++i];
    }
  }
  if (
    !shaPattern.test(parsed['--cancelled-source'] ?? '') ||
    !shaPattern.test(parsed['--baseline-source'] ?? '') ||
    !tagPattern.test(parsed['--attempt-name'] ?? '')
  )
    fail('ARGUMENTS_INVALID');
  for (const key of ['--attempt-start', '--attempt-abort']) {
    const value = parsed[key];
    if (
      typeof value !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
      !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString() !== value
    )
      fail('ARGUMENTS_INVALID');
  }
  const started = Date.parse(parsed['--attempt-start']);
  const aborted = Date.parse(parsed['--attempt-abort']);
  if (started > aborted || aborted - started > 5_700_000 || aborted > Date.now())
    fail('ARGUMENTS_INVALID');
  for (const key of ['--receipt-sha', '--journal-sha']) {
    if ((parsed.apply || parsed[key] !== undefined) && !digestPattern.test(parsed[key] ?? ''))
      fail('ARGUMENTS_INVALID');
  }
  return parsed;
}

export function verifyMultibotBaselineContainers(containers, imageId) {
  if (!Array.isArray(containers) || !/^sha256:[a-f0-9]{64}$/u.test(imageId))
    fail('BASELINE_RUNTIME_INVALID');
  const relevant = containers.filter(
    (container) =>
      container.Config?.Labels?.['com.docker.compose.project'] === 'infra' &&
      PRODUCTION_API_SERVICES.includes(container.Config.Labels['com.docker.compose.service']),
  );
  if (relevant.length !== PRODUCTION_API_SERVICES.length) fail('BASELINE_RUNTIME_INVALID');
  for (const service of PRODUCTION_API_SERVICES) {
    const matches = relevant.filter(
      (container) => container.Config.Labels['com.docker.compose.service'] === service,
    );
    const container = matches[0];
    const env = Object.fromEntries(
      (container?.Config?.Env ?? [])
        .filter((entry) => /^APP_(ROLE|SERVICE_NAME)=/u.test(entry))
        .map((entry) => [entry.slice(0, entry.indexOf('=')), entry.slice(entry.indexOf('=') + 1)]),
    );
    const role =
      service.startsWith('api-moderation') || service === 'api-media-analysis'
        ? 'moderation'
        : service.slice(4);
    if (
      matches.length !== 1 ||
      container.Image !== imageId ||
      container.Name !== `/infra-${service}-1` ||
      container.State?.Status !== 'running' ||
      container.State.Health?.Status !== 'healthy' ||
      env.APP_SERVICE_NAME !== service ||
      env.APP_ROLE !== role
    )
      fail('BASELINE_RUNTIME_INVALID');
  }
  // FLAG: An unexpected MAXIM API container can process work outside the recorded fleet.
  for (const container of containers) {
    if (relevant.includes(container)) continue;
    if (
      (container.Config?.Env ?? []).some((entry) => /^APP_(ROLE|SERVICE_NAME)=/u.test(entry)) &&
      (container.Config?.Labels?.['com.maxim.release-protected'] === 'true' ||
        /^\/(?:infra|infra-scale)-api-/u.test(container.Name ?? ''))
    )
      fail('BASELINE_RUNTIME_INVALID');
  }
  return true;
}

export function verifyMultibotRecoveryClient(container, image, network) {
  const env = container?.Config?.Env;
  const bindings = container?.NetworkSettings?.Networks?.infra_default;
  if (
    container?.Name !== '/infra-postgres-1' ||
    container.State?.Status !== 'running' ||
    container.Config?.Image !== 'postgres:16-alpine' ||
    container.Config.Labels?.['com.docker.compose.project'] !== 'infra' ||
    container.Config.Labels?.['com.docker.compose.service'] !== 'postgres' ||
    !/^sha256:[a-f0-9]{64}$/u.test(container.Image ?? '') ||
    image?.Id !== container.Image ||
    network?.Name !== 'infra_default' ||
    network.Driver !== 'bridge' ||
    network.Scope !== 'local' ||
    network.Labels?.['com.docker.compose.project'] !== 'infra' ||
    network.Labels?.['com.docker.compose.network'] !== 'default' ||
    !/^[a-f0-9]{64}$/u.test(network.Id ?? '') ||
    bindings?.NetworkID !== network.Id ||
    !Array.isArray(bindings.Aliases) ||
    !bindings.Aliases.includes('postgres') ||
    !Array.isArray(env) ||
    !env.every((entry) => typeof entry === 'string')
  )
    fail('CLIENT_IDENTITY_INVALID');
  const value = (name) => {
    const matches = env.filter((entry) => entry.startsWith(`${name}=`));
    if (matches.length !== 1) fail('CLIENT_IDENTITY_INVALID');
    return matches[0].slice(name.length + 1);
  };
  const password = value('POSTGRES_PASSWORD');
  if (
    value('POSTGRES_USER') !== 'maxim' ||
    value('POSTGRES_DB') !== 'maxim' ||
    !password ||
    password.length > 4096 ||
    /[\0\r\n]/u.test(password)
  )
    fail('CLIENT_IDENTITY_INVALID');
  return { imageId: image.Id, networkId: network.Id, networkName: network.Name, password };
}

export function multibotRecoveryPsqlArgs(applicationName, client) {
  if (!tagPattern.test(applicationName)) fail('OWNED_IDENTITY_INVALID');
  if (
    !/^sha256:[a-f0-9]{64}$/u.test(client?.imageId ?? '') ||
    !/^[a-f0-9]{64}$/u.test(client?.networkId ?? '') ||
    client.networkName !== 'infra_default'
  )
    fail('CLIENT_IDENTITY_INVALID');
  return [
    'create',
    '--interactive',
    '--rm',
    '--pull',
    'never',
    '--name',
    applicationName,
    '--read-only',
    // FLAG: The server image declares PGDATA as a volume. Override it so a
    // short-lived psql client cannot create or leave an anonymous data volume.
    '--tmpfs',
    '/var/lib/postgresql/data:ro,noexec,nosuid,size=64k',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    '32',
    '--memory',
    '128m',
    '--cpus',
    '0.25',
    '--user',
    'postgres',
    '--network',
    client.networkId,
    '-e',
    'PGPASSWORD',
    '-e',
    'PGCONNECT_TIMEOUT=5',
    '-e',
    `PGAPPNAME=${applicationName}`,
    '-e',
    'PGOPTIONS=-c statement_timeout=3600s -c lock_timeout=5s -c idle_in_transaction_session_timeout=5s -c max_parallel_workers_per_gather=0 -c max_parallel_maintenance_workers=0 -c maintenance_work_mem=512MB -c temp_file_limit=6GB -c work_mem=1MB -c search_path=pg_catalog,public',
    '--entrypoint',
    'psql',
    client.imageId,
    '-X',
    '-v',
    'ON_ERROR_STOP=1',
    '-v',
    'VERBOSITY=sqlstate',
    '-A',
    '-t',
    '-h',
    'postgres',
    '-U',
    'maxim',
    '-d',
    'maxim',
  ];
}

export function multibotRecoveryResolverArgs(applicationName, client, sourceRoot) {
  if (!tagPattern.test(applicationName)) fail('OWNED_IDENTITY_INVALID');
  if (
    !/^sha256:[a-f0-9]{64}$/u.test(client?.imageId ?? '') ||
    !/^[a-f0-9]{64}$/u.test(client?.networkId ?? '') ||
    client.networkName !== 'infra_default' ||
    typeof sourceRoot !== 'string' ||
    !sourceRoot.startsWith('/') ||
    /[\0\r\n:,]/u.test(sourceRoot)
  )
    fail('CLIENT_IDENTITY_INVALID');
  return [
    'create',
    '--rm',
    '--pull',
    'never',
    '--name',
    applicationName,
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    '64',
    '--memory',
    '512m',
    '--cpus',
    '0.5',
    '--user',
    'node',
    '--network',
    client.networkId,
    '--workdir',
    '/app',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,size=64m',
    '--mount',
    `type=bind,source=${sourceRoot}/apps/api/prisma/migrations,target=/app/apps/api/prisma/migrations,readonly`,
    '-e',
    'DATABASE_URL',
    '-e',
    'NODE_ENV=production',
    '-e',
    `MAXIM_MULTIBOT_PREPARE_APPLICATION_NAME=${applicationName}`,
    '--entrypoint',
    'node',
    client.imageId,
    '--input-type=module',
    '-e',
    resolveScript,
  ];
}

export function verifyMultibotRecoveryDatabaseUrl(value) {
  let address;
  try {
    address = new URL(value);
  } catch {
    fail('CLIENT_DATABASE_SCOPE_INVALID');
  }
  if (
    typeof value !== 'string' ||
    value.trim() !== value ||
    /[\0\r\n]/u.test(value) ||
    !['postgresql:', 'postgres:'].includes(address.protocol) ||
    address.hash ||
    !['postgres', 'infra-postgres-1'].includes(address.hostname) ||
    !['', '5432'].includes(address.port) ||
    address.username !== 'maxim' ||
    address.pathname !== '/maxim' ||
    !address.password ||
    address.searchParams.getAll('schema').length > 1 ||
    (address.searchParams.has('schema') && address.searchParams.get('schema') !== 'public') ||
    address.searchParams.has('host') ||
    address.searchParams.has('application_name') ||
    address.searchParams
      .getAll('options')
      .some((option) => /application_name|search_path/iu.test(option))
  )
    fail('CLIENT_DATABASE_SCOPE_INVALID');
  return value;
}

export async function awaitMultibotRecoveryAdmission({
  read = readMultibotRuntimePressure,
  now = Date.now,
  wait = delay,
  requireActive = () => {},
} = {}) {
  const guard = createMultibotRuntimeGuard({ now });
  const started = now();
  while (true) {
    requireActive();
    guard.admit(await read());
    requireActive();
    if (now() - started >= 120_000) return;
    await wait(10_000);
  }
}

export function assertMultibotRecoveryMemory({
  read = () => readFileSync('/proc/meminfo', 'utf8'),
} = {}) {
  const memory = read().match(/^MemAvailable:\s+(\d+) kB$/mu);
  const availableBytes = memory ? Number(memory[1]) * 1024 : NaN;
  if (!Number.isSafeInteger(availableBytes) || availableBytes < 2 * 1024 ** 3)
    fail('MEMORY_HEADROOM_INSUFFICIENT');
}

export function verifyMultibotRecoveryOriginalContainerAbsence(output) {
  // FLAG: An exited or created object may still receive a queued Docker start.
  // Only absence of the exact cancelled UUID can authorize recovery statements.
  if (typeof output !== 'string' || output.trim() !== '') fail('CANCELLATION_CONTAINER_PRESENT');
  return true;
}

const resolveScript = `import {createMultibotPrepareEnvironment} from './scripts/agent/multibot-online-prepare.mjs';
import {spawnSync} from 'node:child_process';
const env=createMultibotPrepareEnvironment(process.env);
const result=spawnSync('./node_modules/.bin/prisma',['migrate','resolve','--applied','${MULTIBOT_PREPARATION_RECOVERY_MIGRATION}','--config','apps/api/prisma.config.ts'],{env,stdio:'inherit',timeout:120000});
process.exit(result.error?1:(result.status??1));`;

async function main(args) {
  const validateOnly = args[0] === '--validate-args';
  const options = parseMultibotRecoveryArgs(validateOnly ? args.slice(1) : args);
  if (validateOnly) return;
  if (process.env.MAXIM_MULTIBOT_RECOVERY_LOCKED !== '1') fail('LOCK_REQUIRED');
  let interrupted = false;
  const interrupt = () => {
    interrupted = true;
  };
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const signal of signals) process.on(signal, interrupt);
  const recoveryStarted = Date.now();
  const deadline = setTimeout(() => {
    interrupted = true;
    process.emit('SIGTERM');
  }, 7_500_000);
  const requireActive = () => {
    if (interrupted) fail('INTERRUPTED');
    if (Date.now() - recoveryStarted >= 7_500_000) fail('DEADLINE_EXHAUSTED');
  };
  try {
    const run = async (binary, commandArgs, extra = {}) => {
      requireActive();
      try {
        const { trimOutput = true, ...commandOptions } = extra;
        const result = (
          await runMultibotSupervisorCommand(binary, commandArgs, {
            timeout: 15_000,
            maxBuffer: 2 * 1024 * 1024,
            ...commandOptions,
          })
        ).stdout;
        requireActive();
        return trimOutput ? result.trim() : result;
      } catch {
        fail('COMMAND_FAILED');
      }
    };
    const sourceSha = await run('git', ['rev-parse', 'HEAD']);
    if (!shaPattern.test(sourceSha) || process.env.MAXIM_EXPECTED_DEPLOY_SHA !== sourceSha)
      fail('SOURCE_SHA_INVALID');
    const recoverySourcePaths = [
      'infra/scripts/multibot-preparation-recovery.mjs',
      'infra/scripts/multibot-preparation-recovery-state.mjs',
      'infra/scripts/multibot-prepare-diagnostics.mjs',
      'infra/scripts/multibot-online-supervisor.mjs',
      'infra/scripts/multibot-online-client.mjs',
      'infra/scripts/multibot-runtime-pressure.mjs',
      'infra/scripts/vps-recover-multibot-preparation.sh',
      'infra/scripts/vps-postgres-audit.sh',
    ];
    await run('git', ['ls-files', '--error-unmatch', '--', ...recoverySourcePaths]);
    const untrackedSource = await run('git', [
      'ls-files',
      '--others',
      '--exclude-standard',
      '--',
      'infra',
      'scripts/agent/multibot-online-prepare.mjs',
      'apps/api/prisma/migrations',
    ]);
    if (untrackedSource) fail('SOURCE_SHA_INVALID');
    await run('git', [
      'diff',
      '--quiet',
      'HEAD',
      '--',
      'infra',
      'scripts/agent/multibot-online-prepare.mjs',
      'apps/api/prisma/migrations',
    ]);
    await run('git', ['merge-base', '--is-ancestor', options['--cancelled-source'], sourceSha]);
    for (const [name, checksum] of Object.entries(multibotPreparationChecksums)) {
      const bytes = await run(
        'git',
        [
          'show',
          `${options['--cancelled-source']}:apps/api/prisma/migrations/${name}/migration.sql`,
        ],
        { trimOutput: false },
      );
      const current = readFileSync(`apps/api/prisma/migrations/${name}/migration.sql`, 'utf8');
      if (bytes !== current || hash(bytes) !== checksum || hash(current) !== checksum)
        fail('IMMUTABLE_SOURCE_CHANGED');
    }
    const imageRef = `maxim-api:${options['--cancelled-source']}`;
    const image = JSON.parse(await run('docker', ['image', 'inspect', imageRef]))[0];
    if (
      image?.Config?.Labels?.['org.opencontainers.image.revision'] !==
        options['--cancelled-source'] ||
      image.Config.Labels['com.maxim.release-protected'] !== 'true'
    )
      fail('RESOLVE_IMAGE_INVALID');
    process.env.MAXIM_API_IMAGE = imageRef;
    process.env.MAXIM_MIGRATION_API_IMAGE = imageRef;
    const stateDir = '/var/lib/maxim-deploy';
    const readJournal = () => {
      if (existsSync(resolve(stateDir, 'current.json'))) fail('TRANSITION_JOURNAL_INVALID');
      const paths = listRecoveryBaseManifestPaths(stateDir);
      if (paths.length !== 1 || !/current\.invalid-deploy-\d{8}T\d{6}Z-\d+\.json$/u.test(paths[0]))
        fail('TRANSITION_JOURNAL_INVALID');
      const manifest = readRecoveryBaseManifest(paths[0]);
      const digest = hash(readFileSync(paths[0]));
      if (
        manifest.components['api-shared'].sourceSha !== options['--baseline-source'] ||
        (options['--journal-sha'] && options['--journal-sha'] !== digest)
      )
        fail('TRANSITION_JOURNAL_CHANGED');
      return { manifest, digest };
    };
    const journal = readJournal();
    const diagnostic = async () => {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        requireActive();
        try {
          const output = await runMultibotSupervisorCommand(
            'bash',
            ['infra/scripts/vps-postgres-audit.sh', 'multibot-preparation'],
            { timeout: 12_000, maxBuffer: 128 * 1024 },
          );
          requireActive();
          return JSON.parse(output.stdout.trim());
        } catch (error) {
          if (error.code !== 75 || attempt === 9) fail('DIAGNOSTIC_UNAVAILABLE');
          await delay(1_000);
        }
      }
    };
    const first = await diagnostic();
    const receipt =
      first.metadata?.migrations
        ?.find((entry) => entry.name === MULTIBOT_PREPARATION_RECOVERY_MIGRATION)
        ?.records?.find((record) => record.identity_hash === options['--receipt-sha']) ??
      first.metadata?.migrations?.find(
        (entry) => entry.name === MULTIBOT_PREPARATION_RECOVERY_MIGRATION,
      )?.records?.[0];
    if (
      !receipt ||
      (options['--receipt-sha'] && options['--receipt-sha'] !== receipt.identity_hash)
    )
      fail('RECEIPT_CHANGED');
    const context = {
      sourceSha,
      cancelledSourceSha: options['--cancelled-source'],
      expectedTransitionSourceSha: options['--baseline-source'],
      expectedTransitionJournalHash: options['--journal-sha'] ?? journal.digest,
      expectedReceiptIdentityHash: options['--receipt-sha'] ?? receipt.identity_hash,
      attemptStartedAt: options['--attempt-start'],
      attemptAbortedAt: options['--attempt-abort'],
    };
    const readClient = async () => {
      const ids = (
        await run('docker', [
          'ps',
          '-q',
          '--filter',
          'label=com.docker.compose.project=infra',
          '--filter',
          'label=com.docker.compose.service=postgres',
        ])
      )
        .split(/\s+/u)
        .filter(Boolean);
      if (ids.length !== 1) fail('CLIENT_IDENTITY_INVALID');
      const server = JSON.parse(await run('docker', ['inspect', ids[0]]))[0];
      const serverImage = JSON.parse(await run('docker', ['image', 'inspect', server.Image]))[0];
      const network = JSON.parse(await run('docker', ['network', 'inspect', 'infra_default']))[0];
      return verifyMultibotRecoveryClient(server, serverImage, network);
    };
    const clientIdentity = await readClient();
    const readResolver = async () => {
      const servers = JSON.parse(await run('docker', ['inspect', 'infra-api-ingress-1']));
      if (servers.length !== 1) fail('BASELINE_RUNTIME_INVALID');
      const ingress = servers[0];
      if (
        ingress.Image !== readJournal().manifest.components['api-shared'].imageId ||
        ingress.Name !== '/infra-api-ingress-1' ||
        ingress.State?.Status !== 'running' ||
        ingress.Config?.Labels?.['com.docker.compose.project'] !== 'infra' ||
        ingress.Config.Labels['com.docker.compose.service'] !== 'api-ingress'
      )
        fail('BASELINE_RUNTIME_INVALID');
      const urls = (ingress.Config?.Env ?? []).filter((entry) => entry.startsWith('DATABASE_URL='));
      if (urls.length !== 1 || !urls[0].slice('DATABASE_URL='.length))
        fail('CLIENT_IDENTITY_INVALID');
      return {
        imageId: image.Id,
        networkId: clientIdentity.networkId,
        networkName: clientIdentity.networkName,
        databaseUrl: verifyMultibotRecoveryDatabaseUrl(urls[0].slice('DATABASE_URL='.length)),
      };
    };
    const attest = async () => {
      const freshJournal = readJournal();
      if (freshJournal.digest !== context.expectedTransitionJournalHash)
        fail('TRANSITION_JOURNAL_CHANGED');
      const ids = await run('docker', ['ps', '-q']);
      if (!ids) fail('BASELINE_RUNTIME_INVALID');
      const containers = JSON.parse(await run('docker', ['inspect', ...ids.split(/\s+/u)]));
      verifyMultibotBaselineContainers(
        containers,
        freshJournal.manifest.components['api-shared'].imageId,
      );
      const ownedContainer = await run('docker', [
        'container',
        'ls',
        '--all',
        '--filter',
        `name=^/${options['--attempt-name']}$`,
        '--format',
        '{{.Names}} {{.State}}',
      ]);
      const ownedContainerStopped = verifyMultibotRecoveryOriginalContainerAbsence(ownedContainer);
      const status = await diagnostic();
      const taggedSessionsAbsent =
        status.builders?.statistics_visible === true &&
        status.builders?.absent === true &&
        status.builders?.tagged_sessions === 0;
      return {
        sourceSha: context.cancelledSourceSha,
        transitionSourceSha: context.expectedTransitionSourceSha,
        transitionJournalHash: context.expectedTransitionJournalHash,
        receiptIdentityHash: context.expectedReceiptIdentityHash,
        attemptStartedAt: context.attemptStartedAt,
        attemptAbortedAt: context.attemptAbortedAt,
        taggedSessionsAbsent,
        ownedContainerStopped,
        baselineRuntimeAttested: true,
        cleanupVerifiedAt: new Date().toISOString(),
      };
    };
    const supervised = async (launch, prepare) =>
      superviseMultibotOnlinePrepare(compose, {
        onAttempt: (attempt) =>
          console.log(
            JSON.stringify({
              stage: 'multibot_recovery_attempt',
              ...attempt,
              sourceSha,
              cancelledSourceSha: context.cancelledSourceSha,
            }),
          ),
        prepare,
        start: (_binary, defaultArgs) => {
          const applicationName = defaultArgs[defaultArgs.indexOf('--name') + 1];
          if (!tagPattern.test(applicationName)) fail('OWNED_IDENTITY_INVALID');
          return launch(applicationName);
        },
      });
    const operations = {
      readDiagnostic: diagnostic,
      attestCancellation: attest,
      assertAdmission: async () => {
        requireActive();
        assertMultibotRecoveryMemory();
        await awaitMultibotRecoveryAdmission({ requireActive });
        requireActive();
        assertMultibotRecoveryMemory();
        // FLAG: The supervisor attests fresh live health and reserve before every statement.
        // A finite per-backend budget is an experiment, never a promise of low production I/O.
      },
      repairIndex: async ({ index, action, sql }) => {
        requireActive();
        assertMultibotRecoveryMemory();
        console.log(
          JSON.stringify({
            stage: 'index',
            index,
            action,
            maintenanceWorkers: 0,
            maintenanceWorkMemMiB: 512,
            tempFileLimitGiB: 6,
            statementCeilingSec: 3600,
          }),
        );
        await supervised(
          (applicationName) => {
            const child = spawn('docker', ['start', '--attach', '--interactive', applicationName], {
              stdio: ['pipe', 'ignore', 'ignore'],
            });
            child.stdin.on('error', () => {});
            child.stdin.end(sql);
            return child;
          },
          async (applicationName) => {
            // FLAG: Creation completes before any start request. On interruption the
            // supervisor removes this exact object, preventing a queued client reconnect.
            const fresh = await readClient();
            if (
              fresh.imageId !== clientIdentity.imageId ||
              fresh.networkId !== clientIdentity.networkId ||
              fresh.password !== clientIdentity.password
            )
              fail('CLIENT_IDENTITY_CHANGED');
            const created = await run('docker', multibotRecoveryPsqlArgs(applicationName, fresh), {
              env: { ...process.env, PGPASSWORD: fresh.password },
            });
            if (!/^[a-f0-9]{64}$/u.test(created)) fail('CLIENT_CREATE_UNCONFIRMED');
            assertMultibotRecoveryMemory();
          },
        );
      },
      resolveMigration: async (name) => {
        requireActive();
        if (name !== MULTIBOT_PREPARATION_RECOVERY_MIGRATION) fail('RESOLUTION_OUTSIDE_SCOPE');
        await supervised(
          (applicationName) =>
            spawn('docker', ['start', '--attach', applicationName], { stdio: 'inherit' }),
          async (applicationName) => {
            const freshClient = await readClient();
            if (
              freshClient.imageId !== clientIdentity.imageId ||
              freshClient.networkId !== clientIdentity.networkId
            )
              fail('CLIENT_IDENTITY_CHANGED');
            const resolver = await readResolver();
            const created = await run(
              'docker',
              multibotRecoveryResolverArgs(applicationName, resolver, process.cwd()),
              { env: { ...process.env, DATABASE_URL: resolver.databaseUrl } },
            );
            if (!/^[a-f0-9]{64}$/u.test(created)) fail('CLIENT_CREATE_UNCONFIRMED');
            assertMultibotRecoveryMemory();
          },
        );
      },
    };
    const result = await recoverMultibotPreparation(operations, context, { apply: options.apply });
    requireActive();
    console.log(
      JSON.stringify({
        ...result,
        receiptIdentityHash: context.expectedReceiptIdentityHash,
        transitionJournalHash: context.expectedTransitionJournalHash,
      }),
    );
  } finally {
    clearTimeout(deadline);
    for (const signal of signals) process.off(signal, interrupt);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  installMultibotOutputFence();
  main(process.argv.slice(2)).catch((error) => {
    console.error(
      /^MULTIBOT_(RECOVERY|PREPARE)_[A-Z_]+$/u.test(error.message)
        ? error.message
        : 'MULTIBOT_RECOVERY_FAILED',
    );
    process.exitCode = 1;
  });
}
