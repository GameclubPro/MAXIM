import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  assertNightModeRecoverySource,
  NIGHT_MODE_RECOVERY_SOURCE_CHECKS,
} from './assert-night-mode-recovery-source.mjs';

const read = (path) => readFileSync(resolve(import.meta.dirname, '../..', path), 'utf8');

test('night-mode rollback accepts the durable independent recovery reader', () => {
  assert.doesNotThrow(() => assertNightModeRecoverySource('a'.repeat(40), read));
});

for (const [path, markers] of NIGHT_MODE_RECOVERY_SOURCE_CHECKS) {
  for (const marker of markers) {
    test(`night-mode rollback rejects missing capability ${path}: ${marker}`, () => {
      assert.throws(
        () =>
          assertNightModeRecoverySource('a'.repeat(40), (name) =>
            name === path ? read(name).replaceAll(marker, 'removed_reader') : read(name),
          ),
        /lacks independent night-mode recovery readers/u,
      );
    });
  }
}

test('night-mode source gate refuses a non-exact revision before reading it', () => {
  assert.throws(
    () => assertNightModeRecoverySource('main', () => assert.fail('must not read')),
    /Exact source SHA required/u,
  );
});

test('both API rollback paths check recovery before beginning a runtime transition', () => {
  for (const path of [
    'infra/scripts/vps-runtime-rollback.sh',
    'infra/scripts/vps-release-rollback.sh',
  ]) {
    const source = read(path);
    const gate = source.indexOf('maxim_topology_require_night_mode_recovery_reader');
    const transition = Math.max(
      source.lastIndexOf('\nbegin_release_runtime_transition\n'),
      source.lastIndexOf('\nbegin_runtime_rollback_transition\n'),
    );
    assert.ok(gate >= 0 && transition > gate, path);
    assert.ok(source.includes('maxim_topology_require_commercial_ai_pool_delete_reader'), path);
    assert.ok(source.includes('maxim_topology_require_exact_statistics_rollup_reader'), path);
  }
});
