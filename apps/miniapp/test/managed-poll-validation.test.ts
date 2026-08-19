import assert from 'node:assert/strict';
import test from 'node:test';
import { MANAGED_POLL_MESSAGE_MAX_LENGTH } from '@maxim/contracts/poll';
import { validateManagedPollQuestion } from '../src/lib/managed-poll-validation';
import { renderSupportedMarkdownAsHtml } from '../src/lib/max-markdown';

test('poll markdown validation uses the rendered MAX message length', () => {
  const escapedQuestion = '&'.repeat(2_000);
  const rendered = renderSupportedMarkdownAsHtml(escapedQuestion, { blockMode: 'raw' });

  assert.equal(rendered.length, 10_000);
  assert.equal(
    validateManagedPollQuestion(escapedQuestion, 'markdown'),
    `После форматирования максимум ${MANAGED_POLL_MESSAGE_MAX_LENGTH} символов.`,
  );
  assert.equal(validateManagedPollQuestion(escapedQuestion, 'plain'), '');
});

test('poll markdown validation rejects formatting without visible text', () => {
  assert.equal(validateManagedPollQuestion('** **', 'markdown'), 'Введите вопрос.');
  assert.equal(validateManagedPollQuestion('**Вопрос**', 'markdown'), '');
});
