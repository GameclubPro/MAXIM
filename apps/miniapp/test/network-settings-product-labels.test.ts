import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CHAT_SECTION_FIELDS,
  CHANNEL_SECTION_FIELDS,
  settingsSectionPaths,
} from '../src/features/network-settings/field-registry';
import {
  networkSettingsChangeLabels,
  networkSettingsFieldLabel,
} from '../src/features/network-settings/network-settings-product-labels';

test('every authored chat and channel field has a precise product label', () => {
  for (const section of Object.keys(CHAT_SECTION_FIELDS) as (keyof typeof CHAT_SECTION_FIELDS)[]) {
    for (const path of settingsSectionPaths('chat', section)) {
      assert.doesNotMatch(networkSettingsFieldLabel(path), /Параметр/u, path);
    }
  }
  for (const section of Object.keys(
    CHANNEL_SECTION_FIELDS,
  ) as (keyof typeof CHANNEL_SECTION_FIELDS)[]) {
    for (const path of settingsSectionPaths('channel', section)) {
      assert.doesNotMatch(networkSettingsFieldLabel(path), /Параметр/u, path);
    }
  }
});

test('preview translates enum values only for fields that define those enums', () => {
  assert.equal(
    networkSettingsChangeLabels(
      { path: 'duplicateCompareMode', op: 'set', value: 'TEXT' },
      { kind: 'common', value: 'MESSAGE' },
    ).before,
    'Сообщение целиком',
  );
  assert.equal(
    networkSettingsChangeLabels({ path: 'presentation', op: 'set', value: 'button' }).after,
    'Кнопка',
  );
  assert.equal(
    networkSettingsChangeLabels({ path: 'text', op: 'set', value: 'button' }).after,
    'button',
  );
});

test('preview shows authored time boundaries in the same hours and minutes as their controls', () => {
  const labels = networkSettingsChangeLabels(
    { path: 'nightModeStartTimeMinutes', op: 'set', value: 1385 },
    { kind: 'common', value: 485 },
  );
  assert.equal(labels.before, '08:05');
  assert.equal(labels.after, '23:05');
});

test('preview exposes stop-word state and matching changes even when the phrase is unchanged', () => {
  const rule = {
    id: 'private-rule-id',
    value: 'длинная фраза',
    kind: 'PHRASE',
    enabled: true,
    matchMode: 'EXACT',
  };
  const labels = networkSettingsChangeLabels(
    {
      path: 'stopWordsPolicy.rules',
      op: 'replace',
      value: [{ ...rule, enabled: false, matchMode: 'MASKED' }],
    },
    { kind: 'common', value: [rule] },
  );
  assert.equal(labels.before, 'Фраза · длинная фраза · Включено · Точное совпадение');
  assert.equal(labels.after, 'Фраза · длинная фраза · Выключено · С учётом маскировки');
  assert.doesNotMatch(labels.after, /private-rule-id/u);
  assert.equal(labels.replacement, true);
});
