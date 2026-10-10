import assert from 'node:assert/strict';
import { test } from 'node:test';
import { legacyColdFleet } from './test-fixtures/legacy-cold-fleet.mjs';
import { createLegacyColdRuntime, inspectLegacyColdGenerations } from './legacy-cold-runtime.mjs';

const bindings = {
  targetSha: 'b'.repeat(40),
  targetImageId: `sha256:${'a'.repeat(64)}`,
  controllerNonce: '11111111-1111-4111-8111-111111111111',
  selectionDigest: 'c'.repeat(64),
};

test('both auxiliaries must really stop, retaining their reviewed isolation', () => {
  const baseline = inspectLegacyColdGenerations(legacyColdFleet(), bindings);
  const stopped = legacyColdFleet(true);
  assert.equal(
    inspectLegacyColdGenerations(stopped, bindings, baseline, true).auxiliaries.length,
    2,
  );
  for (const index of [14, 15]) {
    const runningAuxiliary = legacyColdFleet(true);
    runningAuxiliary[index] = legacyColdFleet()[index];
    assert.throws(() => inspectLegacyColdGenerations(runningAuxiliary, bindings, baseline, true));
  }
  const changed = legacyColdFleet(true);
  changed[15].HostConfig.NetworkMode = 'host';
  assert.throws(
    () => inspectLegacyColdGenerations(changed, bindings, baseline, true),
    /native_boundary_changed/,
  );
});

for (const [label, mutate] of [
  [
    'restart policy',
    (rows) => {
      rows[0].HostConfig.RestartPolicy.Name = 'always';
    },
  ],
  [
    'replacement generation',
    (rows) => {
      rows[0].Id = 'd'.repeat(64);
    },
  ],
  [
    'role swap',
    (rows) => {
      rows[0].Config.Env[0] = 'APP_SERVICE_NAME=api-action';
    },
  ],
  [
    'duplicate',
    (rows) => {
      rows.push({ ...rows[0], Id: 'd'.repeat(64) });
    },
  ],
  [
    'missing native',
    (rows) => {
      rows.pop();
    },
  ],
  [
    'image mismatch',
    (rows) => {
      rows[3].Image = `sha256:${'d'.repeat(64)}`;
    },
  ],
])
  test(`stopped inventory rejects ${label}`, () => {
    const baseline = inspectLegacyColdGenerations(legacyColdFleet(), bindings);
    const stopped = legacyColdFleet(true);
    mutate(stopped);
    assert.throws(() => inspectLegacyColdGenerations(stopped, bindings, baseline, true));
  });

function startupHarness({ initialHealth = 'starting', onWait, beforeCommand, report } = {}) {
  const rows = legacyColdFleet();
  const calls = [];
  const events = [];
  const waits = [];
  const nativeIds = rows.slice(14).map((row) => row.Id);
  const apiIds = rows.slice(0, 14).map((row) => row.Id);
  const state = { rows, calls, events, waits, nativeIds, apiIds, ms: 0, nativeStarted: false };
  let startup = false;
  const run = (command, args, options = {}) => {
    assert.equal(command, 'docker');
    calls.push({ args: [...args], options, at: state.ms });
    if (startup) beforeCommand?.(state, args, options);
    if (args[0] === 'ps') return rows.map((row) => row.Id).join('\n');
    if (args[0] === 'inspect') return JSON.stringify(rows);
    const selected = args[0] === 'stop' ? args.slice(3) : args.slice(1);
    assert.ok(['stop', 'start'].includes(args[0]));
    if (args[0] === 'start' && selected.some((id) => apiIds.includes(id))) {
      assert.deepEqual(selected, apiIds);
      assert.ok(
        rows.slice(14).every((row) => row.State.Health.Status === 'healthy'),
        'API consumers must remain stopped until both native services are healthy',
      );
    }
    for (const id of selected) {
      const row = rows.find((row) => row.Id === id);
      assert.ok(row);
      row.State.Running = args[0] === 'start';
      row.State.Status = row.State.Running ? 'running' : 'exited';
      if (row.State.Health && args[0] === 'start') row.State.Health.Status = initialHealth;
    }
    if (args[0] === 'start' && selected.some((id) => nativeIds.includes(id)))
      state.nativeStarted = true;
    return '';
  };
  const runtime = createLegacyColdRuntime({
    bindings,
    run,
    now: () => state.ms,
    wait: async (amount) => {
      waits.push({ amount, at: state.ms });
      assert.ok(amount > 0 && amount <= 1000);
      assert.ok(rows.slice(0, 14).every((row) => row.State.Running === false));
      state.ms += amount;
      await onWait?.(state);
    },
    report: (event) => {
      events.push(event);
      report?.(event);
    },
  });
  runtime.inspectRuntime();
  runtime.stopRuntime();
  runtime.readStoppedRuntime();
  startup = true;
  return {
    ...state,
    state,
    runtime,
    starts: () => calls.filter(({ args }) => args[0] === 'start'),
    apiStarts: () =>
      calls.filter(({ args }) => args[0] === 'start' && args.some((id) => apiIds.includes(id))),
  };
}

