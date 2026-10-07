import assert from 'node:assert/strict';
import { test } from 'node:test';
import { legacyColdFleet } from './test-fixtures/legacy-cold-fleet.mjs';
import { captureLegacyVkRetirementProof } from './legacy-vk-publish-retirement-proof.mjs';

function fixture() {
  const containers = legacyColdFleet().map((row) => ({
    ...row,
    RestartCount: 0,
    State: { ...row.State, StartedAt: '2026-10-07T07:00:00.000Z' },
  }));
  let dirty = false;
  let source = 'reviewed source';
  const run = (command, args) => {
    if (command === 'git') {
      if (args[0] === 'rev-parse') return 'b'.repeat(40);
      if (args[0] === 'status') return dirty ? ' M runtime.ts' : '';
      if (args[0] === 'merge-base' || args[0] === 'ls-tree') return '';
      if (args[0] === 'show') return source;
    }
    if (command === 'docker') {
      if (args[0] === 'image')
        return JSON.stringify([
          {
            Id: `sha256:${'a'.repeat(64)}`,
            Config: { Labels: { 'org.opencontainers.image.revision': 'b'.repeat(40) } },
          },
        ]);
      if (args[0] === 'ps') return containers.map((row) => row.Id).join('\n');
      if (args[0] === 'inspect') return JSON.stringify(containers);
    }
    throw new Error('unexpected_command');
  };
  return {
    run,
    containers,
    dirty: () => {
      dirty = true;
    },
    producer: () => {
      source = 'VK_PARSING_PUBLISH_QUEUE';
    },
  };
}
test('retirement binds all sixteen exact running generations without consulting a release manifest', () => {
  const f = fixture();
  const first = captureLegacyVkRetirementProof(f.run);
  assert.deepEqual(Object.keys(first).sort(), ['fleetDigest', 'imageId', 'sourceSha']);
  assert.match(first.fleetDigest, /^[0-9a-f]{64}$/u);
  f.containers[0].State.StartedAt = '2026-10-07T07:01:00.000Z';
  assert.notEqual(captureLegacyVkRetirementProof(f.run).fleetDigest, first.fleetDigest);
});
for (const [label, mutate] of [
  ['dirty source', (f) => f.dirty()],
  ['old producer', (f) => f.producer()],
  [
    'replaced image',
    (f) => {
      f.containers[0].Image = `sha256:${'d'.repeat(64)}`;
    },
  ],
  [
    'duplicate role',
    (f) => {
      f.containers.push({ ...f.containers[0], Id: 'd'.repeat(64) });
    },
  ],
  [
    'missing role',
    (f) => {
      f.containers.splice(0, 1);
    },
  ],
  [
    'unhealthy native',
    (f) => {
      f.containers[15].State.Health.Status = 'starting';
    },
  ],
  [
    'unknown restart count',
    (f) => {
      delete f.containers[0].RestartCount;
    },
  ],
])
  test(`retirement refuses ${label}`, () => {
    const f = fixture();
    mutate(f);
    assert.throws(() => captureLegacyVkRetirementProof(f.run));
  });
