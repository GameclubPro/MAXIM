import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatVkSourceProblem,
  normalizeApiError,
} from '../src/components/vk-parsing/format';

test('VK errors preserve concise Russian API validation without exposing the transport wrapper', () => {
  assert.equal(
    normalizeApiError(
      new Error('API request failed: 400 {"message":"Укажите ссылку на сообщество."}'),
    ),
    'Укажите ссылку на сообщество.',
  );
  assert.equal(
    normalizeApiError(new Error('API request failed: 500 {"message":"Prisma timeout"}')),
    'Нет связи с сервисом. Повторите.',
  );
});

test('VK errors localize common access, throttling, and network failures', () => {
  assert.equal(
    normalizeApiError(new Error('API request failed: 429 Too Many Requests')),
    'VK временно ограничил запросы. Повторите позже.',
  );
  assert.equal(
    normalizeApiError(new Error('Failed to fetch')),
    'Нет связи с сервисом. Повторите.',
  );
  assert.equal(
    normalizeApiError(new Error('API request failed: 403 Forbidden')),
    'Не удалось подтвердить доступ. Откройте приложение заново.',
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
    'VK временно ограничил обновление. Повторим автоматически.',
  );
  assert.equal(
    formatVkSourceProblem({ ...base, circuitOpenedAt: '2026-07-17T10:00:00.000Z' }),
    'Автопубликация приостановлена.',
  );
  assert.equal(
    formatVkSourceProblem({ ...base, lastError: 'VK_SERVICE_TOKEN is missing' }),
    'Не удалось обновить источник.',
  );
});
