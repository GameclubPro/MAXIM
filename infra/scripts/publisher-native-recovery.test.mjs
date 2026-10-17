import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { legacyColdFleet } from './test-fixtures/legacy-cold-fleet.mjs';

const root = resolve(import.meta.dirname, '../..');
const rollout = readFileSync(join(root, 'infra/scripts/vps-publisher-dispatch-rollout.sh'), 'utf8');
const serviceOf = (container) => container.Config.Labels['com.docker.compose.service'];
const mediaService = 'api-media-analysis';
const photoConsumerService = 'api-moderation-background';
function block(name) {
  const start = rollout.indexOf(`${name}() {`);
  assert.notEqual(start, -1);
  const end = rollout.indexOf('\n}', start);
  assert.notEqual(end, -1);
  return rollout.slice(start, end + 2);
}

function fixture() {
  const containers = legacyColdFleet();
  const ocr = containers.find((row) => serviceOf(row) === 'ocr-native-sandbox');
  ocr.HostConfig.Privileged = false;
  const media = containers.find((row) => serviceOf(row) === mediaService);
  media.Mounts = [{ ...ocr.Mounts[0], RW: false }];
  media.Config.Env.push(...ocr.Config.Env);
  const photoConsumer = containers.find((row) => serviceOf(row) === photoConsumerService);
  photoConsumer.Config.Env.push(
    'PHOTO_NATIVE_SANDBOX_SOCKET_PATH=/run/maxim-photo/native-photo.sock',
  );
  photoConsumer.Mounts = [
    { Type: 'volume', Name: 'infra_photo_native_ipc', Destination: '/run/maxim-photo', RW: false },
  ];
  for (const container of containers.filter((row) => serviceOf(row).startsWith('api-'))) {
    container.Config.Env.push(
      'MAX_PUBLISHER_DISPATCH_ENABLED=true',
      'PUBLISHER_TEMPORAL_SELECTION_ROLLOUT=test',
    );
  }
  return { containers };
}
function stop(container) {
  container.State.Running = false;
  container.State.Status = 'exited';
}
function run({
  stopped = [],
  mutate = () => {},
  policy = 'allow-stopped',
  command,
  apply = 1,
  adopt = 1,
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'publisher-native-recovery-'));
  const state = fixture();
  for (const service of stopped) stop(state.containers.find((row) => serviceOf(row) === service));
  mutate(state);
  writeFileSync(join(directory, 'state.json'), JSON.stringify(state));
  writeFileSync(join(directory, 'calls.jsonl'), '');
  writeFileSync(
    join(directory, 'docker.cjs'),
    `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');
const dir=process.env.PUBLISHER_NATIVE_TEST_DIRECTORY;
const state=JSON.parse(fs.readFileSync(path.join(dir,'state.json'),'utf8'));
const args=process.argv.slice(2),label=(c,key)=>c.Config?.Labels?.[key];
fs.appendFileSync(path.join(dir,'calls.jsonl'),JSON.stringify(args)+'\\n');
const finish=(value='')=>process.stdout.write(value);
if(args[0]==='compose'&&args.includes('config'))finish(JSON.stringify({name:'infra'}));
else if(args[0]==='compose'&&args.includes('ps')) {
 const service=args.at(-1);let rows=state.containers.filter(c=>label(c,'com.docker.compose.service')===service);
 if(!args.includes('-a'))rows=rows.filter(c=>c.State.Running);
 finish(rows.map(c=>c.Id).join('\\n'));
} else if(args[0]==='image'&&args.includes('inspect'))finish('true');
else if(args[0]==='ps') {
 let rows=state.containers.filter(c=>args.includes('-a')||c.State.Running);
 for(let i=0;i<args.length;i++)if(args[i]==='--filter') {
  const filter=args[++i];
  if(filter.startsWith('label=')){const [key,value]=filter.slice(6).split('=');rows=rows.filter(c=>label(c,key)===value);}
  else if(filter.startsWith('volume='))rows=rows.filter(c=>c.Mounts?.some(m=>m.Name===filter.slice(7)));
  else process.exit(91);
 }
 finish(rows.map(c=>c.Id).join('\\n'));
} else if(args[0]==='inspect') {
 const ids=args.slice(args[1]==='--format'?3:1),rows=ids.map(id=>state.containers.find(c=>c.Id===id));
 if(rows.some(c=>!c))process.exit(1);
 const c=rows[0],format=args[2];
 if(args[1]!=='--format')finish(JSON.stringify(rows));
 else if(format==='{{.Image}}')finish(c.Image);
 else if(format.includes('.Config.Env'))finish(c.Config.Env.join('\\n'));
 else if(format.includes('.State.Status')) {
  const value=[c.State.Running,c.State.Status,c.State.Paused,c.State.Restarting,c.State.Dead].join('|');
  if(state.replaceAfterState===label(c,'com.docker.compose.service')) {
    c.Id='7'.repeat(64);delete state.replaceAfterState;fs.writeFileSync(path.join(dir,'state.json'),JSON.stringify(state));
  }
  finish(value);
 }
 else if(format.includes('.Mounts'))finish(c.Mounts?.find(m=>m.Destination===(format.includes('/run/maxim-ocr')?'/run/maxim-ocr':'/run/maxim-photo'))?.Name??'');
 else process.exit(92);
} else {process.stderr.write('Unexpected fake Docker operation');process.exit(93);}
`,
    { mode: 0o755 },
  );
  // Keep Compose --env-file arguments out of Node's own option parser.
  const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
  writeFileSync(
    join(directory, 'docker'),
    `#!/usr/bin/env bash\nexec ${quote(process.execPath)} -- ${quote(join(directory, 'docker.cjs'))} "$@"\n`,
    { mode: 0o755 },
  );
  const image = state.containers[0].Image;
  const apiServices = fixture()
    .containers.filter((row) => serviceOf(row).startsWith('api-'))
    .map(serviceOf);
  const script = `set -euo pipefail
source infra/scripts/lib/deploy-topology.sh
${block('native_consumer_runtime_state')}
${block('container_env_summary')}
${block('verify_runtime')}
${block('rollout_preflight')}
COMPOSE_FILES=(--env-file .env -p infra -f infra/docker-compose.yml)
MAXIM_PRODUCTION_API_SERVICES=(${apiServices.join(' ')})
MANIFEST_IMAGE_ID='${image}'
STATE_HELPER=infra/scripts/publisher-dispatch-rollout-state.mjs
COMMAND_TIMEOUT_SEC=5
EXPECTED_HAS_OCR_NATIVE_SANDBOX=1
MAXIM_TARGET_HAS_PHOTO_NATIVE_SANDBOX=1
CURRENT_ENV_STATE=true
CURRENT_ENV_CONFIGURED=true
DESIRED_STATE=false
EXPECTED_SELECTION_MODE=test
EXPECTED_OCR_VERSION=reviewed
MANIFEST_SOURCE_SHA=${'b'.repeat(40)}
SELECTION_OPERATION=0
COMMAND=${command ?? 'disable'}
APPLY=${apply}
MAXIM_WEBHOOK_ROLLOUT_ADOPT_EXISTING_PAUSE=${adopt}
fail() { printf '%s\\n' "$*" >&2; return 1; }
verify_no_unreviewed_running_api_containers() { :; }
verify_compose_config() { :; }
verify_preview_compose_config() { :; }
maxim_topology_require_api_commercial_ocr_version_config() { :; }
maxim_topology_require_media_analysis_rollout_config() { :; }
require_stateful_services_ready() { :; }
${command ? 'rollout_preflight' : `verify_runtime any ${policy}`}
printf 'native-preflight-verified\\n'`;
  try {
    const result = spawnSync('bash', ['-c', script], {
      cwd: root,
      encoding: 'utf8',
      timeout: 15_000,
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        PUBLISHER_NATIVE_TEST_DIRECTORY: directory,
      },
    });
    const calls = readFileSync(join(directory, 'calls.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(JSON.parse);
    assert.ok(
      calls.every(
        (args) => !['stop', 'rm', 'run', 'up', 'exec'].some((token) => args.includes(token)),
      ),
      'preflight must remain read-only',
    );
    assert.doesNotMatch(result.stdout + result.stderr, /do-not-log/u);
    return { ...result, calls };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

for (const stopped of [
  [],
  [mediaService],
  [photoConsumerService],
  [mediaService, photoConsumerService],
]) {
  test(`guarded recovery verifies exact native boundaries with stopped consumers: ${stopped.join(',') || 'none'}`, () => {
    const result = run({ stopped, command: 'disable' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /native-preflight-verified/u);
  });
}
for (const service of [mediaService, photoConsumerService]) {
  test(`ordinary running verification refuses stopped ${service}`, () => {
    assert.notEqual(run({ stopped: [service], policy: 'running' }).status, 0);
  });
  for (const [name, mutate] of [
    [
      'paused',
      (c) => {
        c.State.Running = true;
        c.State.Paused = true;
        c.State.Status = 'paused';
      },
    ],
    [
      'restarting',
      (c) => {
        c.State.Running = true;
        c.State.Restarting = true;
        c.State.Status = 'restarting';
      },
    ],
    [
      'dead',
      (c) => {
        c.State.Dead = true;
      },
    ],
    [
      'created',
      (c) => {
        c.State.Status = 'created';
      },
    ],
    [
      'foreign image',
      (c) => {
        c.Image = `sha256:${'9'.repeat(64)}`;
      },
    ],
    [
      'foreign service',
      (c) => {
        c.Config.Labels['com.docker.compose.service'] = 'unexpected';
      },
    ],
    [
      'foreign project',
      (c) => {
        c.Config.Labels['com.docker.compose.project'] = 'foreign';
      },
    ],
    [
      'wrong role',
      (c) => {
        c.Config.Env = c.Config.Env.map((v) =>
          v === 'APP_ROLE=moderation' ? 'APP_ROLE=admin' : v,
        );
      },
    ],
    [
      'writable socket',
      (c) => {
        c.Mounts[0].RW = true;
      },
    ],
    [
      'wrong socket',
      (c) => {
        c.Mounts[0].Name = 'infra_unreviewed_ipc';
      },
    ],
    [
      'wrong name',
      (c) => {
        c.Name = '/manual-native-consumer';
      },
    ],
    [
      'wrong native profile',
      (c) => {
        c.Config.Env = c.Config.Env.map((v) =>
          v.includes('SANDBOX_SOCKET_PATH=') ? v.replace('.sock', '-other.sock') : v,
        );
      },
    ],
  ]) {
    test(`stopped ${service} recovery rejects ${name}`, () => {
      const result = run({
        stopped: [service],
        mutate: (state) => mutate(state.containers.find((row) => serviceOf(row) === service)),
      });
      assert.notEqual(result.status, 0);
      assert.doesNotMatch(result.stdout, /native-preflight-verified/u);
    });
  }
  test(`stopped ${service} recovery rejects a changed consumer generation`, () => {
    const result = run({
      stopped: [service],
      mutate: (state) => {
        state.replaceAfterState = service;
      },
    });
    assert.notEqual(result.status, 0);
  });
  test(`stopped ${service} recovery rejects duplicate consumer containers`, () => {
    const result = run({
      stopped: [service],
      mutate: (state) => {
        const duplicate = structuredClone(
          state.containers.find((row) => serviceOf(row) === service),
        );
        duplicate.Id = '6'.repeat(64);
        state.containers.push(duplicate);
      },
    });
    assert.notEqual(result.status, 0);
  });
  test(`stopped ${service} recovery rejects a rogue live IPC consumer`, () => {
    const result = run({
      stopped: [service],
      mutate: (state) => {
        const consumer = structuredClone(
          state.containers.find((row) => serviceOf(row) === service),
        );
        consumer.Id = '8'.repeat(64);
        consumer.State.Running = true;
        consumer.State.Status = 'running';
        consumer.Config.Labels['com.docker.compose.service'] = 'rogue';
        state.containers.push(consumer);
      },
    });
    assert.notEqual(result.status, 0);
  });
}
for (const [command, apply, adopt] of [
  ['disable', 0, 1],
  ['disable', 1, 0],
  ['enable', 1, 1],
]) {
  test(`stopped recovery remains restricted: ${command}/apply=${apply}/adopt=${adopt}`, () => {
    assert.notEqual(
      run({ stopped: [mediaService, photoConsumerService], command, apply, adopt }).status,
      0,
    );
  });
}
