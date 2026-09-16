import assert from 'node:assert/strict';
import test from 'node:test';
import { chatSettingsSchema, stopWordsPolicySchema } from '@maxim/contracts/settings';
import { prepareStopWordsInput } from '../src/lib/stop-words-editor';
import { updateSettings } from '../src/lib/api/chat-settings-client';

function preview(words: string, domains = '', count = 0) {
  let id = 0;
  const policy = stopWordsPolicySchema.parse({
    rules: Array.from({ length: count }, (_, index) => ({
      id: 'old-' + index,
      kind: 'WORD',
      value: 'word' + index,
    })),
  });
  return prepareStopWordsInput(policy, words, domains, () => 'new-' + id++);
}
test('input keeps complete phrases and reports normalized duplicates', () => {
  const result = preview('Доход без вложений, casino\nCASINO');
  assert.deepEqual(
    result.policy.rules.map((rule) => rule.value),
    ['Доход без вложений', 'casino'],
  );
  assert.deepEqual(result.duplicates, ['casino']);
});
test('invalid entries and overflow never partially change the policy', () => {
  const invalid = preview('casino, и/в');
  assert.equal(invalid.policy.rules.length, 0);
  assert.ok(invalid.errors.length);
  const overflow = preview('casino, ставки', '', 998);
  assert.equal(overflow.policy.rules.length, 998);
  assert.ok(overflow.errors.length);
});
test('mixed word and domain buffers are applied atomically', () => {
  const result = preview('casino', 'bad_domain.example');
  assert.equal(result.policy.rules.length, 0);
  assert.ok(result.errors.length);
});
test('parent and child domain rules remain explicitly recoverable', () => {
  assert.deepEqual(preview('', 'sub.example.com, example.com').policy.domains, [
    'sub.example.com',
    'example.com',
  ]);
});

test('ordinary settings writes do not transport read-only stop-list state', async () => {
  const settings = chatSettingsSchema.parse({
    stopWordsPolicy: stopWordsPolicySchema.parse({ enabled: true }),
    stopWordsRevision: 7,
    messageLimitsBlockedWords: ['legacy'],
  });
  let payload: Record<string, unknown> = {};
  const api = {
    request: async (_path: string, init: RequestInit) => {
      payload = JSON.parse(String(init.body));
      return settings;
    },
  };
  const saved = await updateSettings(api as never, 'chat-1', settings);
  for (const key of [
    'stopWordsPolicy',
    'stopWordsRevision',
    'messageLimitsBlockedWords',
    'messageLimitsBlockedDomains',
    'messageLimitsImageTextScanEnabled',
  ])
    assert.ok(!Object.hasOwn(payload, key));
  assert.deepEqual(saved.stopWordsPolicy, settings.stopWordsPolicy);
});

test('valid list edits remain possible while unrelated action fields are incomplete', () => {
  const policy = stopWordsPolicySchema.parse({});
  policy.sanctions.botButtonEnabled = true;
  const result = prepareStopWordsInput(policy, 'casino', '', () => 'new-rule');
  assert.deepEqual(result.errors, []);
  assert.equal(result.policy.rules[0]?.value, 'casino');
  assert.equal(result.policy.sanctions.botButtonEnabled, true);
});
