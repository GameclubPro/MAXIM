import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApiErrorMessage, isSessionExpiredApiMessage } from '../src/lib/api-error';

test('maps 401 responses to the user-facing session-expired message', () => {
  const message = buildApiErrorMessage(401, 'Init data has expired', 'text/plain');

  assert.equal(message, 'Сессия истекла или доступ запрещён. Откройте мини-приложение заново.');
  assert.equal(isSessionExpiredApiMessage(message), true);
});

test('detects raw init-data auth failures as session-expired states', () => {
  assert.equal(isSessionExpiredApiMessage('Init data has expired'), true);
  assert.equal(isSessionExpiredApiMessage('Missing InitData authorization header'), true);
  assert.equal(isSessionExpiredApiMessage('Invalid init data signature'), true);
});
