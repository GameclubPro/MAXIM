import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  NetworkSettingsChange,
  NetworkSettingsField,
  NetworkSettingsSection,
} from '@maxim/contracts/network-settings';
import { resolveCommercialSliderProfile } from '@maxim/contracts/settings';
import type { ChatSettingsFieldValues } from '../src/features/network-settings/field-model';
import { settingsSectionPaths } from '../src/features/network-settings/field-registry';
import { createNetworkSettingsFieldAdapter } from '../src/features/network-settings/network-settings-field-bindings';
import {
  setChatBoolean,
  setChatCommercialSensitivity,
  setChatDuplicateAllowedCount,
  setChatDuplicatePreset,
} from '../src/features/network-settings/chat-field-intents';
import { prepareStopWordsLists } from '../src/lib/stop-words-editor';

function fixture(
  section: NetworkSettingsSection,
  common: Record<string, unknown> = {},
  initial: NetworkSettingsChange[] = [],
) {
  const fields: Record<string, NetworkSettingsField> = Object.fromEntries(
    settingsSectionPaths('chat', section).map((path) => [
      path,
      Object.hasOwn(common, path) ? { kind: 'common', value: common[path] } : { kind: 'mixed' },
    ]),
  );
  let changes = initial;
  let publications = 0;
  const errors: Record<string, string> = {};
  return {
    adapter: () =>
      createNetworkSettingsFieldAdapter<ChatSettingsFieldValues>({
        entityType: 'chat',
        section,
        fields,
        changes,
        errors,
        readOnly: false,
        onChanges: (next) => {
          changes = next;
          publications += 1;
        },
        onError: (path, error) => {
          if (error) errors[path] = error;
          else delete errors[path];
        },
      }),
    get changes() {
      return changes;
    },
    get publications() {
      return publications;
    },
    errors,
  };
}

test('mixed duplicate stages preserve recipient thresholds and unrelated authored text', () => {
  const text: NetworkSettingsChange = {
    op: 'set',
    path: 'duplicateBotMessageText',
    value: 'Общий текст',
  };
  const state = fixture('duplicates', {}, [text]);
  setChatBoolean(state.adapter(), 'duplicateMuteEnabled', true);
  assert.deepEqual(state.changes, [text, { op: 'set', path: 'duplicateMuteEnabled', value: true }]);
  assert.deepEqual(state.adapter().read('duplicateWarnMaxCount'), { kind: 'mixed' });
  assert.deepEqual(state.adapter().read('duplicateBanWindowSec'), { kind: 'mixed' });
  assert.equal(state.publications, 1);
  setChatDuplicateAllowedCount(state.adapter(), 3);
  assert.equal(state.publications, 1, 'a common allowance cannot infer missing recipient stages');
});

test('restoring a common value removes its intent and preserves unrelated edits', () => {
  const state = fixture('duplicates', {
    duplicateMuteEnabled: false,
    duplicateBotMessageText: 'Исходный текст',
  });
  state.adapter().setScalar('duplicateMuteEnabled', true);
  state.adapter().setScalar('duplicateBotMessageText', 'Общий текст');
  state.adapter().setScalar('duplicateMuteEnabled', false);
  assert.deepEqual(state.changes, [
    { op: 'set', path: 'duplicateBotMessageText', value: 'Общий текст' },
  ]);
  state.adapter().setScalar('duplicateBotMessageText', 'Исходный текст');
  assert.equal(state.adapter().isDirty(), false);
  assert.deepEqual(state.changes, []);
});

test('equal lists and absent media stay clean while explicit mixed replacements remain', () => {
  const state = fixture('links', { linkBotButtons: [], 'botSpeechMedia.linkBotMessageText': null });
  state.adapter().replaceList('linkBotButtons', []);
  state.adapter().clearMedia('botSpeechMedia.linkBotMessageText');
  assert.deepEqual(state.changes, []);
  state.adapter().replaceList('linkBotButtons', [{ text: 'Сайт', url: 'https://example.com' }]);
  state.adapter().replaceList('linkBotButtons', []);
  assert.deepEqual(state.changes, []);
  const mixed = fixture('links');
  mixed.adapter().replaceList('linkBotButtons', []);
  assert.deepEqual(mixed.changes, [{ op: 'replace', path: 'linkBotButtons', value: [] }]);
});

