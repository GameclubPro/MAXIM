import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
test('abort permits the reviewed host pending guard and its focused entrypoint tests', () => {
  const h = fixture();
  h.state.changes = [
    'infra/scripts/lib/legacy-cold-maintenance.sh',
    'infra/scripts/legacy-cold-entrypoint-guards.test.mjs',
  ].join('\n');
  assert.equal(h.read().imageId, ABORT_RUNTIME_IMAGE);
});
for (const patch of [
  { operation: 'apply' },
  { operation: 'prepare' },
  { controllerSha: ABORT_RUNTIME_SHA },
  { targetSha: 'd'.repeat(40) },
  { targetSha: 'd241e50a8b688bdc32380b20d40c2505413c50f1' },
  { targetSha: 'e7e0066ac724726b42c5cba00bfd8f930673b645' },
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
  'infra/scripts/lib/deploy-lock.sh',
  'apps/api/src/scripts/source-abandonment-store.ts',
  'package-lock.json',
])
  test(`abort rejects changed runtime dependency ${path}`, () => {
    const h = fixture();
    h.state.changes = `infra/scripts/lib/legacy-cold-maintenance.sh\n${path}`;
    assert.throws(h.read, /abort_dependency_changed/);
    assert(!h.state.calls.some(([cmd]) => cmd === 'docker'));
  });
test('abort refuses a drifted immutable image', () => {
  const h = fixture();
  h.state.image = `sha256:${'f'.repeat(64)}`;
  assert.throws(h.read, /immutable_abort_runtime_required/);
});

test('retired abort runtime is rejected by the current source floor', (t) => {
  const git = (args) =>
    execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  let controllerSha;
  try {
    git(['cat-file', '-e', `${ABORT_RUNTIME_SHA}^{commit}`]);
    controllerSha = git(['rev-parse', 'HEAD']);
  } catch {
    t.skip('Pinned runtime or current controller history is unavailable in this checkout');
    return;
  }
  assert.equal(ABORT_RUNTIME_SHA, 'b0d3c4e1b437127b985791ea67b7109843988fbb');
  assert.equal(
    ABORT_RUNTIME_IMAGE,
    'sha256:e7f01f71971f7c9c6410151bfcc90d7388c8766ab6a5f919e8f30a7603e6ec2b',
  );
  // FLAG: This historical abort is bound to its original image and must fail
  // closed once installed source profiles require newer readers. Never lower
  // the floor or repin its runtime just to preserve an obsolete abort path.
  git(['merge-base', '--is-ancestor', ABORT_RUNTIME_SHA, controllerSha]);
  assert.throws(
    () =>
      assertLegacyDispositionSource(ABORT_RUNTIME_SHA, (path) =>
        git(['show', `${ABORT_RUNTIME_SHA}:${path}`]),
      ),
    /Rollback target lacks permanent (?:exact-source abandonment readers|legacy disposition readers or final effect guards):/,
  );
});

test('current controller source retains the complete rollback floor before commit', () => {
  const root = resolve(import.meta.dirname, '../..');
  assert.doesNotThrow(() =>
    assertLegacyDispositionSource('a'.repeat(40), (path) =>
      readFileSync(resolve(root, path), 'utf8'),
    ),
  );
});