test('controller waits for both native healthchecks before starting only the captured API IDs', async () => {
  const h = startupHarness({
    onWait: ({ rows, ms }) => {
      rows[14].State.Health.Status = 'healthy';
      if (ms >= 3000) rows[15].State.Health.Status = 'healthy';
    },
  });
  await h.runtime.startBoundRuntime();
  assert.equal(h.state.ms, 3000);
  assert.equal(h.runtime.readRuntimeIdentity().exactGenerationCount, 14);
  assert.equal(h.calls.filter(({ args }) => args[0] === 'stop').length, 1);
  assert.deepEqual(
    h.starts().map(({ args }) => args),
    [
      ['start', ...h.nativeIds],
      ['start', ...h.apiIds],
    ],
  );
  assert.equal(h.apiStarts()[0].at, 3000);
  assert.equal(
    h.calls.some(({ args }) => ['run', 'up', 'create', 'rm'].includes(args[0])),
    false,
  );
});

test('temporary unhealthy native health recovers inside the bound before API start', async () => {
  const h = startupHarness({
    initialHealth: 'unhealthy',
    onWait: ({ rows, ms }) => {
      if (ms >= 2000) for (const row of rows.slice(14)) row.State.Health.Status = 'healthy';
    },
  });
  await h.runtime.startBoundRuntime();
  assert.equal(h.state.ms, 2000);
  assert.equal(h.apiStarts().length, 1);
  assert.equal(h.runtime.readRuntimeIdentity().exactGenerationCount, 14);
});

for (const initialHealth of ['starting', 'unhealthy'])
  test(`permanent ${initialHealth} native state expires without starting API`, async () => {
    const h = startupHarness({ initialHealth });
    await assert.rejects(h.runtime.startBoundRuntime(), /native_startup_deadline/u);
    assert.equal(h.state.ms, 60_000);
    assert.equal(h.apiStarts().length, 0);
    const failure = h.events.find((event) => event.event === 'failed');
    assert.equal(failure.runtimePhase, 'wait_native_health');
    assert.equal(failure.code, 'native_startup_deadline');
    assert.equal(Object.hasOwn(failure, 'command'), false);
  });

for (const [label, mutate, expectedCode = 'native_startup_unproved'] of [
  [
    'replaced native ID',
    (row) => {
      row.Id = 'd'.repeat(64);
    },
  ],
  [
    'changed native image',
    (row) => {
      row.Image = `sha256:${'d'.repeat(64)}`;
    },
  ],
  [
    'paused native',
    (row) => {
      row.State.Paused = true;
    },
  ],
  [
    'restarting native',
    (row) => {
      row.State.Restarting = true;
    },
  ],
  [
    'dead native',
    (row) => {
      row.State.Dead = true;
    },
  ],
  [
    'stopped native',
    (row) => {
      row.State.Running = false;
      row.State.Status = 'exited';
    },
  ],
  [
    'non-running native status',
    (row) => {
      row.State.Status = 'created';
    },
  ],
  [
    'missing native health',
    (row) => {
      delete row.State.Health;
    },
  ],
  [
    'unknown native health',
    (row) => {
      row.State.Health.Status = 'unknown';
    },
  ],
  [
    'changed native configuration',
    (row) => {
      row.Config.Env.push('PRIVATE_TOKEN=private-value');
    },
    'native_boundary_changed',
  ],
  [
    'changed native isolation',
    (row) => {
      row.HostConfig.NetworkMode = 'host';
    },
    'native_boundary_changed',
  ],
  [
    'changed native mount',
    (row) => {
      row.Mounts[0].RW = !row.Mounts[0].RW;
    },
    'native_boundary_changed',
  ],
])
  test(`${label} refuses before API startup and emits no container details`, async () => {
    const h = startupHarness({
      onWait: ({ rows }) => {
        for (const row of rows.slice(14)) row.State.Health.Status = 'healthy';
        mutate(rows[15]);
      },
    });
    await assert.rejects(h.runtime.startBoundRuntime(), { message: expectedCode });
    assert.equal(h.apiStarts().length, 0);
    const failure = h.events.find((event) => event.event === 'failed');
    assert.equal(failure.stage, 'startBoundRuntime');
    assert.equal(failure.runtimePhase, 'wait_native_health');
    assert.equal(failure.code, expectedCode);
    assert.equal(Object.hasOwn(failure, 'command'), false);
    const serialized = JSON.stringify(h.events);
    assert.doesNotMatch(serialized, /PRIVATE_TOKEN|private-value|Config|Mounts|HostConfig/u);
    for (const value of [bindings.targetSha, bindings.targetImageId, ...h.nativeIds])
      assert.equal(serialized.includes(value), false);
  });