test('greeting deactivation is atomic and preserves each recipient text, buttons and image', () => {
  const image = { mimeType: 'image/png', base64: 'YQ==', fileName: 'greeting.png' };
  const state = fixture('greeting', { 'botSpeechMedia.greetingBotMessageText': image });
  setChatBoolean(state.adapter(), 'greetingEnabled', false);
  assert.equal(state.publications, 1);
  assert.deepEqual(
    Object.fromEntries(
      state.changes.map((change) => [change.path, change.op === 'clear' ? null : change.value]),
    ),
    {
      greetingEnabled: false,
      greetingBotMessageEnabled: false,
      greetingBotButtonEnabled: false,
      greetingRulesButtonEnabled: false,
    },
  );
  assert.deepEqual(state.adapter().read('greetingBotMessageText'), { kind: 'mixed' });
  assert.deepEqual(state.adapter().read('greetingBotButtons'), { kind: 'mixed' });
  assert.deepEqual(state.adapter().read('botSpeechMedia.greetingBotMessageText'), {
    kind: 'common',
    value: image,
  });
});

test('explicit profiles publish their complete dependency bundle without unrelated intents', () => {
  const commercial = fixture('commercialFilter');
  setChatCommercialSensitivity(commercial.adapter(), 85);
  assert.deepEqual(
    Object.fromEntries(
      commercial.changes.map((change) => [
        change.path,
        change.op === 'clear' ? null : change.value,
      ]),
    ),
    resolveCommercialSliderProfile(85),
  );
  assert.equal(commercial.publications, 1);
  assert.deepEqual(commercial.adapter().read('textFiltersBotMessageText'), { kind: 'mixed' });
  const duplicate = fixture('duplicates');
  setChatDuplicatePreset(duplicate.adapter(), 'STRICT');
  assert.deepEqual(
    duplicate.changes.map((change) => change.path).sort(),
    [
      'duplicateDetectionPreset',
      'duplicateIgnoreLinksEnabled',
      'duplicateIgnorePhonesEnabled',
      'duplicateNearMatchEnabled',
    ].sort(),
  );
  assert.deepEqual(duplicate.adapter().read('duplicateWarnMaxCount'), { kind: 'mixed' });
});

test('empty list is an explicit replacement; revert restores mixed without copying any target', () => {
  const state = fixture('stopWords');
  state.adapter().replaceList('stopWordsPolicy.rules', []);
  assert.deepEqual(state.changes, [{ op: 'replace', path: 'stopWordsPolicy.rules', value: [] }]);
  assert.deepEqual(state.adapter().read('stopWordsPolicy.domains'), { kind: 'mixed' });
  state.adapter().revert('stopWordsPolicy.rules');
  assert.deepEqual(state.changes, []);
  assert.deepEqual(state.adapter().read('stopWordsPolicy.rules'), { kind: 'mixed' });
});

test('standard speech text, media clear and media revert are independent intents', () => {
  const state = fixture('links');
  state.adapter().setScalar('linkBotMessageText', '');
  assert.deepEqual(state.changes, [{ op: 'set', path: 'linkBotMessageText', value: '' }]);
  assert.deepEqual(state.adapter().read('botSpeechMedia.linkBotMessageText'), { kind: 'mixed' });
  state.adapter().clearMedia('botSpeechMedia.linkBotMessageText');
  assert.deepEqual(state.changes, [
    { op: 'set', path: 'linkBotMessageText', value: '' },
    { op: 'clear', path: 'botSpeechMedia.linkBotMessageText' },
  ]);
  state.adapter().revert('botSpeechMedia.linkBotMessageText');
  assert.deepEqual(state.changes, [{ op: 'set', path: 'linkBotMessageText', value: '' }]);
});

test('list-only stop-word parsing preserves phrases and rejects a partially invalid replacement', () => {
  const lists = { rules: [], domains: ['keep.example'] };
  let id = 0;
  const valid = prepareStopWordsLists(
    lists,
    'Доход без вложений; CASINO\ncasino',
    '',
    () => `new-rule-${id++}`,
  );
  assert.deepEqual(
    valid.lists.rules.map((rule) => rule.value),
    ['Доход без вложений', 'CASINO'],
  );
  assert.deepEqual(valid.duplicates, ['casino']);
  assert.deepEqual(valid.lists.domains, ['keep.example']);
  const invalid = prepareStopWordsLists(lists, 'casino', 'bad_domain.example');
  assert.ok(invalid.errors.length);
  assert.equal(invalid.lists, lists);
});
