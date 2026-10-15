import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import {
  assertFixedModeratorSource,
  FIXED_MODERATOR_SOURCE_CHECKS,
} from './assert-fixed-moderator-source.mjs';
const read = (path) => readFileSync(resolve(import.meta.dirname, '../..', path), 'utf8');
test('fixed assignments retain compatible readers and original object servicing on rollback', () => {
  assert.doesNotThrow(() => assertFixedModeratorSource('a'.repeat(40), read));
});
for (const [path, markers] of FIXED_MODERATOR_SOURCE_CHECKS)
  for (const marker of markers)
    test(`fixed moderator rollback refuses a missing reader: ${path} ${marker}`, () => {
      assert.throws(
        () =>
          assertFixedModeratorSource('a'.repeat(40), (name) =>
            name === path ? read(name).replaceAll(marker, 'removed_reader') : read(name),
          ),
        /lacks fixed moderator readers/,
      );
    });
test('both rollback paths require fixed readers before changing runtime', () => {
  for (const path of [
    'infra/scripts/vps-runtime-rollback.sh',
    'infra/scripts/vps-release-rollback.sh',
  ]) {
    const source = read(path);
    const gate = source.indexOf('maxim_topology_require_fixed_moderator');
    const transition = Math.max(
      source.lastIndexOf('\nbegin_release_runtime_transition\n'),
      source.lastIndexOf('\nbegin_runtime_rollback_transition\n'),
    );
    assert.ok(gate >= 0 && transition > gate, path);
  }
});
