import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ABORT_RUNTIME_SHA,
  ABORT_RUNTIME_IMAGE,
  readSourceAbandonmentAbortIdentity,
} from './source-abandonment-abort-identity.mjs';
function fixture() {
  const context = {
    controllerSha: 'c'.repeat(40),
    targetSha: ABORT_RUNTIME_SHA,
    protocol: 'source-abandonment-v1',
    operation: 'abort-before-install',
  };
  const state = {
    changes: 'infra/scripts/source-abandonment-abort.mjs',
    image: ABORT_RUNTIME_IMAGE,
    calls: [],
  };
  const run = (command, args) => {
    state.calls.push([command, ...args]);
    if (command === 'git') {
      if (args[0] === 'rev-parse') return context.controllerSha;
      if (args[0] === 'diff') return state.changes;
      return '';
    }
    return JSON.stringify([
      {
        Id: state.image,
        Config: { Labels: { 'org.opencontainers.image.revision': ABORT_RUNTIME_SHA } },
      },
    ]);
  };
  return { context, state, read: () => readSourceAbandonmentAbortIdentity(context, run, () => {}) };
}
test('abort attests only the frozen runtime and a controller descended from the reviewed base', () => {
  const h = fixture();
  assert.equal(h.read().imageId, ABORT_RUNTIME_IMAGE);
  assert.equal(h.state.calls.filter(([cmd, op]) => cmd === 'git' && op === 'merge-base').length, 2);
});
for (const patch of [
  { operation: 'apply' },
  { operation: 'prepare' },
  { targetSha: 'd'.repeat(40) },
  { protocol: 'legacy' },
])
  test(`abort identity refuses ${JSON.stringify(patch)}`, () => {
    const h = fixture();
    Object.assign(h.context, patch);
    assert.throws(h.read);
    assert.equal(h.state.calls.length, 0);
  });
for (const path of [
  'infra/scripts/legacy-cold-runtime.mjs',
  'infra/scripts/webhook-queue-rollout-control.cjs',
  'apps/api/src/scripts/source-abandonment-store.ts',
  'package-lock.json',
])
  test(`abort rejects changed runtime dependency ${path}`, () => {
    const h = fixture();
    h.state.changes = path;
    assert.throws(h.read, /abort_dependency_changed/);
    assert(!h.state.calls.some(([cmd]) => cmd === 'docker'));
  });
test('abort refuses a drifted immutable image', () => {
  const h = fixture();
  h.state.image = `sha256:${'f'.repeat(64)}`;
  assert.throws(h.read, /immutable_abort_runtime_required/);
});
