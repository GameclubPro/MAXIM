import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  assertCommercialLlmApiClient,
  waitCommercialLlmCpuDispatcherReady,
} from './commercial-llm-runtime.mjs';

const root = resolve(import.meta.dirname, '../..');
const imageId = `sha256:${'a'.repeat(64)}`;
const operationId = 'c0910e55-7846-45c3-990e-4781de482bc5';

function client(service, role) {
  return {
    Id: 'b'.repeat(64),
    Image: imageId,
    State: { Running: true },
    Config: {
      Labels: {
        'com.maxim.release-protected': 'true',
        'com.docker.compose.project': 'infra',
        'com.docker.compose.service': service,
      },
      Env: [`APP_ROLE=${role}`, `APP_SERVICE_NAME=${service}`],
    },
  };
}

function dispatcher() {
  const value = client('api-moderation-background', 'moderation');
  value.State.StartedAt = '2026-10-31T08:35:40.725000000Z';
  value.State.Status = 'running';
  value.State.Paused = false;
  value.State.Restarting = false;
  value.State.Dead = false;
  value.RestartCount = 0;
  return value;
}

function generation(value) {
  return {
    id: value.Id,
    imageId: value.Image,
    startedAt: value.State.StartedAt,
    restartCount: value.RestartCount,
  };
}

test('headless dispatcher with no Docker healthcheck becomes ready only after stable generation reads', async () => {
  const value = dispatcher();
  let now = 0;
  let reads = 0;
  const pauses = [];
  await waitCommercialLlmCpuDispatcherReady(generation(value), {
    inspect: () => {
      reads += 1;
      return structuredClone(value);
    },
    now: () => now,
    pause: async (milliseconds) => {
      pauses.push(milliseconds);
      now += milliseconds;
    },
  });
  assert.equal(value.State.Health, undefined);
  assert.equal(reads, 2);
  assert.deepEqual(pauses, [5000]);
});

for (const [name, mutate] of [
  [
    'container replacement',
    (value) => {
      value.Id = 'c'.repeat(64);
    },
  ],
  [
    'image replacement',
    (value) => {
      value.Image = `sha256:${'c'.repeat(64)}`;
    },
  ],
  [
    'process restart',
    (value) => {
      value.State.StartedAt = '2026-10-31T08:36:40.725000000Z';
    },
  ],
  [
    'restart counter change',
    (value) => {
      value.RestartCount += 1;
    },
  ],
  [
    'stopped process',
    (value) => {
      value.State.Running = false;
    },
  ],
  [
    'paused process',
    (value) => {
      value.State.Paused = true;
    },
  ],
  [
    'restarting process',
    (value) => {
      value.State.Restarting = true;
    },
  ],
  [
    'dead process',
    (value) => {
      value.State.Dead = true;
    },
  ],
  [
    'incomplete process state',
    (value) => {
      delete value.State.Paused;
    },
  ],
  [
    'foreign role',
    (value) => {
      value.Config.Env[0] = 'APP_ROLE=action';
    },
  ],
]) {
  test(`headless dispatcher refuses ${name} during its stability interval`, async () => {
    const value = dispatcher();
    const expected = generation(value);
    let now = 0;
    await assert.rejects(
      waitCommercialLlmCpuDispatcherReady(expected, {
        inspect: () => structuredClone(value),
        now: () => now,
        pause: async (milliseconds) => {
          mutate(value);
          now += milliseconds;
        },
      }),
    );
  });
}

test('headless dispatcher never extends the original readiness deadline', async () => {
  const value = dispatcher();
  let now = 0;
  await assert.rejects(
    waitCommercialLlmCpuDispatcherReady(generation(value), {
      inspect: () => structuredClone(value),
      now: () => now,
      pause: async () => {
        now += 180000;
      },
    }),
    /dispatcher_readiness_deadline/u,
  );
});

test('a slow final process inspection cannot complete readiness after its original deadline', async () => {
  const value = dispatcher();
  let now = 0;
  let reads = 0;
  await assert.rejects(
    waitCommercialLlmCpuDispatcherReady(generation(value), {
      inspect: () => {
        reads += 1;
        if (reads === 2) now = 180001;
        return structuredClone(value);
      },
      now: () => now,
      pause: async (milliseconds) => {
        now += milliseconds;
      },
    }),
    /dispatcher_readiness_deadline/u,
  );
  assert.equal(reads, 2);
});

