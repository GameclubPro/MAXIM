import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CORRECTIVE_RUNTIME_IMAGE,
  CORRECTIVE_RUNTIME_SHA,
  readSourceAbandonmentCorrectiveIdentity,
} from './source-abandonment-corrective-identity.mjs';

function fixture() {
  const context = {
    controllerSha: 'c'.repeat(40),
    targetSha: CORRECTIVE_RUNTIME_SHA,
    protocol: 'source-abandonment-v1',
    operation: 'apply',
  };
  const state = {
    head: context.controllerSha,
    status: '',
    ancestor: true,
    changes: 'infra/scripts/legacy-cold-host.mjs\ninfra/scripts/legacy-cold-store-adapter.mjs',
    image: CORRECTIVE_RUNTIME_IMAGE,
    revision: CORRECTIVE_RUNTIME_SHA,
    calls: [],
    sourceGuards: [],
  };
  const run = (command, args) => {
    state.calls.push([command, ...args]);
    if (command === 'git') {
      if (args[0] === 'rev-parse') return state.head;
      if (args[0] === 'status') return state.status;
      if (args[0] === 'merge-base') {
        assert.deepEqual(args, [
          'merge-base',
          '--is-ancestor',
          context.targetSha,
          context.controllerSha,
        ]);
        if (!state.ancestor) throw new Error('not_an_ancestor');
        return '';
      }
      if (args[0] === 'diff') {
        assert.deepEqual(args, [
          'diff',
          '--name-only',
          '--no-renames',
          context.targetSha,
          context.controllerSha,
          '--',
        ]);
        return state.changes;
      }
      if (args[0] === 'show') return `source:${args[1]}`;
    }
    assert.deepEqual(
      [command, ...args],
      ['docker', 'image', 'inspect', `maxim-api:${CORRECTIVE_RUNTIME_SHA}`],
    );
    return JSON.stringify([
      {
        Id: state.image,
        Config: { Labels: { 'org.opencontainers.image.revision': state.revision } },
      },
    ]);
  };
  const guard = (sha, read) => {
    state.sourceGuards.push(sha);
    assert.equal(read('apps/api/guard.ts'), `source:${sha}:apps/api/guard.ts`);
  };
  return {
    context,
    state,
    read: () => readSourceAbandonmentCorrectiveIdentity(context, run, guard),
  };
}

test('a distinct exact controller attests the original runtime image and both source guard floors', () => {
  const h = fixture();
  h.context.targetSha = 'e7e0066ac724726b42c5cba00bfd8f930673b645';
  h.state.revision = h.context.targetSha;
  h.state.image = 'sha256:c3e6540fa88d5695fb5c875a2baf7a7b7bf0b6c7c2a6907288f5217755727c45';
  assert.deepEqual(h.read(), {
    controllerSha: h.context.controllerSha,
    sourceSha: CORRECTIVE_RUNTIME_SHA,
    imageId: CORRECTIVE_RUNTIME_IMAGE,
  });
  assert.deepEqual(h.state.sourceGuards, [CORRECTIVE_RUNTIME_SHA, h.context.controllerSha]);
});

for (const patch of [
  { operation: 'prepare' },
  { operation: 'preflight' },
  { operation: 'status' },
  { protocol: 'legacy' },
  { targetSha: 'b'.repeat(40) },
  { targetSha: '9f06dff5d32d6f1bd61ee8fa92f103b043475452' },
  { controllerSha: CORRECTIVE_RUNTIME_SHA },
  { controllerSha: 'main' },
])
  test(`corrective identity rejects an unreviewed operation or runtime ${JSON.stringify(patch)}`, () => {
    const h = fixture();
    Object.assign(h.context, patch);
    assert.throws(h.read, /corrective_context_required/);
    assert.equal(h.state.calls.length, 0);
  });

for (const [field, value] of [
  ['head', 'd'.repeat(40)],
  ['status', ' M infra/scripts/legacy-cold-host.mjs'],
])
  test(`controller ${field} mismatch prevents image access`, () => {
    const h = fixture();
    h.state[field] = value;
    assert.throws(h.read, /clean_exact_controller_source_required/);
    assert(!h.state.calls.some(([command]) => command === 'docker'));
  });

test('an unrelated controller history cannot resume the admitted runtime', () => {
  const h = fixture();
  h.state.ancestor = false;
  assert.throws(h.read, /not_an_ancestor/);
  assert(!h.state.calls.some(([command]) => command === 'docker'));
});

for (const path of [
  'infra/docker-compose.yml',
  'infra/scripts/legacy-cold-protocol.mjs',
  'infra/scripts/legacy-cold-client.mjs',
  'infra/scripts/legacy-cold-runtime.mjs',
  'infra/scripts/legacy-cold-smokes.mjs',
  'infra/scripts/legacy-cold-native-smokes.sh',
  'infra/scripts/lib/deploy-topology.sh',
  'infra/scripts/webhook-queue-rollout-control.cjs',
  'infra/scripts/unreviewed-helper.mjs',
  'scripts/ci/assert-green.mjs',
  'package.json',
  'apps/api/src/scripts/source-abandonment-store.ts',
])
  test(`controller refuses changed dependency ${path}`, () => {
    const h = fixture();
    h.state.changes += `\n${path}`;
    assert.throws(h.read, /corrective_dependency_changed/);
    assert(!h.state.calls.some(([command]) => command === 'docker'));
  });

for (const [field, value] of [
  ['image', `sha256:${'e'.repeat(64)}`],
  ['image', 'sha256:39fd36dfc4cd49dd30bceb7cfaf0bd2ad068b96392762afc4c9fe413191dd306'],
  ['revision', 'f'.repeat(40)],
])
  test(`corrective runtime ${field} drift is refused`, () => {
    const h = fixture();
    h.state[field] = value;
    assert.throws(h.read, /immutable_corrective_runtime_image_required/);
  });
