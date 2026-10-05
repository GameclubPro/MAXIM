import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { createMultibotOnlineClientLauncher } from './multibot-online-client.mjs';
import {
  runMultibotSupervisorCommand as run,
  stopOwnedMigration,
  superviseMultibotOnlinePrepare,
} from './multibot-online-supervisor.mjs';
import {
  multibotRecoveryPsqlArgs,
  multibotRecoveryResolverArgs,
} from './multibot-preparation-recovery.mjs';
import { MULTIBOT_ONLINE_PREFIX_NAME } from '../../scripts/agent/multibot-online-prepare.mjs';

const receiptName = '20261005016100_index_multibot_retention_cursor';
const indexNames = [
  'webhook_events_semantic_order_idx',
  'webhook_events_status_created_at_id_idx',
  'webhook_events_semantic_replay_fence_idx',
];
const tagPattern =
  /^maxim-online-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const privateOptions = { timeout: 10_000, maxBuffer: 2 * 1024 * 1024 };
export const MULTIBOT_PSQL_CLIENT_METADATA_SQL = `SELECT json_build_object(
  'read_only', current_setting('transaction_read_only')::boolean,
  'application_name', current_setting('application_name'),
  'database_matches', current_database() = 'maxim',
  'maintenance_bytes', pg_size_bytes(current_setting('maintenance_work_mem')),
  'temp_limit_bytes', pg_size_bytes(current_setting('temp_file_limit')),
  'parallel_maintenance_workers', current_setting('max_parallel_maintenance_workers')::integer,
  'parallel_query_workers', current_setting('max_parallel_workers_per_gather')::integer
);`;
let stage = 'ADMISSION';
const childResult = (child) =>
  new Promise((done) => {
    child.once('error', () => done({ error: true }));
    child.once('exit', (code, signal) => done({ code, signal }));
  });
const captureStart = (command, args, options) => {
  const child = spawn(command, args, { ...options, stdio: ['ignore', 'ignore', 'ignore'] });
  return child;
};

