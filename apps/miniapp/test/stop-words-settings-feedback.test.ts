import assert from 'node:assert/strict';
import test from 'node:test';
import type { ZodIssue } from 'zod';
import { mapStopWordsValidationIssues } from '../src/pages/settings/stop-words-settings-feedback';

type Issue = Pick<ZodIssue, 'path' | 'message'>;
const issue = (path: PropertyKey[], message = 'Исправьте значение'): Issue => ({ path, message });

test('nested stop errors map to owning list without losing a full rule or button index', () => {
  const cases = [
    { path: ['stopWordsPolicy', 'rules', 123, 'value'], field: 'stopWordsPolicy.rules' },
    { path: ['stopWordsPolicy', 'domains', 3], field: 'stopWordsPolicy.domains' },
    {
      path: ['stopWordsPolicy', 'sanctions', 'botButtons', 1, 'url'],
      field: 'stopWordsPolicy.sanctions.botButtons',
    },
    {
      path: ['stopWordsPolicy', 'sanctions', 'muteDurationHours'],
      field: 'stopWordsPolicy.sanctions.muteDurationHours',
    },
    {
      path: ['stopWordsPolicy', 'sanctions', 'adminContactButtonUrl'],
      field: 'stopWordsPolicy.sanctions.adminContactButtonUrl',
    },
    {
      path: ['stopWordsPolicy', 'sanctions', 'botMessageText'],
      field: 'stopWordsPolicy.sanctions.botMessageText',
    },
    {
      path: ['stopWordsPolicy', 'sanctions', 'media', 'warning', 'base64'],
      field: 'stopWordsPolicy.sanctions.media.warning',
    },
  ];
  for (const { path, field } of cases) {
    const feedback = mapStopWordsValidationIssues([issue(path)]);
    assert.deepEqual(feedback.errors, { [field]: 'Исправьте значение' });
    assert.deepEqual(feedback.first, { field, path });
    assert.equal(feedback.moduleError, null);
  }
});

test('first error and exact index remain stable when later issues share an owning list', () => {
  const path = ['stopWordsPolicy', 'rules', 123, 'value'];
  const feedback = mapStopWordsValidationIssues([
    issue(path, 'Первое правило'),
    issue(['stopWordsPolicy', 'rules', 5, 'value'], 'Другое правило'),
    issue(['stopWordsPolicy', 'domains', 1], 'Сайт'),
  ]);
  assert.deepEqual(feedback.errors, {
    'stopWordsPolicy.rules': 'Первое правило',
    'stopWordsPolicy.domains': 'Сайт',
  });
  assert.deepEqual(feedback.first, { field: 'stopWordsPolicy.rules', path });
});

test('unknown stop paths fail closed at module level and unrelated settings errors are ignored', () => {
  for (const path of [
    ['stopWordsPolicy'],
    ['stopWordsPolicy', 'version'],
    ['stopWordsPolicy', 'unknown'],
    ['stopWordsPolicy', 'sanctions', 'unknown'],
    ['stopWordsPolicy', 'rules', 2, 'unknown'],
  ]) {
    const feedback = mapStopWordsValidationIssues([issue(path)]);
    assert.deepEqual(feedback.errors, {});
    assert.equal(feedback.first, null);
    assert.equal(typeof feedback.moduleError, 'string');
    assert.ok(feedback.moduleError);
  }
  assert.deepEqual(mapStopWordsValidationIssues([issue(['antiSpamEnabled'])]), {
    errors: {},
    first: null,
    moduleError: null,
  });
});

test('runtime malformed validation payload cannot throw or create arbitrary field keys', () => {
  for (const malformed of [
    null,
    { path: null, message: 'Ошибка' },
    { path: ['stopWordsPolicy', 'rules', -1, 'value'], message: 'Ошибка' },
    { path: ['stopWordsPolicy', '__proto__'], message: 'Ошибка' },
    { path: ['stopWordsPolicy', 'rules', 0, 'value'], message: null },
  ]) {
    const feedback = mapStopWordsValidationIssues([malformed] as unknown as Issue[]);
    assert.deepEqual(feedback.errors, {});
    assert.equal(feedback.first, null);
    assert.ok(feedback.moduleError);
  }
});
