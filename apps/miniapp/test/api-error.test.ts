import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildApiErrorMessage,
  isSessionExpiredApiMessage,
  isTerminalDialogApiMessage,
} from '../src/lib/api-error';
import { describeUserFacingError } from '../src/lib/user-facing-error';

test('maps 401 responses to the user-facing session-expired message', () => {
  const message = buildApiErrorMessage(401, 'Init data has expired', 'text/plain');

  assert.equal(message, 'Сессия истекла или доступ запрещён. Откройте мини-приложение заново.');
  assert.equal(isSessionExpiredApiMessage(message), true);
});

test('keeps backend access details out of 403 messages', () => {
  const message = buildApiErrorMessage(
    403,
    JSON.stringify({ message: 'Пользователь не является администратором чата.' }),
    'application/json',
  );

  assert.equal(message, 'Сессия истекла или доступ запрещён. Откройте мини-приложение заново.');
});

test('keeps oversized upload errors concise and localized', () => {
  const error = new Error('API request failed: 413 {"message":"Payload Too Large"}');

  assert.equal(
    describeUserFacingError(error, 'Не удалось загрузить файл.'),
    'Файл слишком большой для сервера. Уменьшите размер и повторите.',
  );
});

test('detects raw init-data auth failures as session-expired states', () => {
  assert.equal(isSessionExpiredApiMessage('Init data has expired'), true);
  assert.equal(isSessionExpiredApiMessage('Missing InitData authorization header'), true);
  assert.equal(isSessionExpiredApiMessage('Invalid init data signature'), true);
});

test('treats stale dialog token errors as terminal for comments polling', () => {
  assert.equal(isTerminalDialogApiMessage('Неверный токен кнопки. Откройте диалог заново.'), true);
  assert.equal(
    isTerminalDialogApiMessage('Кнопка устарела. Откройте сообщение и нажмите снова.'),
    true,
  );
  assert.equal(
    isTerminalDialogApiMessage(
      'Сессия истекла или доступ запрещён. Откройте мини-приложение заново.',
    ),
    true,
  );
  assert.equal(isTerminalDialogApiMessage('Не удалось отправить сообщение.'), false);
});

test('keeps technical backend details out of user-facing errors', () => {
  const fallback = 'Не удалось выполнить действие.';

  assert.equal(
    describeUserFacingError(new Error('VK_SERVICE_TOKEN не настроен на сервере.'), fallback),
    fallback,
  );
  assert.equal(
    describeUserFacingError(new Error('Prisma connection pool timeout'), fallback),
    'Нет соединения. Повторите.',
  );
  assert.equal(
    describeUserFacingError(new Error('Failed to fetch'), fallback),
    'Нет соединения. Повторите.',
  );
});

test('preserves concise Russian backend validation messages', () => {
  assert.equal(
    describeUserFacingError(
      new Error('API request failed: 400 {"message":"Укажите название канала."}'),
      'Не удалось выполнить действие.',
    ),
    'Укажите название канала.',
  );
});

test('translates schedule conflict codes without exposing internal names', () => {
  assert.equal(
    describeUserFacingError(
      new Error('BROADCAST_TARGET_SLOT_CONFLICT'),
      'Не удалось выполнить действие.',
    ),
    'Выбранное время занято у одного из получателей.',
  );
  assert.equal(
    describeUserFacingError(new Error('BROADCAST_SLOT_CONFLICT'), 'Не удалось выполнить действие.'),
    'Выбранное время уже занято.',
  );
});