export function writeOnlineClientCiCompose(directory, project, image, owner) {
  assert.match(project, /^multibot_ci_[a-f0-9]{32}$/u);
  assert.match(image, /^maxim-api:[a-f0-9]{40}$/u);
  const password = randomUUID().replaceAll('-', '');
  const envPath = resolve(directory, 'ci.env');
  const basePath = resolve(directory, 'compose.json');
  const overlayPath = resolve(directory, 'overlay.json');
  const poisonPath = resolve(directory, 'must-not-inherit');
  mkdirSync(poisonPath, { mode: 0o755 });
  writeFileSync(
    envPath,
    `CI_POSTGRES_PASSWORD=${password}\nCI_DATABASE_URL=postgresql://maxim:${password}@postgres:5432/maxim?schema=public\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    basePath,
    JSON.stringify({
      services: {
        postgres: {
          image: 'postgres:16-alpine',
          environment: {
            POSTGRES_USER: 'maxim',
            POSTGRES_DB: 'maxim',
            POSTGRES_PASSWORD: '${CI_POSTGRES_PASSWORD}',
          },
          tmpfs: ['/var/lib/postgresql/data:rw,nosuid,size=512m'],
          labels: { 'com.maxim.multibot-client-ci': owner },
          command: [
            'postgres',
            '-c',
            'max_parallel_workers_per_gather=0',
            '-c',
            'max_parallel_maintenance_workers=0',
          ],
        },
        'api-ingress': {
          image,
          command: ['node', '-e', "throw new Error('CI metadata service must never start')"],
          environment: {
            DATABASE_URL: 'postgresql://maxim:invalid@postgres:5432/maxim?schema=public',
            MAX_BOT_TOKEN: 'CI_SECRET_MUST_NOT_REACH_MIGRATION_CLIENT',
          },
          volumes: [`${poisonPath}:/must-not-inherit:ro`],
        },
      },
      networks: { default: { internal: true, labels: { 'com.maxim.multibot-client-ci': owner } } },
    }),
    { mode: 0o600 },
  );
  writeFileSync(
    overlayPath,
    JSON.stringify({
      services: {
        'api-ingress': {
          environment: { DATABASE_URL: '${CI_DATABASE_URL}' },
        },
      },
    }),
    { mode: 0o600 },
  );
  return ['--env-file', envPath, '-p', project, '-f', basePath, '-f', overlayPath];
}

async function drive(
  directory,
  project,
  sourceRoot,
  imageId,
  goodTag,
  cancelledTag,
  resolverTag,
  owner,
) {
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  assert.match(process.env.MAXIM_EXPECTED_DEPLOY_SHA ?? '', /^[a-f0-9]{40}$/u);
  assert.match(project, /^multibot_ci_[a-f0-9]{32}$/u);
  assert.match(imageId, /^sha256:[a-f0-9]{64}$/u);
  for (const tag of [goodTag, cancelledTag, resolverTag]) assert.match(tag, tagPattern);
  const compose = [
    '--env-file',
    resolve(directory, 'ci.env'),
    '-p',
    project,
    '-f',
    resolve(directory, 'compose.json'),
    '-f',
    resolve(directory, 'overlay.json'),
  ];
  const docker = async (args, options = {}) =>
    (await run('docker', args, { ...privateOptions, ...options })).stdout.trim();
  const json = async (args) => JSON.parse(await docker(args));
  const pg = (sql) =>
    docker(
      [
        'compose',
        ...compose,
        'exec',
        '-T',
        'postgres',
        'psql',
        '-X',
        '-v',
        'ON_ERROR_STOP=1',
        '-U',
        'maxim',
        '-d',
        'maxim',
        '-Atq',
      ],
      { input: sql },
    );
  const until = async (condition) => {
    const limit = Date.now() + 7_000;
    while (Date.now() < limit) {
      if (await condition()) return;
      await delay(100);
    }
    throw new Error('MULTIBOT_CLIENT_CI_OBSERVATION_TIMEOUT');
  };
  const absent = async (tag) => {
    await until(
      async () =>
        (await docker([
          'container',
          'ls',
          '--all',
          '--filter',
          `name=^/${tag}$`,
          '--format',
          '{{.ID}}',
        ])) === '' &&
        (await pg(
          `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND application_name='${tag}';`,
        )) === '0',
    );
  };
  const attest = async (tag, expectedNetwork, resolver = false) => {
    const [container] = await json(['container', 'inspect', tag]);
    const [network] = await json(['network', 'inspect', expectedNetwork]);
    assert.equal(container.Image, imageId);
    assert.equal(container.State.Status, 'created');
    assert.equal(container.HostConfig.ReadonlyRootfs, true);
    assert.equal(container.HostConfig.AutoRemove, true);
    assert.equal(container.HostConfig.NetworkMode, network.Id);
    assert.deepEqual(container.HostConfig.CapDrop, ['ALL']);
    assert(
      container.HostConfig.SecurityOpt.some((option) => option.startsWith('no-new-privileges')),
    );
    assert.equal(container.HostConfig.PidsLimit, 64);
    assert.equal(container.HostConfig.Memory, 512 * 1024 ** 2);
    assert.equal(container.HostConfig.NanoCpus, 500_000_000);
    assert.equal(container.Config.User, resolver ? 'node' : '1000:1000');
    assert.equal(
      container.Config.Env.some((value) => value.startsWith('MAX_BOT_TOKEN=')),
      false,
    );
    assert.equal(
      container.Config.Env.some((value) => value.includes('CI_SECRET_MUST_NOT_REACH')),
      false,
    );
    assert(container.Config.Env.includes(`MAXIM_MULTIBOT_PREPARE_APPLICATION_NAME=${tag}`));
    assert.match(container.HostConfig.Tmpfs['/tmp'], /size=64m/u);
    if (!resolver) {
      assert.match(
        container.HostConfig.Tmpfs['/app/apps/api/.migration-prepare'],
        /uid=1000,gid=1000,mode=0700,size=256m/u,
      );
      assert.equal(
        container.Mounts.some((mount) => mount.Type === 'bind' || mount.Type === 'volume'),
        false,
      );
      assert.deepEqual(container.Config.Entrypoint, ['node']);
      assert.deepEqual(container.Config.Cmd, ['scripts/agent/multibot-online-prepare.mjs']);
    } else {
      const sourceMount = container.Mounts.find(
        (mount) => mount.Destination === '/app/apps/api/prisma/migrations',
      );
      assert.equal(sourceMount.Type, 'bind');
      assert.equal(sourceMount.Source, resolve(sourceRoot, 'apps/api/prisma/migrations'));
      assert.equal(sourceMount.RW, false);
    }
  };
  const names = readdirSync(resolve(sourceRoot, 'apps/api/prisma/migrations'), {
    withFileTypes: true,
  })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        /^\d{14}_[a-z0-9_]+$/u.test(entry.name) &&
        entry.name <= MULTIBOT_ONLINE_PREFIX_NAME,
    )
    .map((entry) => entry.name)
    .sort();
  const checksums = new Map(
    names.map((name) => [
      name,
      createHash('sha256')
        .update(
          readFileSync(resolve(sourceRoot, 'apps/api/prisma/migrations', name, 'migration.sql')),
        )
        .digest('hex'),
    ]),
  );
  assert(names.includes(receiptName));
  const attestPrefix = async (allowResolvedReceipt = false) => {
    const receipts = JSON.parse(
      await pg(`SELECT json_agg(json_build_object('name',migration_name,'checksum',checksum,'finished',finished_at IS NOT NULL,'steps',applied_steps_count) ORDER BY migration_name)
      FROM _prisma_migrations WHERE rolled_back_at IS NULL;`),
    );
    assert.deepEqual(
      receipts.map((receipt) => receipt.name),
      names,
    );
    for (const receipt of receipts) {
      assert.equal(receipt.checksum, checksums.get(receipt.name));
      assert.equal(receipt.finished, true);
      assert(Number.isInteger(receipt.steps));
      assert(receipt.steps >= (allowResolvedReceipt && receipt.name === receiptName ? 0 : 1));
    }
    const indexes = JSON.parse(
      await pg(`SELECT json_agg(json_build_object('name',c.relname,'valid',i.indisvalid,'ready',i.indisready,'live',i.indislive,'definition',pg_get_indexdef(c.oid)) ORDER BY c.relname)
      FROM pg_class c JOIN pg_index i ON i.indexrelid=c.oid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname IN (${indexNames.map((name) => `'${name}'`).join(',')});`),
    );
    assert.deepEqual(indexes.map((index) => index.name).sort(), [...indexNames].sort());
    assert(indexes.every((index) => index.valid && index.ready && index.live));
    assert.equal(
      await pg(
        `SELECT count(*) FROM pg_attribute WHERE attrelid='public.webhook_execution_claims'::regclass AND attname IN ('command_result','business_started_at') AND NOT attisdropped;`,
      ),
      '0',
    );
    assert.equal(
      await pg(
        `SELECT count(*) FROM _prisma_migrations WHERE migration_name>'${MULTIBOT_ONLINE_PREFIX_NAME}';`,
      ),
      '0',
    );
    return indexes;
  };
  let barrier;
  let barrierResult;
  let mainChild;
  let mainResult;
  const observerTag = `${goodTag}-observer`;
  try {
    stage = 'IMMUTABLE_PREFIX';
    barrier = spawn(
      'docker',
      [
        'compose',
        ...compose,
        'exec',
        '-T',
        '-e',
        `PGAPPNAME=${observerTag}`,
        'postgres',
        'psql',
        '-X',
        '-v',
        'ON_ERROR_STOP=1',
        '-U',
        'maxim',
        '-d',
        'maxim',
        '-Atq',
        '-c',
        'SELECT pg_advisory_lock(72707369); SELECT pg_sleep(60);',
      ],
      { stdio: 'ignore' },
    );
    barrierResult = childResult(barrier);
    await until(
      async () =>
        (await pg(
          `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='${observerTag}' AND wait_event='PgSleep');`,
        )) === 't',
    );
    const launcher = await createMultibotOnlineClientLauncher(compose, { start: captureStart });
    await launcher.prepare(goodTag);
    await attest(goodTag, `${project}_default`);
    mainChild = launcher.start(goodTag);
    mainResult = childResult(mainChild);
    await until(
      async () =>
        (await pg(
          `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='${goodTag}' AND backend_type='client backend');`,
        )) === 't',
    );
    const permissionsProbe = `const fs=require('node:fs'),assert=require('node:assert/strict');