for (const observedAt of [60_000, 60_001])
  test(`health observed at ${observedAt} ms cannot authorize API startup`, async () => {
    const h = startupHarness({
      beforeCommand: (state, args) => {
        if (state.nativeStarted && args[0] === 'inspect') {
          state.ms = observedAt;
          for (const row of state.rows.slice(14)) row.State.Health.Status = 'healthy';
        }
      },
    });
    await assert.rejects(h.runtime.startBoundRuntime(), /native_startup_deadline/u);
    assert.equal(h.apiStarts().length, 0);
  });

test('each health inventory command and wait use only the remaining deadline budget', async () => {
  const probes = [];
  const h = startupHarness({
    beforeCommand: (state, args, options) => {
      if (!state.nativeStarted) return;
      assert.ok(['ps', 'inspect'].includes(args[0]));
      assert.ok(Number.isInteger(options.timeout) && options.timeout > 0);
      assert.ok(options.timeout <= 60_000 - state.ms);
      probes.push(args[0]);
      state.ms += probes.length === 1 ? 29_000 : probes.length === 2 ? 29_750 : 100;
    },
  });
  await assert.rejects(h.runtime.startBoundRuntime(), /native_startup_deadline/u);
  assert.deepEqual(probes, ['ps', 'inspect', 'ps', 'inspect']);
  assert.deepEqual(h.waits, [
    { at: 58_750, amount: 1000 },
    { at: 59_950, amount: 50 },
  ]);
  assert.equal(h.state.ms, 60_000);
  assert.equal(h.apiStarts().length, 0);
});

for (const [runtimePhase, command, shouldFail] of [
  ['stopped_inventory', 'ps', (state, args) => !state.nativeStarted && args[0] === 'ps'],
  ['stopped_inventory', 'inspect', (state, args) => !state.nativeStarted && args[0] === 'inspect'],
  ['start_native', 'start', (state, args) => !state.nativeStarted && args[0] === 'start'],
  ['wait_native_health', 'ps', (state, args) => state.nativeStarted && args[0] === 'ps'],
  ['wait_native_health', 'inspect', (state, args) => state.nativeStarted && args[0] === 'inspect'],
  ['start_api', 'start', (state, args) => state.nativeStarted && args[0] === 'start'],
])
  test(`${runtimePhase} ${command} failure retains the original error and only safe process fields`, async () => {
    const original = Object.assign(new Error('private-command-and-token'), {
      code: 'ETIMEDOUT',
      status: 7,
      signal: 'SIGTERM',
      stdout: 'private-output',
      stderr: 'private-error',
      spawnargs: ['private-argument'],
    });
    const h = startupHarness({
      initialHealth: 'healthy',
      beforeCommand: (state, args) => {
        if (shouldFail(state, args)) throw original;
      },
      report: () => {
        throw new Error('diagnostic-write-failed');
      },
    });
    await assert.rejects(h.runtime.startBoundRuntime(), (error) => error === original);
    const failure = h.events.find((event) => event.event === 'failed');
    assert.equal(failure.stage, 'startBoundRuntime');
    assert.equal(failure.runtimePhase, runtimePhase);
    assert.equal(failure.command, command);
    assert.equal(failure.code, 'unclassified_failure');
    assert.equal(failure.spawnCode, 'ETIMEDOUT');
    assert.equal(failure.exitCode, 7);
    assert.equal(failure.signal, 'SIGTERM');
    assert.doesNotMatch(JSON.stringify(h.events), /private-|spawnargs|stdout|stderr/u);
    assert.ok(h.rows.slice(0, 14).every((row) => row.State.Running === false));
  });

test('unreviewed process metadata is excluded from startup diagnostics', async () => {
  const original = Object.assign(new Error('private-message'), {
    code: 'private-spawn-code',
    status: 999,
    signal: 'private-signal',
  });
  const h = startupHarness({
    beforeCommand: () => {
      throw original;
    },
  });
  await assert.rejects(h.runtime.startBoundRuntime(), (error) => error === original);
  const failure = h.events.find((event) => event.event === 'failed');
  assert.equal(failure.code, 'unclassified_failure');
  assert.notEqual(failure.exitCode, 999);
  assert.doesNotMatch(JSON.stringify(h.events), /private-/u);
});

test('diagnostic property getters cannot replace the original startup failure', async () => {
  const original = new Error('native_startup_unproved');
  for (const key of ['message', 'code', 'status', 'signal', 'cause'])
    Object.defineProperty(original, key, {
      get() {
        throw new Error('private-getter');
      },
    });
  const h = startupHarness({
    beforeCommand: () => {
      throw original;
    },
  });
  await assert.rejects(h.runtime.startBoundRuntime(), (error) => error === original);
  assert.equal(h.apiStarts().length, 0);
  assert.doesNotMatch(JSON.stringify(h.events), /private-getter/u);
});
