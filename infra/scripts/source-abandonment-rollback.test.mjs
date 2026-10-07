import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  assertSourceAbandonmentSource,
  SOURCE_ABANDONMENT_SOURCE_CHECKS,
} from './assert-source-abandonment-source.mjs';
const root = resolve(import.meta.dirname, '../..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');
test('source abandonment keeps exact-source proof and final hold readers on rollback', () => {
  assert.doesNotThrow(() => assertSourceAbandonmentSource('a'.repeat(40), read));
});
for (const [path, markers] of SOURCE_ABANDONMENT_SOURCE_CHECKS) {
  for (const marker of markers)
    test(`source rollback refuses ${path}: ${marker}`, () => {
      assert.throws(
        () =>
          assertSourceAbandonmentSource('a'.repeat(40), (sourcePath) =>
            sourcePath === path ? read(path).replaceAll(marker, 'removed_guard') : read(sourcePath),
          ),
        /lacks permanent/,
      );
    });
}
test('modern source rows cannot become a member-wide hold through rollback', () => {
  assert.throws(
    () =>
      assertSourceAbandonmentSource('a'.repeat(40), (path) =>
        path.endsWith('webhook-legacy-hold.service.ts')
          ? read(path).replace(
              '  async hasChatHolds(',
              '  async hasChatHolds(/* webhook_source_abandonments */',
            )
          : read(path),
      ),
    /blanket participant/,
  );
});
test('rollback refuses a legacy content reader after modern previews and replies are supported', () => {
  assert.throws(
    () =>
      assertSourceAbandonmentSource('a'.repeat(40), (path) =>
        path.endsWith('webhook-source-abandonment.ts')
          ? read(path)
              .replaceAll('inspectSourceAbandonmentSource', 'inspectLegacyRecoverySource')
              .replaceAll(
                'inspectSourceAbandonmentPostSealSource',
                'inspectLegacyPostSealTextSource',
              )
          : read(path),
      ),
    /lacks permanent.*webhook-source-abandonment\.ts/u,
  );
});
