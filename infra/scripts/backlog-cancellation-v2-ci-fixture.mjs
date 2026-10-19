import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import {
  createBacklogCancellationHelpersV2,
  runApplyHostV2,
  runPreviewHostV2,
} from './backlog-cancellation-v2-host.mjs';
import { createLegacyColdRuntime } from './legacy-cold-runtime.mjs';
import { LEGACY_COLD_API_SERVICES } from './multibot-legacy-cold-recovery.mjs';

const nativeNames = ['ocr-native-sandbox', 'photo-native-sandbox'];
const services = [...LEGACY_COLD_API_SERVICES, ...nativeNames];
const ownerPattern = /^backlog-v2-ci-[a-f0-9]{32}$/u;
const nodeModules = `const {createPrismaClient}=require('./apps/api/dist/apps/api/src/prisma/prisma-client.js');
const {Redis}=require('ioredis'); const {Queue}=require('bullmq');
const db=createPrismaClient(process.env.DATABASE_URL,{max:1,options:"-c statement_timeout=5000"});
const redis=new Redis(process.env.REDIS_URL,{maxRetriesPerRequest:1});`;
const nodeFinish = `}finally{await redis.quit();await db.$disconnect();}})().catch(()=>{process.stderr.write('CI_STORE_CLIENT_FAILED\\n');process.exitCode=1});`;
const seedCode = `${nodeModules}
(async()=>{try{const {randomUUID}=require('node:crypto');
const {buildWebhookSemanticEventKey}=require('./apps/api/dist/apps/api/src/webhook/webhook-semantic-event-key.js');
const id=randomUUID();const at=new Date(Date.now()-600000);const update={type:'message_created',updateId:id,timestamp:at.toISOString(),botId:'fixture_major',message:{chatId:'-'+id,messageId:id,senderId:'fixture_user',text:'CI fixture only'}};
const semanticKey=buildWebhookSemanticEventKey(update);
await db.webhookEvent.create({data:{id,dedupKey:id,createdAt:at,status:'FAILED',errorMessage:'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:uncertain',semanticKey,rawPayload:update,normalizedPayload:update}});
await db.webhookExecutionClaim.create({data:{kind:'EXECUTION',semanticKey,webhookEventId:id,status:'READY',enforced:true,preparedAt:at,businessStartedAt:at}});
const a=new Queue('moderation',{connection:redis,skipMetasUpdate:true});const b=new Queue('moderation-actions',{connection:redis,skipMetasUpdate:true});
try{await a.add('fixture',{webhookEventId:id},{jobId:id});
await b.add('fixture',{actionType:'SEND_MESSAGE',chatId:update.message.chatId,text:'CI fixture',attempt:0,idempotencyKey:randomUUID(),createdAt:at.toISOString(),ledgerContext:{moderationSource:{version:1,chatId:update.message.chatId,messageId:id,userId:'fixture_user'}}},{jobId:'action-'+id});}
finally{await a.close();await b.close();}
process.stdout.write(JSON.stringify({rootId:id})+'\\n');${nodeFinish}`;
const snapshotCode = `${nodeModules}
(async()=>{try{const id=process.argv[1];const keys=(await redis.keys('bull:*')).sort();const values=[];
for(const key of keys){const type=await redis.type(key);let value;
if(type==='hash'){const fields=await redis.hgetall(key);value=Object.keys(fields).sort().map(field=>[field,fields[field]]);}
else if(type==='list')value=await redis.lrange(key,0,-1);
else if(type==='zset')value=await redis.zrange(key,0,-1,'WITHSCORES');
else if(type==='set')value=(await redis.smembers(key)).sort();
else if(type==='string')value=await redis.get(key);
else if(type==='stream')value=await redis.xrange(key,'-','+');
else throw Error('Unexpected fixture Redis type');
values.push([key,type,value]);}
const root=await db.webhookEvent.findUnique({where:{id}});const claims=await db.webhookExecutionClaim.findMany({where:{webhookEventId:id},orderBy:{id:'asc'}});
process.stdout.write(JSON.stringify({root,claims,redis:values})+'\\n');${nodeFinish}`;
const dependencyCode = `${nodeModules}
(async()=>{try{const rows=await db.$queryRawUnsafe('SELECT 1 AS ready');const ping=await redis.ping();
if(rows[0].ready!==1||ping!=='PONG')throw Error('dependencies');process.stdout.write('READY\\n');${nodeFinish}`;

