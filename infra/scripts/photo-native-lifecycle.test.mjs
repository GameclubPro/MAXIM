import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { config, runtime, image } from './test-fixtures/photo-native-fixtures.mjs';

const root = resolve(import.meta.dirname, '../..');
const sandboxId = 'a'.repeat(64);
const consumerId = 'b'.repeat(64);
function runLifecycle(script, mutate = () => {}) {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-photo-lifecycle-'));
  const sandbox = { ...runtime(), Id: sandboxId, RestartCount: 0 };
  sandbox.State.StartedAt = '2026-10-04T00:00:00Z';
  const consumer = {
    Id: consumerId,
    Image: image,
    State: { Running: true },
    Config: {
      Env: ['PHOTO_NATIVE_SANDBOX_SOCKET_PATH=/run/maxim-photo/native-photo.sock'],
      Labels: {
        'com.docker.compose.project': 'infra',
        'com.docker.compose.service': 'api-moderation-background',
      },
    },
    Mounts: [
      {
        Type: 'volume',
        Name: 'infra_photo_native_ipc',
        Destination: '/run/maxim-photo',
        RW: false,
      },
    ],
  };
  const state = {
    containers: [sandbox, consumer],
    configuration: { name: 'infra', ...config() },
    capability: 'true',
  };
  mutate(state);
  writeFileSync(join(directory, 'state.json'), JSON.stringify(state));
  writeFileSync(
    join(directory, 'docker'),
    `#!/usr/bin/env node
const fs=require('node:fs'), path=require('node:path');
const directory=process.env.PHOTO_TEST_DIRECTORY, location=path.join(directory,'state.json');
const state=JSON.parse(fs.readFileSync(location,'utf8')), args=process.argv.slice(2);
fs.appendFileSync(path.join(directory,'calls.jsonl'),JSON.stringify(args)+'\\n');
const finish=(value='')=>{fs.writeFileSync(location,JSON.stringify(state));process.stdout.write(value);};
const label=(c,k)=>c.Config?.Labels?.[k];
if(args[0]==='image') finish(state.capability);
else if(args[0]==='ps') {
 let rows=state.containers.filter(c=>args.includes('-a')||c.State.Running);
 for(let i=0;i<args.length;i++) if(args[i]==='--filter') {
  const f=args[i+1];
  if(f.startsWith('label=')){const [key,value]=f.slice(6).split('=');rows=rows.filter(c=>label(c,key)===value);}
  if(f.startsWith('volume='))rows=rows.filter(c=>c.Mounts?.some(m=>m.Name===f.slice(7)));
 }
 finish(rows.map(c=>c.Id).join('\\n'));
} else if(args[0]==='inspect') {
 const c=state.containers.find(c=>c.Id===args.at(-1));if(!c)process.exit(1);
 if(args[1]!=='--format')finish(JSON.stringify([c]));
 else if(args[2].includes('StartedAt'))finish(c.Id+'|'+c.State.StartedAt+'|'+c.RestartCount);
 else if(args[2].includes('.Mounts'))finish(c.Mounts.find(m=>m.Destination==='/run/maxim-photo')?.Name??'');
 else if(args[2].includes('.State.Health'))finish(c.State.Health?.Status??'');
 else finish(String(c.State.Running));
} else if(args[0]==='stop') {state.containers.find(c=>c.Id===args.at(-1)).State.Running=false;finish();}
else if(args[0]==='rm') {state.containers=state.containers.filter(c=>c.Id!==args.at(-1));finish();}
else if(args[0]==='compose'&&args.includes('config'))finish(JSON.stringify(state.configuration));
else if(args[0]==='compose'&&args.includes('up')) {state.containers.find(c=>label(c,'com.docker.compose.service')===args.at(-1)).State.Running=true;finish();}
else if(args[0]==='compose'&&(args.includes('run')||args.includes('exec'))) {
 if(state.restartOnSmoke)state.containers.find(c=>c.Id==='${sandboxId}').RestartCount++;
 if(state.smokeFails)process.exit(1);finish();
} else {process.stderr.write('Unexpected fake docker operation');process.exit(2);}
`,
    { mode: 0o755 },
  );
  try {
    const result = spawnSync(
      'bash',
      [
        '-c',
        `set -euo pipefail
source infra/scripts/lib/deploy-topology.sh
COMPOSE_FILES=(-p infra -f infra/docker-compose.yml)
${script}
`,
      ],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 15000,
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          PHOTO_TEST_DIRECTORY: directory,
        },
      },
    );
    const calls = readFileSync(join(directory, 'calls.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map(JSON.parse);
    return {
      ...result,
      calls,
      state: JSON.parse(readFileSync(join(directory, 'state.json'), 'utf8')),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('photo transition stops consumer first and attests before starting its new image', () => {
  const result = runLifecycle(`MAXIM_TARGET_HAS_PHOTO_NATIVE_SANDBOX=1
maxim_topology_require_photo_native_image_capability '${image}'
maxim_topology_reconcile_photo_native_sandbox COMPOSE_FILES '${image}'
docker compose "\${COMPOSE_FILES[@]}" up -d --no-deps --no-build --force-recreate api-moderation-background
maxim_topology_verify_photo_native_sandbox_for_image COMPOSE_FILES '${image}'
maxim_topology_smoke_photo_native_sandbox_uds COMPOSE_FILES '${image}'`);
  assert.equal(result.status, 0, result.stderr);
  const changes = result.calls.filter(
    (args) =>
      ['stop', 'rm'].includes(args[0]) ||
      args.includes('up') ||
      args.includes('run') ||
      args.includes('exec'),
  );
  assert.deepEqual(
    changes.slice(0, 2).map((args) => args.at(-1)),
    [consumerId, sandboxId],
  );
  assert.equal(changes[2].at(-1), 'photo-native-sandbox');
  assert.ok(changes[3].includes('run'));
  assert.equal(changes[4].at(-1), 'api-moderation-background');
  assert.ok(changes[5].includes('exec'));
  assert.ok(
    changes
      .filter((args) => args.includes('up'))
      .every((args) => args.includes('--no-deps') && args.includes('--no-build')),
  );
});

test('compatible legacy target removes the auxiliary and never starts the native workload', () => {
  const result = runLifecycle(`MAXIM_TARGET_HAS_PHOTO_NATIVE_SANDBOX=0
maxim_topology_reconcile_photo_native_sandbox COMPOSE_FILES '${image}'
maxim_topology_require_photo_native_sandbox_absent COMPOSE_FILES`);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    result.state.containers.map((c) => c.Id),
    [consumerId],
  );
  assert.ok(!result.calls.some((args) => args.includes('up') || args.includes('run')));
});

test('failed prestart smoke cleans its one-off and keeps the moderation consumer stopped', () => {
  const result = runLifecycle(
    `MAXIM_TARGET_HAS_PHOTO_NATIVE_SANDBOX=1
maxim_topology_reconcile_photo_native_sandbox COMPOSE_FILES '${image}'
docker compose "\${COMPOSE_FILES[@]}" up -d --no-deps --no-build --force-recreate api-moderation-background`,
    (state) => {
      state.smokeFails = true;
    },
  );
  assert.notEqual(result.status, 0);
  assert.equal(result.state.containers.find((c) => c.Id === consumerId).State.Running, false);
  const smoke = result.calls.find((args) => args.includes('run'));
  assert.ok(smoke, 'the prestart smoke must actually run');
  const smokeName = smoke[smoke.indexOf('--name') + 1];
  assert.match(smokeName, /^maxim-photo-smoke-\d+-\d+$/);
  assert.ok(
    result.calls.some((args) => args[0] === 'rm' && args[1] === '-f' && args[2] === smokeName),
    'failed smoke must clean only its named one-off',
  );
  assert.ok(
    !result.calls.some(
      (args) =>
        args.includes('exec') ||
        (args.includes('up') && args.at(-1) === 'api-moderation-background'),
    ),
    'failure must prevent normal consumer startup',
  );
});

for (const [name, mutate] of [
  [
    'foreign IPC consumer',
    (state) =>
      state.containers.push({
        ...structuredClone(state.containers[1]),
        Id: 'c'.repeat(64),
        Config: { Labels: { 'com.docker.compose.service': 'unexpected' } },
      }),
  ],
  [
    'wrong native image',
    (state) => {
      state.containers[0].Image = `sha256:${'d'.repeat(64)}`;
    },
  ],
  [
    'writable consumer mount',
    (state) => {
      state.containers[1].Mounts[0].RW = true;
    },
  ],
  [
    'duplicate sandbox',
    (state) =>
      state.containers.push({ ...structuredClone(state.containers[0]), Id: 'c'.repeat(64) }),
  ],
]) {
  test(`runtime attestation rejects ${name}`, () => {
    assert.notEqual(
      runLifecycle(
        `maxim_topology_verify_photo_native_sandbox_runtime COMPOSE_FILES '${image}'`,
        mutate,
      ).status,
      0,
    );
  });
}
test('successful hash response cannot hide a sandbox restart', () => {
  assert.notEqual(
    runLifecycle(
      `maxim_topology_smoke_photo_native_sandbox_uds COMPOSE_FILES '${image}'`,
      (state) => {
        state.restartOnSmoke = true;
      },
    ).status,
    0,
  );
});
test('unavailable or malformed image capability never looks like a historical image', () => {
  for (const capability of ['false', 'unexpected']) {
    assert.notEqual(
      runLifecycle(
        `maxim_topology_verify_photo_native_sandbox_for_image COMPOSE_FILES '${image}'`,
        (state) => {
          state.capability = capability;
        },
      ).status,
      0,
    );
  }
});
