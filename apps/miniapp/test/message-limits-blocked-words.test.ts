import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyMessageLimitsBlockedWordsInput,
  mergeMessageLimitsBlockedWords,
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

test('subtractMessageLimitsBlockedWords removes all matching words from a preset', () => {
  const result = subtractMessageLimitsBlockedWords(
    ['казино', 'ставка', 'таро'],
    ['ставка', 'таро'],
  );

  assert.deepEqual(result.removedWords, ['ставка', 'таро']);
  assert.deepEqual(result.nextWords, ['казино']);
});
