import assert from 'node:assert/strict';
import test from 'node:test';
import { createApiRequestError } from '../src/lib/api-request-error';
import {
  getChatSettingsConcurrentUpdatePresentation,
  parseChatSettingsConcurrentUpdate,
} from '../src/lib/chat-settings-conflict';
import { resolveChatSettingsSaveError } from '../src/lib/chat-settings-save-error';

test('reports a bounded partial bulk settings result without relying on the id sample', () => {
  const error = createApiRequestError(
    409,
    JSON.stringify({
      code: 'CHAT_SETTINGS_CONCURRENT_UPDATE',
      partialApplied: true,
      appliedCount: 37,
      appliedChatIds: ['chat-1', 'chat-2'],
    }),
    'Concurrent update',
  );

  assert.deepEqual(parseChatSettingsConcurrentUpdate(error), {
    partialApplied: true,
    appliedCount: 37,
  });
});

test('ignores unrelated conflicts', () => {
  assert.equal(
    parseChatSettingsConcurrentUpdate(
      createApiRequestError(409, JSON.stringify({ code: 'OTHER_CONFLICT' }), 'Conflict'),
    ),
    null,
  );
});

test('formats partial and untouched concurrent updates for the settings UI', () => {
  assert.deepEqual(
    getChatSettingsConcurrentUpdatePresentation(
      createApiRequestError(
        409,
        JSON.stringify({
          code: 'CHAT_SETTINGS_CONCURRENT_UPDATE',
          partialApplied: true,
          appliedCount: 3,
        }),
        'Concurrent update',
      ),
    ),
    {
      title: 'Часть настроек уже применена',
      description: 'Обновлено чатов: 3. Проверьте результат перед повтором.',
    },
  );

  assert.deepEqual(
    getChatSettingsConcurrentUpdatePresentation(
      createApiRequestError(
        409,
        JSON.stringify({ code: 'CHAT_SETTINGS_CONCURRENT_UPDATE' }),
        'Concurrent update',
      ),
    ),
    {
      title: 'Настройки изменились параллельно',
      description: 'Повторите применение после обновления данных.',
    },
  );
});

test('lazy settings save resolver prepares scoped permission rollback and conflict feedback', () => {
  const permission = resolveChatSettingsSaveError(
    createApiRequestError(
      409,
      JSON.stringify({
        code: 'BOT_CAPABILITY_REQUIRED',
        featureKeys: ['antiSpamEnabled'],
        missingPermissions: ['write'],
      }),
      'Permission required',
    ),
    { antiSpamEnabled: false, greetingEnabled: false },
    ['antiSpamEnabled'],
    true,
  );

  assert.equal(permission?.kind, 'permission');
  if (permission?.kind === 'permission') {
    assert.equal(permission.blocker.canRecheck, true);
    assert.deepEqual(permission.revert?.({ antiSpamEnabled: true, greetingEnabled: true }), {
      antiSpamEnabled: false,
      greetingEnabled: true,
    });
  }

  const concurrent = resolveChatSettingsSaveError(
    createApiRequestError(
      409,
      JSON.stringify({
        code: 'CHAT_SETTINGS_CONCURRENT_UPDATE',
        partialApplied: true,
        appliedCount: 2,
      }),
      'Concurrent update',
    ),
    null,
  );

  assert.deepEqual(concurrent, {
    kind: 'concurrent',
    title: 'Часть настроек уже применена',
    description: 'Обновлено чатов: 2. Проверьте результат перед повтором.',
  });
});