export const backlogCancellationCiScripts = Object.freeze({
  seedCode,
  snapshotCode,
  dependencyCode,
});

export function backlogCancellationCiCompose(image, sourceSha, owner, password, native) {
  assert.match(image, /^maxim-api:[a-f0-9]{40}$/u);
  assert.equal(image, `maxim-api:${sourceSha}`);
  assert.match(owner, ownerPattern);
  assert.match(password, /^[a-f0-9]{32}$/u);
  const labels = {
    'com.maxim.backlog-v2-ci': owner,
    'com.maxim.release-protected': 'true',
    'org.opencontainers.image.revision': sourceSha,
  };
  const environment = {
    DATABASE_URL: `postgresql://maxim:${password}@postgres:5432/maxim?schema=public`,
    REDIS_URL: 'redis://redis:6379',
    MAX_BOT_ID: 'fixture_major',
    MAX_BOTS_JSON: '[]',
    MAX_PUBLISHER_BOT_ID: 'fixture_publisher',
  };
  const result = {
    services: {
      postgres: {
        image: 'postgres:16-alpine',
        environment: { POSTGRES_USER: 'maxim', POSTGRES_DB: 'maxim', POSTGRES_PASSWORD: password },
        tmpfs: ['/var/lib/postgresql/data:rw,nosuid,size=512m'],
        labels,
      },
      redis: {
        image: 'redis:7-alpine',
        command: ['redis-server', '--save', '', '--appendonly', 'no'],
        labels,
      },
    },
    networks: { default: { name: 'infra_default', internal: true, labels } },
    volumes: {
      ocr_native_ipc: { labels },
      photo_native_ipc: { labels },
    },
  };
  for (const service of LEGACY_COLD_API_SERVICES) {
    const role =
      service.startsWith('api-moderation') || service === 'api-media-analysis'
        ? 'moderation'
        : service.slice(4);
    result.services[service] = {
      image,
      labels,
      restart: 'unless-stopped',
      command: ['node', '-e', 'setInterval(() => {}, 1000)'],
      environment: {
        ...environment,
        APP_SERVICE_NAME: service,
        APP_ROLE: role,
        ...(service === 'api-publisher' ? { MAX_BOT_ID: 'fixture_publisher' } : {}),
      },
    };
  }
  const allowed = [
    'command',
    'entrypoint',
    'restart',
    'init',
    'user',
    'network_mode',
    'cpus',
    'mem_limit',
    'pids_limit',
    'read_only',
    'cap_drop',
    'security_opt',
    'tmpfs',
    'environment',
    'volumes',
    'healthcheck',
  ];
  for (const name of nativeNames) {
    assert(native[name]);
    result.services[name] = Object.fromEntries(
      allowed
        .filter((key) => native[name][key] !== undefined)
        .map((key) => [key, structuredClone(native[name][key])]),
    );
    Object.assign(result.services[name], { image, labels: { ...native[name].labels, ...labels } });
  }
  return result;
}

