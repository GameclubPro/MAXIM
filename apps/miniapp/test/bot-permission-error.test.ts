import assert from 'node:assert/strict';
import test from 'node:test';
import { createApiRequestError } from '../src/lib/api-request-error';
import {
  formatBotPermissionLabel,
  getBotPermissionBlockerLabels,
  parseBotPermissionBlocker,
  revertRejectedFeatureChanges,
} from '../src/lib/bot-permission-error';

test('parses the canonical bot capability blocker without exposing unrelated payload fields', () => {
  const error = createApiRequestError(
    409,
    JSON.stringify({
      code: 'BOT_CAPABILITY_REQUIRED',
      missingPermissions: ['write', 'add_remove_members', 'write'],
      featureKeys: ['antiSpamEnabled'],
      affectedEntities: [{ id: 'chat-1', title: 'Рабочий чат' }],
      checkedAt: '2026-08-30T12:00:00.000Z',
      canRecheck: true,
      botId: 'must-not-be-used-by-ui',
    }),
    'Боту не хватает прав',
  );

  assert.deepEqual(parseBotPermissionBlocker(error), {
    code: 'BOT_CAPABILITY_REQUIRED',
    missingPermissions: ['write', 'add_remove_members'],
    stale: false,
    canRecheck: true,
    features: ['antiSpamEnabled'],
    affectedEntities: [{ id: 'chat-1', title: 'Рабочий чат' }],
  });
});

test('derives useful permission labels from legacy Publisher blockers', () => {
  const writeBlocker = parseBotPermissionBlocker(
    createApiRequestError(
      409,
      JSON.stringify({ code: 'PUBLISHER_SETUP_REQUIRED', blockerCode: 'write_permission_missing' }),
      'Publisher setup required',
    ),
  );
  const adminBlocker = parseBotPermissionBlocker(
    createApiRequestError(
      409,
      JSON.stringify({ code: 'PUBLISHER_SETUP_REQUIRED', blockerCode: 'bot_not_admin' }),
      'Publisher setup required',
    ),
  );

  assert.ok(writeBlocker);
  assert.ok(adminBlocker);
  assert.deepEqual(getBotPermissionBlockerLabels(writeBlocker), ['Отправлять сообщения']);
  assert.deepEqual(getBotPermissionBlockerLabels(adminBlocker), ['Права администратора']);
});

test('permission labels cover canonical MAX member management capability', () => {
  assert.equal(formatBotPermissionLabel('add_remove_members'), 'Управлять участниками');
  assert.equal(formatBotPermissionLabel('can_add_remove_members'), 'Управлять участниками');
  assert.equal(formatBotPermissionLabel('bot_connection'), 'Подключить бота к чату или каналу');
});

test('ignores unrelated and server-side errors', () => {
  assert.equal(
    parseBotPermissionBlocker(
      createApiRequestError(409, JSON.stringify({ code: 'REVISION_CONFLICT' }), 'Conflict'),
    ),
    null,
  );
  assert.equal(
    parseBotPermissionBlocker(
      createApiRequestError(
        500,
        JSON.stringify({ code: 'BOT_CAPABILITY_REQUIRED', missingPermissions: ['write'] }),
        'Failure',
      ),
    ),
    null,
  );
});

test('rolls back only rejected feature keys and preserves disabling changes', () => {
  const persisted = {
    antiSpamEnabled: false,
    nightModeEnabled: false,
    greetingEnabled: true,
    threshold: 3,
  };
  const draft = {
    antiSpamEnabled: true,
    nightModeEnabled: true,
    greetingEnabled: false,
    threshold: 5,
  };

  assert.deepEqual(
    revertRejectedFeatureChanges(draft, persisted, Object.keys(draft) as (keyof typeof draft)[], [
      'antiSpamEnabled',
    ]),
    {
      antiSpamEnabled: false,
      nightModeEnabled: true,
      greetingEnabled: false,
      threshold: 5,
    },
  );
});

test('canonical feature keys roll back inverse switches and enum-based enables', () => {
  const persisted = { photoMessagesEnabled: true, linkPolicy: 'ALLOW' };
  const draft = { photoMessagesEnabled: false, linkPolicy: 'DELETE' };

  assert.deepEqual(
    revertRejectedFeatureChanges(draft, persisted, Object.keys(draft) as (keyof typeof draft)[], [
      'photoMessagesEnabled',
      'linkPolicy',
    ]),
    persisted,
  );
});

test('falls back to rolling back new boolean enables when feature keys are unavailable', () => {
  const persisted = { antiSpamEnabled: false, greetingEnabled: true, threshold: 3 };
  const draft = { antiSpamEnabled: true, greetingEnabled: false, threshold: 5 };

  assert.deepEqual(revertRejectedFeatureChanges(draft, persisted), {
    antiSpamEnabled: false,
    greetingEnabled: false,
    threshold: 5,
  });
});

test('keeps every bounded feature key needed to roll back a full settings save', () => {
  const featureKeys = Array.from({ length: 60 }, (_, index) => `feature${index}`);
  const blocker = parseBotPermissionBlocker(
    createApiRequestError(
      409,
      JSON.stringify({ code: 'BOT_CAPABILITY_REQUIRED', featureKeys }),
      'Боту не хватает прав',
    ),
  );

  assert.deepEqual(blocker?.features, featureKeys);
});
