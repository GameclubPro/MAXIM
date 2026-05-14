import assert from 'node:assert/strict';
import test from 'node:test';
import { tokenizeTextLinks } from '../src/lib/text-links';

test('tokenizes comment URLs and keeps trailing punctuation outside links', () => {
  assert.deepEqual(
    tokenizeTextLinks('Сайт example.com, доки https://dev.max.ru/docs-api.'),
    [
      { type: 'text', text: 'Сайт ' },
      { type: 'link', text: 'example.com', href: 'https://example.com' },
      { type: 'text', text: ', доки ' },
      {
        type: 'link',
        text: 'https://dev.max.ru/docs-api',
        href: 'https://dev.max.ru/docs-api',
      },
      { type: 'text', text: '.' },
    ],
  );
});

test('does not tokenize emails or numbered list items as comment links', () => {
  assert.deepEqual(tokenizeTextLinks('Почта user@example.com'), [
    { type: 'text', text: 'Почта user@example.com' },
  ]);
  assert.deepEqual(tokenizeTextLinks('1. первый пункт'), [
    { type: 'text', text: '1. первый пункт' },
  ]);
});

test('keeps explicit MAX deep links without rewriting the scheme', () => {
  assert.deepEqual(tokenizeTextLinks('Профиль max://user/123'), [
    { type: 'text', text: 'Профиль ' },
    { type: 'link', text: 'max://user/123', href: 'max://user/123' },
  ]);
});
