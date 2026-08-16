import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createApiRequestError } from '../src/lib/api-request-error';
import {
  findTerminalSettingsLoadError,
  resolveSettingsLoadErrorKind,
} from '../src/lib/settings-load-error';

function createHttpError(status: number, code?: string) {
  return createApiRequestError(
    status,
    JSON.stringify({ statusCode: status, ...(code ? { code } : {}) }),
    `HTTP ${status}`,
  );
}

test('settings load errors distinguish expired auth from denied access', () => {
  assert.equal(resolveSettingsLoadErrorKind(createHttpError(401)), 'auth-expired');
  assert.equal(resolveSettingsLoadErrorKind(createHttpError(403)), 'access-denied');
  assert.equal(
    resolveSettingsLoadErrorKind(createHttpError(403, 'SETTINGS_ACCESS_USER_DENIED')),
    'access-denied',
  );
  assert.equal(
    resolveSettingsLoadErrorKind(createHttpError(403, 'SETTINGS_ACCESS_BOT_DENIED')),
    'access-denied',
  );
  assert.equal(resolveSettingsLoadErrorKind(createHttpError(503)), 'retryable');
});

test('settings security rejections require a relaunch instead of showing access denied', () => {
  assert.equal(
    resolveSettingsLoadErrorKind(createHttpError(403, 'MINIAPP_ORIGIN_REJECTED')),
    'auth-relaunch',
  );
  assert.equal(
    resolveSettingsLoadErrorKind(createHttpError(403, 'MINIAPP_CSRF_REJECTED')),
    'auth-relaunch',
  );
});

test('settings handoff selects the first terminal auth or access error', () => {
  const transient = createHttpError(503);
  const denied = createHttpError(403, 'SETTINGS_ACCESS_USER_DENIED');
  assert.equal(findTerminalSettingsLoadError(transient, denied), denied);
  assert.equal(findTerminalSettingsLoadError(transient), undefined);
});

test('settings auth state closes MAX while access state returns to entity lists', () => {
  const componentSource = readFileSync(
    new URL('../src/components/settings-load-error-state.tsx', import.meta.url),
    'utf8',
  );
  const chatSettingsSource = readFileSync(
    new URL('../src/pages/settings-page.legacy.tsx', import.meta.url),
    'utf8',
  );
  const channelSettingsSource = readFileSync(
    new URL('../src/pages/channel-settings-page.tsx', import.meta.url),
    'utf8',
  );

  assert.match(
    componentSource,
    /Срок входа истёк'[\s\S]*?Нужно открыть приложение заново'[\s\S]*?closeMaxMiniApp\(\)/u,
  );
  assert.match(componentSource, /title="Нет доступа к настройкам"/u);
  assert.match(componentSource, /entityType === 'channel' \? 'канал' : 'чат'/u);
  assert.match(componentSource, /buildManagedEntitiesRoute\(entityType\)/u);
  assert.match(chatSettingsSource, /<SettingsLoadErrorState[\s\S]*?entityType="chat"/u);
  assert.match(channelSettingsSource, /<SettingsLoadErrorState[\s\S]*?entityType="channel"/u);
});
