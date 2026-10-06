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

test('controller stops and starts only captured IDs, with native services first', () => {
  const rows = legacyColdFleet();
  const calls = [];
  const run = (command, args) => {
    assert.equal(command, 'docker');
    calls.push(args);
    if (args[0] === 'ps') return rows.map((row) => row.Id).join('\n');
    if (args[0] === 'inspect') return JSON.stringify(rows);
    const selected = args[0] === 'stop' ? args.slice(3) : args.slice(1);
    assert.ok(['stop', 'start'].includes(args[0]));
    for (const id of selected) {
      const row = rows.find((row) => row.Id === id);
      assert.ok(row);
      row.State.Running = args[0] === 'start';
      row.State.Status = row.State.Running ? 'running' : 'exited';
    }
    return '';
  };
  const runtime = createLegacyColdRuntime({ bindings, run });
  runtime.inspectRuntime();
  runtime.stopRuntime();
  runtime.readStoppedRuntime();
  runtime.startBoundRuntime();
  assert.equal(runtime.readRuntimeIdentity().exactGenerationCount, 14);
  assert.equal(calls.filter((args) => args[0] === 'stop').length, 1);
  const starts = calls.filter((args) => args[0] === 'start');
  assert.deepEqual(starts[0], ['start', ...rows.slice(14).map((row) => row.Id)]);
  assert.deepEqual(starts[1], ['start', ...rows.slice(0, 14).map((row) => row.Id)]);
  assert.equal(
    calls.some((args) => ['run', 'up', 'create', 'rm'].includes(args[0])),
    false,
  );
});
