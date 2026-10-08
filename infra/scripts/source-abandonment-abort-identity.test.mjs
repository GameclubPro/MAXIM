import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { assertLegacyDispositionSource } from './assert-legacy-disposition-source.mjs';
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
  { targetSha: 'd241e50a8b688bdc32380b20d40c2505413c50f1' },
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
  'infra/scripts/legacy-cold-client.mjs',
  'infra/scripts/source-abandonment-absence.cjs',
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

test('actual pinned e7 runtime and reviewed controller base retain both source floors', (t) => {
  const controllerSha = '8b48a9702de516022bc22a8e195f983dbf116cc9';
  const git = (args) =>
    execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    git(['cat-file', '-e', `${ABORT_RUNTIME_SHA}^{commit}`]);
    git(['cat-file', '-e', `${controllerSha}^{commit}`]);
  } catch {
    t.skip('Pinned runtime or reviewed controller history is unavailable in this checkout');
    return;
  }
  const checked = [];
  assert.equal(ABORT_RUNTIME_SHA, 'e7e0066ac724726b42c5cba00bfd8f930673b645');
  assert.equal(
    ABORT_RUNTIME_IMAGE,
    'sha256:c3e6540fa88d5695fb5c875a2baf7a7b7bf0b6c7c2a6907288f5217755727c45',
  );
  const result = readSourceAbandonmentAbortIdentity(
    {
      controllerSha,
      targetSha: ABORT_RUNTIME_SHA,
      protocol: 'source-abandonment-v1',
      operation: 'abort-before-install',
    },
    (command, args) => {
      if (command === 'docker')
        return JSON.stringify([
          {
            Id: ABORT_RUNTIME_IMAGE,
            Config: { Labels: { 'org.opencontainers.image.revision': ABORT_RUNTIME_SHA } },
          },
        ]);
      // FLAG: Model the reviewed controller checkout, not future runtime changes at HEAD.
      // Ancestry, dependency differences and source checks still read the real pinned commits.
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return controllerSha;
      if (args[0] === 'status') return '';
      return git(args);
    },
    (sha, read) => {
      checked.push(sha);
      return assertLegacyDispositionSource(sha, read);
    },
  );
  assert.deepEqual(checked, [ABORT_RUNTIME_SHA, controllerSha]);
  assert.equal(result.controllerSha, controllerSha);
  assert.equal(result.sourceSha, ABORT_RUNTIME_SHA);
  assert.equal(result.imageId, ABORT_RUNTIME_IMAGE);
});