export async function runBacklogCancellationCiFixture(imageId, image, directory, owner) {
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  assert.match(owner, ownerPattern);
  const sourceSha = process.env.GITHUB_SHA;
  assert.equal(image, `maxim-api:${sourceSha}`);
  assert.match(imageId, /^sha256:[a-f0-9]{64}$/u);
  const root = resolve(import.meta.dirname, '../..');
  const privateStat = lstatSync(directory);
  assert(privateStat.isDirectory() && !privateStat.isSymbolicLink());
  assert.equal(privateStat.uid, process.getuid());
  assert.equal(privateStat.mode & 0o777, 0o700);
  const docker = (args, extra = {}) =>
    execFileSync('docker', args, {
      timeout: 20_000,
      maxBuffer: 2 * 1024 * 1024,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...extra,
    }).trim();
  const json = (args) => JSON.parse(docker(args));
  const existing = docker([
    'ps',
    '-aq',
    '--no-trunc',
    '--filter',
    'label=com.docker.compose.project=infra',
  ]);
  assert.equal(existing, '', 'CI infra project must be absent');
  for (const [kind, name] of [
    ['network', 'infra_default'],
    ['volume', 'infra_ocr_native_ipc'],
    ['volume', 'infra_photo_native_ipc'],
  ]) {
    assert.throws(() => docker([kind, 'inspect', name]), 'CI fixed resources must be absent');
  }
  const effective = JSON.parse(
    docker(
      [
        'compose',
        '--env-file',
        join(root, '.env.example'),
        '-f',
        join(root, 'infra/docker-compose.yml'),
        'config',
        '--format',
        'json',
      ],
      { env: { ...process.env, MAXIM_COMPOSE_SERVICE_ENV_FILE: join(root, '.env.example') } },
    ),
  );
  const config = backlogCancellationCiCompose(
    image,
    sourceSha,
    owner,
    randomUUID().replaceAll('-', ''),
    effective.services,
  );
  const file = join(directory, 'compose.json');
  writeFileSync(file, JSON.stringify(config) + '\n', { mode: 0o600, flag: 'wx' });
  const emptyEnv = join(directory, 'empty.env');
  writeFileSync(emptyEnv, '', { mode: 0o600, flag: 'wx' });
  const compose = [
    '--project-directory',
    directory,
    '--env-file',
    emptyEnv,
    '-p',
    'infra',
    '-f',
    file,
  ];
  const operationIds = [];
  const childClis = new Set();
  let attempted = false,
    cleanupStarted = false;
  const client = (code, args = []) =>
    docker([
      'run',
      '--rm',
      '--label',
      `com.maxim.backlog-v2-ci=${owner}`,
      '--network',
      'infra_default',
      '--env-file',
      join(directory, 'stores.env'),
      imageId,
      'node',
      '-e',
      code,
      ...args,
    ]);
  const cleanup = async () => {
    if (cleanupStarted) return;
    cleanupStarted = true;
    for (const signal of ['SIGTERM', 'SIGKILL']) {
      for (const child of childClis) child.kill(signal);
      const deadline = Date.now() + 5000;
      while (childClis.size && Date.now() < deadline) await delay(25);
    }
    assert.equal(childClis.size, 0, 'Owned helper CLI close must be proved');
    for (const id of operationIds) {
      const ids = docker([
        'ps',
        '-aq',
        '--no-trunc',
        '--filter',
        `label=com.maxim.backlog-cancellation=${id}`,
      ]);
      if (ids) {
        const rows = json(['inspect', ...ids.split('\n')]);
        assert(
          rows.every(
            (row) =>
              row.Image === imageId && row.Config.Labels['com.maxim.backlog-cancellation'] === id,
          ),
        );
        docker(['rm', '-f', ...rows.map((row) => row.Id)]);
      }
    }
    if (attempted) {
      const ids = docker([
        'ps',
        '-aq',
        '--no-trunc',
        '--filter',
        `label=com.maxim.backlog-v2-ci=${owner}`,
      ]);
      if (ids) docker(['rm', '-f', ...ids.split('\n')], { timeout: 30_000 });
      for (const [kind, name] of [
        ['network', 'infra_default'],
        ['volume', 'infra_ocr_native_ipc'],
        ['volume', 'infra_photo_native_ipc'],
      ]) {
        let object;
        try {
          object = json([kind, 'inspect', name])[0];
        } catch {
          continue;
        }
        assert.equal(object.Labels?.['com.maxim.backlog-v2-ci'], owner);
        docker([kind, 'rm', name]);
      }
    }
    assert.equal(docker(['ps', '-aq', '--filter', `label=com.maxim.backlog-v2-ci=${owner}`]), '');
    assert.equal(
      docker(['network', 'ls', '-q', '--filter', `label=com.maxim.backlog-v2-ci=${owner}`]),
      '',
      'Owned network absence must be proved',
    );
    assert.equal(
      docker(['volume', 'ls', '-q', '--filter', `label=com.maxim.backlog-v2-ci=${owner}`]),
      '',
      'Owned volume absence must be proved',
    );
    assert.equal(childClis.size, 0, 'Owned helper CLI exit must be proved');
  };
  const interrupt = () => {
    cleanup().then(
      () => process.exit(143),
      () => process.exit(1),
    );
  };
  process.once('SIGTERM', interrupt);
  process.once('SIGINT', interrupt);
  try {
    attempted = true;
    docker(['compose', ...compose, 'up', '-d', '--no-build', 'postgres', 'redis'], {
      timeout: 90_000,
    });
    const stores = config.services['api-admin'].environment;
    writeFileSync(
      join(directory, 'stores.env'),
      `DATABASE_URL=${stores.DATABASE_URL}\nREDIS_URL=${stores.REDIS_URL}\n`,
      { mode: 0o600, flag: 'wx' },
    );
    let ready = false;
    for (let i = 0; i < 30; i++) {
      try {
        const pg = docker([
          'compose',
          ...compose,
          'exec',
          '-T',
          'postgres',
          'sh',
          '-c',
          'PGPASSWORD="$POSTGRES_PASSWORD" psql -h postgres -X -v ON_ERROR_STOP=1 -U maxim -d maxim -Atq -c "SELECT 1"',
        ]);
        const redis = docker(['compose', ...compose, 'exec', '-T', 'redis', 'redis-cli', 'PING']);
        if (pg === '1' && redis === 'PONG') {
          ready = true;
          break;
        }
      } catch {
        /* Temporary Unix-only PostgreSQL bootstrap is not TCP readiness. */
      }
      await delay(1000);
    }
    assert(ready, 'Disposable stores did not become ready');
    docker(
      [
        'run',
        '--rm',
        '--label',
        `com.maxim.backlog-v2-ci=${owner}`,
        '--network',
        'infra_default',
        '--env-file',
        join(directory, 'stores.env'),
        imageId,
        './node_modules/.bin/prisma',
        'migrate',
        'deploy',
        '--config',
        'apps/api/prisma.config.ts',
      ],
      { timeout: 120_000 },
    );
    docker(['compose', ...compose, 'up', '-d', '--no-build', ...services], { timeout: 90_000 });
    const createHelpers = (options) =>
      createBacklogCancellationHelpersV2({
        ...options,
        spawnDocker(executable, args, settings) {
          assert.equal(args[args.indexOf('--user') + 1], `${process.getuid()}:${process.getgid()}`);
          assert.equal(args[args.indexOf('--cpus') + 1], '1');
          assert.equal(args[args.indexOf('--memory') + 1], '1g');
          assert(!args.some((value) => /MAX_BOT_TOKEN|MAX_BOTS_JSON|MAX_API_/u.test(value)));
          const child = spawn(executable, args, settings);
          childClis.add(child);
          child.once('close', () => childClis.delete(child));
          return child;
        },
      });
    const options = {
      directory,
      expectedSha: sourceSha,
      createHelpers,
      // FLAG: This is an isolated CI fixture lock and idle API fleet. Real Docker,
      // native isolation/startup, compiled clients, stores and identities stay real.
      assertLock() {
        assert.equal(process.env.GITHUB_ACTIONS, 'true');
      },
      proveRestored(runtime) {
        runtime.readRuntimeIdentity();
        assert.equal(client(dependencyCode), 'READY');
        return {
          version: 2,
          dependenciesReady: true,
          fixtureApiProcesses: true,
          productionHttpAcceptance: false,
        };
      },
      report() {},
    };
    const bindings = {
      targetSha: sourceSha,
      targetImageId: imageId,
      controllerNonce: randomUUID(),
      selectionDigest: randomUUID(),
    };
    let initial;
    for (let i = 0; i < 40; i++) {
      try {
        initial = createLegacyColdRuntime({ bindings }).inspectRuntime();
        break;
      } catch {
        if (i === 39) throw Error('Native fixture isolation/health unproved');
        await delay(1000);
      }
    }
    assert(initial, 'Complete native/API fixture inventory is required');
    const expectedIds = [...initial.services, ...initial.auxiliaries]
      .map((row) => row.containerId)
      .sort();
    for (const abort of [false, true]) {
      const rootId = JSON.parse(client(seedCode)).rootId;
      const nomination = {
        version: 2,
        id: randomUUID(),
        cutoff: new Date(Date.now() - 60_000).toISOString(),
        sourceSha,
        imageId,
        rootIds: [rootId],
      };
      operationIds.push(nomination.id);
      const before = client(snapshotCode, [rootId]);
      const preview = await runPreviewHostV2(nomination, options);
      assert.equal(preview.decision, 'READY');
      assert.equal(preview.exitCode, 0);
      assert.equal(client(snapshotCode, [rootId]), before, 'Preview must not write SQL or Redis');
      const op = join(directory, `backlog-cancellation-${nomination.id}`);
      for (const name of ['nomination.json', 'bindings.json', 'preview.json']) {
        const stat = lstatSync(join(op, name));
        assert.equal(stat.uid, process.getuid());
        assert.equal(stat.mode & 0o777, 0o600);
      }
      const request = {
        version: 2,
        id: nomination.id,
        cutoff: nomination.cutoff,
        sourceSha,
        imageId,
        previewSha256: preview.previewSha256,
      };
      const runOptions = abort
        ? {
            ...options,
            createHelpers(input) {
              const actual = createHelpers(input);
              return {
                ...actual,
                async run(mode, value) {
                  if (mode === 'apply') throw Error('CI_INJECTED_BEFORE_WRITER_LAUNCH');
                  return actual.run(mode, value);
                },
              };
            },
          }
        : options;
      const result = await runApplyHostV2(request, runOptions);
      assert.equal(result.outcome, abort ? 'ABORTED_UNWRITTEN' : 'APPLIED');
      assert.equal(result.exitCode, abort ? 2 : 0);
      const restored = createLegacyColdRuntime({ bindings }).inspectRuntime();
      assert.deepEqual(
        [...restored.services, ...restored.auxiliaries].map((row) => row.containerId).sort(),
        expectedIds,
      );
      const after = JSON.parse(client(snapshotCode, [rootId]));
      assert.equal(after.root.status, abort ? 'FAILED' : 'CANCELLED');
      assert.deepEqual(
        after.claims,
        JSON.parse(before).claims,
        'Cancellation must preserve original claims',
      );
      if (abort) {
        assert.equal(
          client(snapshotCode, [rootId]),
          before,
          'Aborted unwritten operation must preserve SQL and Redis',
        );
        assert(
          readFileSync(join(op, 'no-write-proof.json'), 'utf8').includes('"operationAbsent":true'),
        );
      } else
        assert.equal(
          after.redis.some(
            ([key]) =>
              key === `bull:moderation:${rootId}` ||
              key === `bull:moderation-actions:action-${rootId}`,
          ),
          false,
        );
      console.log(
        `PASS actual compiled v2 ${abort ? 'unwritten abort' : 'apply'}, private0600 mounts, native-first same16 restoration; idle API fixture excludes production HTTP acceptance`,
      );
    }
  } finally {
    process.removeListener('SIGTERM', interrupt);
    process.removeListener('SIGINT', interrupt);
    await cleanup();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runBacklogCancellationCiFixture(...process.argv.slice(2)).catch(() => {
    // FLAG: Never publish SQL, Docker inspect, credentials or private helper output.
    console.error('BACKLOG_CANCELLATION_V2_CI_FAILED');
    process.exitCode = 1;
  });
}
