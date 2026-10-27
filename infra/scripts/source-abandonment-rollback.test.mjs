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
      const source = read(path);
      const changed = source.replaceAll(marker, 'removed_guard');
      assert.notEqual(changed, source, 'mutation must change the actual reviewed source');
      assert.throws(
        () =>
          assertSourceAbandonmentSource('a'.repeat(40), (sourcePath) =>
            sourcePath === path ? changed : read(sourcePath),
          ),
        /lacks permanent/,
      );
    });
}
const forwardPath = 'apps/api/src/webhook/webhook-legacy-forward-source.ts';
function refusesForwardMutation(change, retained) {
  const source = read(forwardPath);
  const changed = change(source);
  assert.notEqual(changed, source, 'mutation must change the actual reviewed source');
  for (const callback of retained)
    assert.ok(changed.includes(callback), 'the independent branch must remain intact');
  assert.throws(
    () =>
      assertSourceAbandonmentSource('a'.repeat(40), (path) =>
        path === forwardPath ? changed : read(path),
      ),
    /lacks permanent.*webhook-legacy-forward-source\.ts/u,
  );
}

test('forward rollback keeps the modern profile selector exact', () => {
  refusesForwardMutation(
    (source) =>
      source.replace(
        "const modern = profile === 'source-abandonment';",
        "const modern = profile !== 'legacy';",
      ),
    [
      'isSourceAbandonmentOuterMarkup(item, message?.link)',
      'isLegacyPostSealOuterMarkup(item, message?.link)',
    ],
  );
});
for (const [body, modern, legacy] of [
  [
    'outer',
    'isSourceAbandonmentOuterMarkup(item, message?.link)',
    'isLegacyPostSealOuterMarkup(item, message?.link)',
  ],
  [
    'linked',
    'isSourceAbandonmentMarkup(item.markup, item.text)',
    'isLegacyPassiveMarkup(item.markup, item.text)',
  ],
]) {
  test(`forward rollback retains the ${body} modern condition with the legacy fallback intact`, () => {
    refusesForwardMutation(
      (source) =>
        source.replace(`modern\n      ? (item) => ${modern}`, `false\n      ? (item) => ${modern}`),
      [legacy],
    );
  });
  test(`forward rollback retains the ${body} modern validator with the legacy fallback intact`, () => {
    refusesForwardMutation((source) => source.replace(modern, legacy), [legacy]);
  });
  test(`forward rollback retains the ${body} legacy profile condition with the modern validator intact`, () => {
    refusesForwardMutation(
      (source) =>
        source.replace(
          `profile === 'legacy-post-seal'\n        ? (item) => ${legacy}`,
          `profile === 'legacy'\n        ? (item) => ${legacy}`,
        ),
      [modern],
    );
  });
  test(`forward rollback retains the ${body} legacy validator with the modern validator intact`, () => {
    refusesForwardMutation((source) => source.replace(legacy, modern), [modern]);
  });
  test(`forward rollback retains the ${body} strict default with both validators intact`, () => {
    refusesForwardMutation(
      (source) =>
        source.replace(
          `? (item) => ${legacy}\n        : undefined`,
          `? (item) => ${legacy}\n        : (item) => true`,
        ),
      [modern, legacy],
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
          ? read(path).replaceAll(
              'inspectSourceAbandonmentAnySource',
              'inspectLegacyRecoverySource',
            )
          : read(path),
      ),
    /lacks permanent.*webhook-source-abandonment\.ts/u,
  );
});
test('rollback refuses a human-only reader after authorless channel holds are installed', () => {
  assert.throws(
    () =>
      assertSourceAbandonmentSource('a'.repeat(40), (path) =>
        path.endsWith('webhook-source-abandonment-channel.ts')
          ? read(path).replace(
              'inspectChannelAuthorlessSource(owner, onRefusal, settings, postSeal)',
              'inspectSourceAbandonmentSource(owner, onRefusal, settings)',
            )
          : read(path),
      ),
    /lacks permanent.*webhook-source-abandonment-channel\.ts/u,
  );
});
test('rollback refuses to reconstruct a synthetic author for a held channel', () => {
  assert.throws(
    () =>
      assertSourceAbandonmentSource('a'.repeat(40), (path) =>
        path.endsWith('webhook-source-abandonment.ts')
          ? read(path).replace(
              '{ sourceProfile: SOURCE_ABANDONMENT_CHANNEL_PROFILE, userId: null }',
              "{ sourceProfile: SOURCE_ABANDONMENT_CHANNEL_PROFILE, userId: 'invented' }",
            )
          : read(path),
      ),
    /lacks permanent.*webhook-source-abandonment\.ts/u,
  );
});
test('rollback retains direct media recognition in the modern owner and late mirror profile', () => {
  assert.throws(
    () =>
      assertSourceAbandonmentSource('a'.repeat(40), (path) =>
        path.endsWith('webhook-source-abandonment-media.ts')
          ? read(path).replace('if (isLegacyDirectMedia(value)) return true;', '')
          : read(path),
      ),
    /lacks permanent.*webhook-source-abandonment-media\.ts/u,
  );
});

test('rollback retains explicit-only strict linked reply audio admission', () => {
  assert.throws(
    () =>
      assertSourceAbandonmentSource('a'.repeat(40), (path) =>
        path.endsWith('webhook-source-abandonment-media.ts')
          ? read(path).replace("purpose === 'SOURCE_ABANDONMENT' && ", '')
          : read(path),
      ),
    /lacks permanent.*webhook-source-abandonment-media\.ts/u,
  );
});
for (const target of ['owner', 'event']) {
  test(`rollback retains the v6 pristine reader for ${target}`, () => {
    assert.throws(
      () =>
        assertSourceAbandonmentSource('a'.repeat(40), (path) =>
          path.endsWith('webhook-pristine-discard.ts')
            ? read(path).replace(
                `inspectPristineOperatorDiscardSource(${target}, settings ?? undefined)`,
                `inspectSourceAbandonmentSource(${target}, undefined, settings ?? undefined)`,
              )
            : read(path),
        ),
      /lacks permanent.*webhook-pristine-discard\.ts/u,
    );
  });
}
