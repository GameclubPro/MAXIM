import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { formatPublicationDeliveryError } from '../src/features/publications/publication-delivery-error';

const detailsSheetSource = readFileSync(
  new URL('../src/features/publications/publication-details-sheet.tsx', import.meta.url),
  'utf8',
);

test('keeps concise Russian delivery reasons', () => {
  assert.equal(
    formatPublicationDeliveryError('Администратор подтвердил, что сообщение не было опубликовано.'),
    'Администратор подтвердил, что сообщение не было опубликовано.',
  );
  assert.equal(
    formatPublicationDeliveryError('MAX принял запрос, но ответ не получен.'),
    'MAX принял запрос, но ответ не получен.',
  );
  assert.equal(
    formatPublicationDeliveryError('  Публикация остановлена до отправки.  '),
    'Публикация остановлена до отправки.',
  );
  assert.equal(formatPublicationDeliveryError('   '), null);
});

test('maps known runtime failures without exposing transport details', () => {
  assert.equal(
    formatPublicationDeliveryError('MAX response timeout ETIMEDOUT'),
    'MAX временно не ответил.',
  );
  assert.equal(
    formatPublicationDeliveryError('platform rate limit exceeded: 429'),
    'MAX временно ограничил отправку.',
  );
  assert.equal(
    formatPublicationDeliveryError('403 Forbidden: bot is not an admin'),
    'Нет доступа для отправки.',
  );
  assert.equal(
    formatPublicationDeliveryError('attachment.not.ready during media upload'),
    'Не удалось подготовить медиа.',
  );
});

test('replaces internal, sensitive, and malformed stored errors with a safe fallback', () => {
  const unsafeReasons = [
    'Prisma connection pool timeout for publication abc',
    '{"message":"Внутренняя ошибка","token":"secret"}',
    'Ошибка запроса https://internal.example/api?token=secret',
    'Внутренняя ошибка request_id 6ba7b810-9dad-11d1-80b4-00c04fd430c8',
    'MAX response timeout ETIMEDOUT requestId=secret',
    'Ошибка выполнения\n    at send (/app/src/publication.ts:42:3)',
    'Внутренняя ошибка сервера при доставке на 10.0.0.1',
    'Служебная причина для получателя 123 456 789',
    'Internal delivery failure',
    `Слишком длинная причина ${'безопасный текст '.repeat(20)}`,
  ];

  for (const reason of unsafeReasons) {
    assert.equal(formatPublicationDeliveryError(reason), 'Не удалось доставить публикацию.');
  }
});

test('publication details never renders stored lastError directly', () => {
  assert.match(detailsSheetSource, /formatPublicationDeliveryError\(delivery\.lastError\)/u);
  assert.doesNotMatch(detailsSheetSource, /\{delivery\.lastError\}/u);
});
