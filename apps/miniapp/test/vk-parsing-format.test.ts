import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { formatVkSourceProblem, normalizeApiError } from '../src/components/vk-parsing/format';
import { ApiRequestError } from '../src/lib/api-request-error';

const vkParsingCss = readFileSync(new URL('../src/styles/vk-parsing.css', import.meta.url), 'utf8');

test('VK preserves safe structured upstream error codes without exposing internal messages', () => {
  for (const [code, expected] of [
    ['VK_API_VK_14', 'VK требует проверку доступа. Повторите после проверки подключения.'],
    ['VK_API_VK_15', 'Сообщество закрыто или недоступно для подключения VK.'],
    ['VK_API_VK_6', 'VK временно ограничил запросы. Повторите позже.'],
    ['VK_API_TIMEOUT', 'VK не успел ответить. Повторите позже.'],
  ]) {
    const error = new ApiRequestError(
      503,
      JSON.stringify({ code, message: 'internal detail' }),
      'Сервис временно недоступен. Повторите позже.',
    );
    assert.equal(normalizeApiError(error), expected);
  }
  assert.equal(
    normalizeApiError(
      new ApiRequestError(429, '', 'Слишком много запросов. Повторите чуть позже.'),
    ),
    'Слишком много запросов. Повторите позже.',
  );
  assert.equal(
    normalizeApiError(
      new ApiRequestError(
        409,
        JSON.stringify({ code: 'PUBLISHER_SETUP_REQUIRED' }),
        'Publik setup is required for the selected target',
      ),
    ),
    'Публикация недоступна. Проверьте подключение и права Публика.',
  );
});

test('VK errors preserve safe validation without exposing server internals', () => {
  assert.equal(
    normalizeApiError(
      new Error('API request failed: 400 {"message":"Укажите ссылку на сообщество."}'),
    ),
    'Укажите ссылку на сообщество.',
  );
  assert.equal(
    normalizeApiError(new Error('API request failed: 500 {"message":"Prisma timeout"}')),
    'Ошибка сервера. Повторите позже.',
  );
});

test('VK errors localize common access, throttling, and network failures', () => {
  assert.equal(
    normalizeApiError(new Error('API request failed: 429 Too Many Requests')),
    'Слишком много запросов. Повторите позже.',
  );
  assert.equal(normalizeApiError(new Error('Failed to fetch')), 'Нет связи с сервисом. Повторите.');
  assert.equal(
    normalizeApiError(new Error('Сервис не отвечает. Повторите.')),
    'Сервис не успел ответить. Повторите позже.',
  );
  assert.equal(
    normalizeApiError(new Error('API request failed: 403 Forbidden')),
    'Недостаточно прав для этого действия.',
  );
});

test('VK source problems stay actionable without backend diagnostics', () => {
  const base = {
    autoPublishPausedReason: null,
    circuitOpenedAt: null,
    circuitReason: null,
    lastError: null,
    syncStatus: 'IDLE',
  };

  assert.equal(
    formatVkSourceProblem({ ...base, syncStatus: 'BACKOFF' }),
    'Источник временно недоступен. Повторим автоматически.',
  );
  assert.equal(
    formatVkSourceProblem({ ...base, circuitOpenedAt: '2026-07-17T10:00:00.000Z' }),
    'Обновление источника приостановлено после повторных ошибок.',
  );
  assert.equal(
    formatVkSourceProblem({ ...base, syncStatus: 'BACKOFF', lastErrorCode: 'vk_api.vk_6' }),
    'VK временно ограничил обновление. Повторим автоматически.',
  );
  assert.equal(
    formatVkSourceProblem({ ...base, syncStatus: 'ERROR', lastErrorCode: 'vk_api.vk_14' }),
    'VK требует проверку доступа. Обновление источника приостановлено.',
  );
  assert.equal(
    formatVkSourceProblem({ ...base, lastError: 'VK_SERVICE_TOKEN is missing' }),
    'Не удалось обновить источник.',
  );
});

test('VK formatting tools wrap into stable rows on 320px viewports', () => {
  assert.match(
    vkParsingCss,
    /@media \(max-width: 380px\) \{[\s\S]*?\.vk-parsing-editor__format-tools \{[\s\S]*?min-height: 97px;[\s\S]*?grid-template-columns: repeat\(4, minmax\(40px, 1fr\)\);[\s\S]*?overflow-x: visible;/u,
  );
});