test('recovery attests the manifest image, service, role and singleton identity, including stopped dispatchers', () => {
  for (const [service, role] of [
    ['api-admin', 'admin'],
    ['api-moderation-background', 'moderation'],
  ]) {
    const value = client(service, role);
    assert.equal(assertCommercialLlmApiClient(value, { service, imageId }), value);
    value.State.Running = false;
    assert.throws(() => assertCommercialLlmApiClient(value, { service, imageId }));
    assert.equal(
      assertCommercialLlmApiClient(value, { service, imageId, requireRunning: false }),
      value,
    );
    for (const mutate of [
      (x) => {
        x.Id = 'other';
      },
      (x) => {
        x.Image = `sha256:${'c'.repeat(64)}`;
      },
      (x) => {
        x.State.Running = 'false';
      },
      (x) => {
        x.Config.Labels['com.docker.compose.project'] = 'karavan';
      },
      (x) => {
        x.Config.Labels['com.docker.compose.service'] = 'api-action';
      },
      (x) => {
        x.Config.Labels['com.maxim.release-protected'] = 'false';
      },
      (x) => {
        x.Config.Env.push(`APP_ROLE=${role}`);
      },
      (x) => {
        x.Config.Env.push('APP_ROLE=foreign');
      },
      (x) => {
        x.Config.Env.push('APP_SERVICE_NAME=api-action');
      },
      (x) => {
        x.Config.Env = [`APP_ROLE=foreign`, `APP_SERVICE_NAME=${service}`];
      },
    ]) {
      const invalid = structuredClone(value);
      mutate(invalid);
      assert.throws(() =>
        assertCommercialLlmApiClient(invalid, { service, imageId, requireRunning: false }),
      );
    }
  }
  assert.throws(() =>
    assertCommercialLlmApiClient(client('api-action', 'action'), {
      service: 'api-action',
      imageId,
    }),
  );
  assert.throws(() =>
    assertCommercialLlmApiClient(client('api-admin', 'admin'), { service: 'api-admin' }),
  );
});

test('connector binds recovery to the reviewed UUID, plan hash and exact green source before remote execution', () => {
  const source = readFileSync(resolve(root, 'infra/scripts/vps-connect.sh'), 'utf8');
  const start = source.indexOf('commercial_llm() {');
  const fn = source.slice(start, source.indexOf('\n}\n', start) + 2);
  const invoke = (...args) =>
    spawnSync(
      'bash',
      [
        '-c',
        `${fn}
ROOT_DIR=/test
git() { printf '%s\\n' '${'a'.repeat(40)}'; }
node() { printf 'green:%s\\n' "$*"; }
remote_exec() { printf 'remote:%s\\n' "$1"; }
shell_quote_args() { printf '%q ' "$@"; }
commercial_llm "$@"`,
        'cpu-host-test',
        ...args,
      ],
      { encoding: 'utf8' },
    );
  for (const tail of [[], ['--apply', 'b'.repeat(64)]]) {
    const result = invoke('recover-cpu-quarantine', operationId, ...tail);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /green:\/test\/scripts\/ci\/assert-green\.mjs a{40}/u);
    assert.match(result.stdout, /remote:env MAXIM_EXPECTED_DEPLOY_SHA=a{40}/u);
    assert.match(result.stdout, new RegExp(`recover-cpu-quarantine ${operationId}`, 'u'));
    assert.ok(result.stdout.indexOf('green:') < result.stdout.indexOf('remote:'));
  }
  for (const args of [
    [],
    ['../other'],
    [operationId, '--apply'],
    [operationId, '--apply', 'x'],
    [operationId, '--apply', 'b'.repeat(64), 'extra'],
    [operationId, ';id'],
  ]) {
    const result = invoke('recover-cpu-quarantine', ...args);
    assert.equal(result.status, 2, result.stderr);
    assert.doesNotMatch(result.stdout, /remote:|green:/u);
  }
});
