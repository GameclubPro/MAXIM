import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MESSAGE_LIMITS_BLOCKED_WORD_PRESETS,
  type MessageLimitsBlockedWordPreset,
} from '../src/lib/message-limits-blocked-word-presets';
import {
  applyMessageLimitsBlockedWordsInput,
  applyMessageLimitsBlockedDomainsInput,
  mergeMessageLimitsBlockedDomains,
  mergeMessageLimitsBlockedWords,
  normalizeMessageLimitsBlockedDomains,
  splitMessageLimitsBlockedWordsInput,
  subtractMessageLimitsBlockedWords,
} from '../src/lib/message-limits-blocked-words';

test('splitMessageLimitsBlockedWordsInput keeps add and remove operations', () => {
  assert.deepEqual(splitMessageLimitsBlockedWordsInput('казино +ставка -таро'), [
    { operation: 'add', word: 'казино' },
    { operation: 'add', word: 'ставка' },
    { operation: 'remove', word: 'таро' },
  ]);
});

test('applyMessageLimitsBlockedWordsInput can remove and add words in one pass', () => {
  const result = applyMessageLimitsBlockedWordsInput(['казино', 'таро'], '-таро +ставка', 500);

  assert.deepEqual(result.removedWords, ['таро']);
  assert.deepEqual(result.addedWords, ['ставка']);
  assert.deepEqual(result.nextWords, ['казино', 'ставка']);
});

test('mergeMessageLimitsBlockedWords respects the max size and skips duplicates', () => {
  const result = mergeMessageLimitsBlockedWords(['казино'], ['казино', 'ставка', 'таро'], 2);

  assert.deepEqual(result.addedWords, ['ставка']);
  assert.deepEqual(result.nextWords, ['казино', 'ставка']);
});

test('blocked domains normalize urls and collapse covered subdomains', () => {
  assert.deepEqual(
    normalizeMessageLimitsBlockedDomains([
      'https://www.casino.example/path',
      'promo.casino.example',
      'casino.example',
      'bad.test',
    ]),
    ['casino.example', 'bad.test'],
  );
});

test('applyMessageLimitsBlockedDomainsInput can remove and add domains', () => {
  const result = applyMessageLimitsBlockedDomainsInput(
    ['old.example', 'promo.casino.example'],
    '-old.example +https://casino.example/landing',
    10,
  );

  assert.deepEqual(result.removedDomains, ['old.example']);
  assert.deepEqual(result.addedDomains, ['casino.example']);
  assert.deepEqual(result.nextDomains, ['casino.example']);
});

test('mergeMessageLimitsBlockedDomains respects parent domain coverage', () => {
  const result = mergeMessageLimitsBlockedDomains(
    ['casino.example'],
    ['promo.casino.example', 'spam.example'],
    2,
  );

  assert.deepEqual(result.addedDomains, ['spam.example']);
  assert.deepEqual(result.nextDomains, ['casino.example', 'spam.example']);
});

test('subtractMessageLimitsBlockedWords removes all matching words from a preset', () => {
  const result = subtractMessageLimitsBlockedWords(
    ['казино', 'ставка', 'таро'],
    ['ставка', 'таро'],
  );

  assert.deepEqual(result.removedWords, ['ставка', 'таро']);
  assert.deepEqual(result.nextWords, ['казино']);
});

function getPreset(id: MessageLimitsBlockedWordPreset['id']): MessageLimitsBlockedWordPreset {
  const preset = MESSAGE_LIMITS_BLOCKED_WORD_PRESETS.find(
    (item): item is MessageLimitsBlockedWordPreset => item.id === id,
  );

  assert.ok(preset);
  return preset;
}

test('presets stay focused on high-signal stop words instead of broad everyday words', () => {
  const unsafeBroadWords = [
    'ставка',
    'слот',
    'коэффициент',
    'экспресс',
    'доход',
    'вакансия',
    'подработка',
    'удаленка',
    'сигнал',
    'биржа',
    'кошелек',
    'токен',
    'расклад',
    'магия',
    'ритуал',
    'обряд',
    'руна',
  ];
  const allPresetWords = new Set(
    MESSAGE_LIMITS_BLOCKED_WORD_PRESETS.flatMap((preset) => preset.words),
  );

  for (const word of unsafeBroadWords) {
    assert.equal(allPresetWords.has(word), false, `${word} should not be in default presets`);
  }
});

test('presets include current high-signal spam scenarios', () => {
  assert.equal(getPreset('gambling').words.includes('1xbet'), true);
  assert.equal(getPreset('gambling').words.includes('фриспин'), true);
  assert.equal(getPreset('earnings').words.includes('заработокбезвложений'), true);
  assert.equal(getPreset('earnings').words.includes('лайкизаденьги'), true);
  assert.equal(getPreset('crypto').words.includes('p2pсвязка'), true);
  assert.equal(getPreset('crypto').words.includes('сидфраза'), true);
  assert.equal(getPreset('accounts').words.includes('арендааккаунтов'), true);
  assert.equal(getPreset('accounts').words.includes('прогреваккаунтов'), true);
});

test('tarot preset uses full service markers instead of broad personal-name or ritual stems', () => {
  const tarotPreset = MESSAGE_LIMITS_BLOCKED_WORD_PRESETS.find(
    (preset): preset is MessageLimitsBlockedWordPreset => preset.id === 'tarot',
  );

  assert.ok(tarotPreset);
  assert.equal(tarotPreset.words.includes('натал'), false);
  assert.equal(tarotPreset.words.includes('натальная'), false);
  assert.equal(tarotPreset.words.includes('натальнаякарта'), true);
  assert.equal(tarotPreset.words.includes('ритуал'), false);
  assert.equal(tarotPreset.words.includes('ритуалналюбовь'), true);
});
