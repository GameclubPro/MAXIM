import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildLegacyAutopostSettingsPath,
  buildLegacyPublicationNavigationState,
  buildLegacyPublicationSettingsPath,
  canOpenLegacyPublication,
  resolveLegacyBroadcastEditorTarget,
  resolveLegacyPublicationReturnPath,
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

test('routes exact legacy publication items to their compatibility editor', () => {
  assert.equal(
    buildLegacyPublicationSettingsPath({
      id: 'rule-1',
      kind: 'autopost',
      source: { chatId: 'chat-1', entityType: 'chat' },
    }),
    '/chat/chat-1/settings?focus=broadcast&legacyKind=autopost&legacyId=rule-1',
  );
  assert.equal(
    buildLegacyPublicationSettingsPath({
      id: 'broadcast-1',
      kind: 'broadcast',
      source: { chatId: '-123', entityType: 'channel' },
    }),
    '/channel/-123/settings?focus=broadcast&legacyKind=broadcast&legacyId=broadcast-1',
  );
});

test('keeps retired autoposts read-only and opens only actionable legacy broadcasts', () => {
  assert.equal(canOpenLegacyPublication({ kind: 'autopost', status: 'PAUSED' }), false);
  assert.equal(canOpenLegacyPublication({ kind: 'autopost', status: 'ERROR' }), false);
  assert.equal(canOpenLegacyPublication({ kind: 'autopost', status: 'COMPLETED' }), false);
  assert.equal(canOpenLegacyPublication({ kind: 'broadcast', status: 'ACTIVE' }), true);
  assert.equal(canOpenLegacyPublication({ kind: 'broadcast', status: 'PARTIAL' }), true);
  assert.equal(canOpenLegacyPublication({ kind: 'broadcast', status: 'FAILED' }), true);
  assert.equal(canOpenLegacyPublication({ kind: 'broadcast', status: 'COMPLETED' }), false);
  assert.equal(canOpenLegacyPublication({ kind: 'broadcast', status: 'CANCELED' }), false);
});

test('keeps a safe return path to the filtered central legacy list', () => {
  const state = buildLegacyPublicationNavigationState(
    '/publications',
    '?legacy=1&legacyView=history&legacyKind=broadcast',
  );
  assert.equal(
    resolveLegacyPublicationReturnPath(state),
    '/publications?legacy=1&legacyView=history&legacyKind=broadcast',
  );
  assert.equal(
    resolveLegacyPublicationReturnPath({ legacyPublicationReturnTo: '/publications' }),
    null,
  );
  assert.equal(
    resolveLegacyPublicationReturnPath({
      legacyPublicationReturnTo: 'https://example.com/publications?legacy=1',
    }),
    null,
  );
});

test('resolves an explicit legacy broadcast editor target only inside broadcast settings', () => {
  assert.deepEqual(
    resolveLegacyBroadcastEditorTarget(
      '?focus=broadcast&legacyKind=autopost&legacyId=autopost-rule-1',
    ),
    { kind: 'autopost', id: 'autopost-rule-1' },
  );
  assert.deepEqual(
    resolveLegacyBroadcastEditorTarget(
      '?focus=broadcast&legacyKind=broadcast&legacyId=managed-broadcast-1',
    ),
    { kind: 'broadcast', id: 'managed-broadcast-1' },
  );
  assert.equal(
    resolveLegacyBroadcastEditorTarget('?focus=rules&legacyKind=broadcast&legacyId=record-1'),
    null,
  );
  assert.equal(resolveLegacyBroadcastEditorTarget('?focus=broadcast&legacyKind=broadcast'), null);
  assert.equal(
    resolveLegacyBroadcastEditorTarget(
      '?focus=broadcast&handoff=1&legacyKind=broadcast&legacyId=record-1',
    ),
    null,
  );
  assert.equal(
    resolveLegacyBroadcastEditorTarget(
      '?focus=broadcast&legacyKind=broadcast&legacyKind=autopost&legacyId=record-1',
    ),
    null,
  );
});
