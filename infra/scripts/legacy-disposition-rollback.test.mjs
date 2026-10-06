import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  assertLegacyDispositionSource,
  LEGACY_DISPOSITION_SOURCE_CHECKS,
} from './assert-legacy-disposition-source.mjs';

const root = resolve(import.meta.dirname, '../..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');
test('current exact source has every permanent legacy hold and final effect reader', () => {
  assert.doesNotThrow(() => assertLegacyDispositionSource('a'.repeat(40), read));
});
for (const [path, markers] of LEGACY_DISPOSITION_SOURCE_CHECKS) {
  for (const marker of markers)
    test(`rollback refuses removal of ${path}: ${marker}`, () => {
      assert.throws(
        () =>
          assertLegacyDispositionSource('a'.repeat(40), (sourcePath) =>
            sourcePath === path
              ? read(path).replaceAll(marker, 'removed_reviewed_guard')
              : read(sourcePath),
          ),
        /lacks permanent/u,
      );
    });
}
test('both rollback mechanisms require the hold floor before their release transition', () => {
  for (const path of [
    'infra/scripts/vps-release-rollback.sh',
    'infra/scripts/vps-runtime-rollback.sh',
  ]) {
    const source = read(path);
    const floor = source.indexOf('maxim_topology_require_legacy_dispositions');
    assert.ok(floor >= 0);
    const transition = Math.max(
      source.lastIndexOf('\nbegin_release_runtime_transition\n'),
      source.lastIndexOf('\nbegin_runtime_rollback_transition\n'),
    );
    assert.ok(transition > floor, `${path} must verify its floor before mutating runtime`);
  }
});
test('legacy activation is refused before normal deploy mutations', () => {
  const source = read('infra/scripts/vps-pull-build-up.sh');
  const refusal = source.indexOf('cold_activation_disabled');
  assert.ok(refusal > 0 && refusal < source.indexOf('acquire_deploy_lock\ntrap cleanup'));
  assert.match(source, /--legacy-order-preview=\*/u);
  assert.match(source, /--legacy-order-apply=\*/u);
  assert.doesNotMatch(source, /node infra\/scripts\/multibot-legacy-cold-recovery\.mjs/u);
});