const p='/app/apps/api/.migration-prepare';const s=fs.statSync(p);assert.equal(process.getuid(),1000);assert.equal(process.getgid(),1000);assert.equal(s.uid,1000);assert.equal(s.gid,1000);assert.equal(s.mode&511,448);
const mounts=fs.readFileSync('/proc/mounts','utf8').split('\\n');assert(mounts.some(l=>l.split(' ')[1]===p&&l.split(' ')[2]==='tmpfs'));assert(mounts.some(l=>l.split(' ')[1]==='/'&&l.split(' ')[3].split(',').includes('ro')));
fs.writeFileSync(p+'/ci-write-probe','ok',{mode:384});assert.equal(fs.readFileSync(p+'/ci-write-probe','utf8'),'ok');fs.unlinkSync(p+'/ci-write-probe');`;
    await docker(['exec', goodTag, 'node', '-e', permissionsProbe]);
    await pg(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=current_database() AND application_name='${observerTag}';`,
    );
    await barrierResult;
    barrier = undefined;
    assert.deepEqual(await mainResult, { code: 0, signal: null });
    mainChild = undefined;
    await absent(goodTag);
    const indexesBefore = await attestPrefix();
    console.log(
      'PASS immutable full source prefix, real tagged Prisma session, readonly root and writable bounded tmpfs, three valid indexes, cutoff absent',
    );

    stage = 'CANCEL_BEFORE_CONNECT';
    const cancelled = await createMultibotOnlineClientLauncher(compose, { start: captureStart });
    await cancelled.prepare(cancelledTag);
    await attest(cancelledTag, `${project}_default`);
    await stopOwnedMigration(compose, undefined, cancelledTag, cancelledTag);
    await absent(cancelledTag);
    const rejected = await childResult(cancelled.start(cancelledTag));
    assert.notEqual(rejected.code, 0);
    await absent(cancelledTag);
    console.log(
      'PASS exact named cancellation before connection, late start rejected, no container or tagged backend',
    );

    // FLAG: Only admission/runtime observations are CI fixtures. The supervisor's
    // default prepare/start factory, Docker daemon, API image and Prisma are real.
    stage = 'DEFAULT_SUPERVISOR';
    const filesystem = { device: '/ci-owned', availableBytes: 10 * 1024 ** 3 };
    const healthy = async () => {
      const stamp = new Date().toISOString();
      const probe = {
        status: 200,
        body: {
          ok: true,
          timestamp: stamp,
          checks: {
            database: true,
            redis: true,
            queueLag: {
              ok: true,
              rawOk: true,
              softWarning: false,
              softWarningCode: null,
              effectiveLagSec: 0,
              sampleGeneratedAt: stamp,
            },
          },
        },
      };
      return { checkedAtMs: Date.now(), ingress: probe, admin: structuredClone(probe) };
    };
    await superviseMultibotOnlinePrepare(compose, {
      checkCapacity: async () => ({ devices: [filesystem] }),
      readFilesystems: async () => [filesystem],
      checkRuntime: healthy,
      createLauncher: async (scope) => {
        const actual = await createMultibotOnlineClientLauncher(scope);
        return {
          prepare: async (tag) => {
            assert.match(tag, tagPattern);
            writeFileSync(resolve(directory, 'additional-owned-client'), tag, { mode: 0o600 });
            await actual.prepare(tag);
          },
          start: actual.start,
        };
      },
    });
    assert.deepEqual(await attestPrefix(), indexesBefore);
    console.log(
      'PASS actual default supervisor preserves the private env file, ordered Compose overlay and non-infra project',
    );

    stage = 'PSQL_CLIENT';
    await docker([
      'network',
      'create',
      '--internal',
      '--label',
      `com.maxim.multibot-client-ci=${owner}`,
      '--label',
      'com.docker.compose.project=infra',
      '--label',
      'com.docker.compose.network=default',
      'infra_default',
    ]);
    const pgId = await docker(['compose', ...compose, 'ps', '-q', 'postgres']);
    assert.match(pgId, /^[a-f0-9]{64}$/u);
    await docker(['network', 'connect', '--alias', 'postgres', 'infra_default', pgId]);
    const effective = await json(['compose', ...compose, 'config', '--format', 'json']);
    const [resolverNetwork] = await json(['network', 'inspect', 'infra_default']);
    const [postgresFixture] = await json(['container', 'inspect', pgId]);
    // FLAG: The official server image declares a data VOLUME. The actual short-lived
    // psql client must override it with bounded readonly tmpfs, never an anonymous volume.
    await docker(
      multibotRecoveryPsqlArgs(cancelledTag, {
        imageId: postgresFixture.Image,
        networkName: 'infra_default',
        networkId: resolverNetwork.Id,
      }),
      {
        env: {
          ...process.env,
          PGPASSWORD: effective.services.postgres.environment.POSTGRES_PASSWORD,
        },
      },
    );
    const [psqlClient] = await json(['container', 'inspect', cancelledTag]);
    assert.equal(psqlClient.Image, postgresFixture.Image);
    assert.equal(psqlClient.State.Status, 'created');
    assert.equal(psqlClient.HostConfig.ReadonlyRootfs, true);
    assert.equal(psqlClient.HostConfig.AutoRemove, true);
    assert.equal(psqlClient.HostConfig.NetworkMode, resolverNetwork.Id);
    assert.equal(psqlClient.HostConfig.PidsLimit, 32);
    assert.equal(psqlClient.HostConfig.Memory, 128 * 1024 ** 2);
    assert.equal(psqlClient.HostConfig.NanoCpus, 250_000_000);
    assert.equal(psqlClient.Config.User, 'postgres');
    assert.deepEqual(psqlClient.Config.Entrypoint, ['psql']);
    assert.deepEqual(psqlClient.HostConfig.CapDrop, ['ALL']);
    assert(
      psqlClient.HostConfig.SecurityOpt.some((option) => option.startsWith('no-new-privileges')),
    );
    assert.equal(
      psqlClient.HostConfig.Tmpfs['/var/lib/postgresql/data'],
      'ro,noexec,nosuid,size=64k',
    );
    assert.equal(
      psqlClient.Mounts.some((mount) => mount.Type === 'volume' || mount.Type === 'bind'),
      false,
    );
    const psqlOutput = await docker(['start', '--attach', '--interactive', cancelledTag], {
      input: `BEGIN READ ONLY;\n${MULTIBOT_PSQL_CLIENT_METADATA_SQL}\nCOMMIT;`,
    });
    const metadataRows = psqlOutput.split('\n').filter((line) => line.startsWith('{'));
    assert.equal(metadataRows.length, 1);
    assert.deepEqual(JSON.parse(metadataRows[0]), {
      read_only: true,
      application_name: cancelledTag,
      database_matches: true,
      maintenance_bytes: 512 * 1024 ** 2,
      temp_limit_bytes: 6 * 1024 ** 3,
      parallel_maintenance_workers: 0,
      parallel_query_workers: 0,
    });
    await absent(cancelledTag);
    assert.deepEqual(await attestPrefix(), indexesBefore);
    console.log(
      'PASS actual readonly psql client without anonymous volumes, bounded data tmpfs, immutable network and backend maintenance/temp limits, schema unchanged',
    );

    // FLAG: A failed receipt is explicit disposable CI data, using the checksum
    // already established by original source deploy; no production resolution runs.
    stage = 'OFFICIAL_RESOLVE';
    await pg(`UPDATE _prisma_migrations SET finished_at=NULL, applied_steps_count=0, logs='57014 CI cancelled migration receipt'
      WHERE migration_name='${receiptName}' AND rolled_back_at IS NULL;`);
    await docker(
      multibotRecoveryResolverArgs(
        resolverTag,
        { imageId, networkName: 'infra_default', networkId: resolverNetwork.Id },
        sourceRoot,
      ),
      {
        env: {
          ...process.env,
          DATABASE_URL: effective.services['api-ingress'].environment.DATABASE_URL,
        },
      },
    );
    await attest(resolverTag, 'infra_default', true);
    const resolved = await run('docker', ['start', '--attach', resolverTag], {
      timeout: 60_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    assert.match(resolved.stdout, /marked as applied/u);
    await absent(resolverTag);
    assert.deepEqual(await attestPrefix(true), indexesBefore);
    assert.equal(
      await pg(
        `SELECT count(*) FROM _prisma_migrations WHERE migration_name='${receiptName}' AND rolled_back_at IS NOT NULL;`,
      ),
      '1',
    );
    console.log(
      'PASS official Prisma resolve in the readonly exact API image, original readonly migration source, checksum and indexes preserved, cutoff absent',
    );
  } finally {
    if (barrier) {
      await pg(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=current_database() AND application_name='${observerTag}';`,
      ).catch(() => {});
      barrier.kill('SIGKILL');
    }
    if (mainChild) await stopOwnedMigration(compose, mainChild, goodTag, goodTag).catch(() => {});
    if (barrierResult) await barrierResult;
    if (mainResult) await mainResult;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const [mode, directory, project, imageOrRoot, ownerOrImage, ...rest] = process.argv.slice(2);
    if (mode === 'compose' && rest.length === 0)
      writeOnlineClientCiCompose(directory, project, imageOrRoot, ownerOrImage);
    else if (mode === 'run' && rest.length === 4)
      await drive(directory, project, imageOrRoot, ownerOrImage, ...rest);
    else throw new Error('MULTIBOT_CLIENT_CI_ARGUMENTS_INVALID');
  } catch {
    console.error(`MULTIBOT_CLIENT_CI_FIXTURE_FAILED stage=${stage}`);
    process.exitCode = 1;
  }
}
