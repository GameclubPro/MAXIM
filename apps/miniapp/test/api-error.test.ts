import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildApiErrorMessage,
  isSessionExpiredApiMessage,
  isTerminalDialogApiMessage,
} from '../src/lib/api-error';

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
