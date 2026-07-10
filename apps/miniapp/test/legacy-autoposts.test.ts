import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildLegacyAutopostSettingsPath,
  resolveRequestedBroadcastWorkspace,
} from '../src/features/publications/legacy-autoposts';

test('routes legacy autoposts to their existing chat or channel workspace', () => {
  assert.equal(
    buildLegacyAutopostSettingsPath({ entityType: 'chat', sourceChatId: 'chat-1' }),
    '/chat/chat-1/settings?focus=broadcast&workspace=autoposts',
  );
  assert.equal(
    buildLegacyAutopostSettingsPath({ entityType: 'channel', sourceChatId: '-123' }),
    '/channel/-123/settings?focus=broadcast&workspace=autoposts',
  );
});

test('opens the legacy autopost tab only for the broadcast settings route', () => {
  assert.equal(
    resolveRequestedBroadcastWorkspace('?focus=broadcast&workspace=autoposts'),
    'autoposts',
  );
  assert.equal(resolveRequestedBroadcastWorkspace('?focus=rules&workspace=autoposts'), 'compose');
  assert.equal(resolveRequestedBroadcastWorkspace('?focus=broadcast'), 'compose');
});
