import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { formatVkSourceProblem, normalizeApiError } from '../src/components/vk-parsing/format';

const vkParsingCss = readFileSync(new URL('../src/styles/vk-parsing.css', import.meta.url), 'utf8');

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
    'VK временно ограничил запросы. Повторите позже.',
  );
  assert.equal(normalizeApiError(new Error('Failed to fetch')), 'Нет связи с сервисом. Повторите.');
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

test('VK formatting tools wrap into stable rows on 320px viewports', () => {
  assert.match(
    vkParsingCss,
    /@media \(max-width: 380px\) \{[\s\S]*?\.vk-parsing-editor__format-tools \{[\s\S]*?min-height: 97px;[\s\S]*?grid-template-columns: repeat\(4, minmax\(40px, 1fr\)\);[\s\S]*?overflow-x: visible;/u,
  );
});
