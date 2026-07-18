import assert from 'node:assert/strict';
import test from 'node:test';
import { createApiRequestError } from '../src/lib/api-request-error';
import {
  buildApiErrorMessage,
  describeApiError,
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

test('preserves structured HTTP error metadata without sensitive payload fields', () => {
  const payload = JSON.stringify({
    statusCode: 409,
    code: 'RESOURCE_REVISION_CONFLICT',
    message: 'Данные уже изменены.',
    currentRevision: 7,
    details: [{ field: 'title' }],
    token: 'must-not-survive',
    nested: { authorization: 'must-not-survive', retryable: true },
  });
  const error = createApiRequestError(
    409,
    payload,
    buildApiErrorMessage(409, payload, 'application/json'),
  );

  assert.equal(error.name, 'ApiRequestError');
  assert.equal(error.status, 409);
  assert.equal(error.code, 'RESOURCE_REVISION_CONFLICT');
  assert.equal(error.message, 'Данные уже изменены.');
  assert.deepEqual(error.payload, {
    statusCode: 409,
    code: 'RESOURCE_REVISION_CONFLICT',
    message: 'Данные уже изменены.',
    currentRevision: 7,
    details: [{ field: 'title' }],
    nested: { retryable: true },
  });
  assert.equal(Object.isFrozen(error.payload), true);
  assert.equal(describeApiError(error, 'Не удалось выполнить действие.'), 'Данные уже изменены.');
});

test('keeps non-JSON HTTP error fallbacks without exposing a structured payload', () => {
  const htmlPayload = '<html>Bad Gateway</html>';
  const plainPayload = 'Некорректный запрос.';
  const htmlError = createApiRequestError(
    502,
    htmlPayload,
    buildApiErrorMessage(502, htmlPayload, 'text/html'),
  );
  const plainError = createApiRequestError(
    400,
    plainPayload,
    buildApiErrorMessage(400, plainPayload, 'text/plain'),
  );

  assert.equal(htmlError.status, 502);
  assert.equal(htmlError.code, null);
  assert.equal(htmlError.payload, null);
  assert.equal(htmlError.message, 'Сервис временно недоступен. Повторите позже.');
  assert.equal(plainError.status, 400);
  assert.equal(plainError.code, null);
  assert.equal(plainError.payload, null);
  assert.equal(plainError.message, 'Некорректный запрос.');
});

test('keeps JSON 5xx internals out of the error while preserving safe metadata', () => {
  const payload = JSON.stringify({
    statusCode: 500,
    code: 'PUBLICATION_INTERNAL_FAILURE',
    message: 'Prisma connection failed for publication secret-id',
    retryable: true,
  });
  const error = createApiRequestError(
    500,
    payload,
    buildApiErrorMessage(500, payload, 'application/json'),
  );

  assert.equal(error.message, 'Ошибка сервера. Повторите позже.');
  assert.equal(error.code, 'PUBLICATION_INTERNAL_FAILURE');
  assert.deepEqual(error.payload, {
    statusCode: 500,
    code: 'PUBLICATION_INTERNAL_FAILURE',
    retryable: true,
  });
  assert.equal(error.message.includes('Prisma'), false);
  assert.equal(error.message.includes('secret-id'), false);
  assert.equal(JSON.stringify(error).includes('Prisma'), false);
  assert.equal(JSON.stringify(error).includes('secret-id'), false);
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
