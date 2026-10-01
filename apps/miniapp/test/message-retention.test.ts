import assert from 'node:assert/strict';
import test from 'node:test';
import { createPreviewApiTransport } from '../src/lib/api/preview-transport';
import {
  getMessageRetention,
  updateMessageRetention,
} from '../src/lib/api/message-retention-client';
import { PREVIEW_CHAT_ID } from '../src/lib/design-preview';
import {
  isRetentionRevisionConflict,
  isRetentionWriteUncertain,
  retentionDraftReducer,
  retentionEditorState,
} from '../src/pages/settings/settings-message-retention-editor-state';
import { ApiRequestError } from '../src/lib/api-request-error';
import { combineManagedEntityLeaveGuards } from '../src/lib/managed-entity-leave-guards';

test('message retention starts off and persists both modes independently', async () => {
  const api = createPreviewApiTransport();
  const initial = await getMessageRetention(api, PREVIEW_CHAT_ID);
  assert.equal(initial.enabled, false);
  assert.equal(initial.hours, 48);
  const enabled = await updateMessageRetention(api, PREVIEW_CHAT_ID, {
    enabled: true,
    hours: 24,
    expectedRevision: initial.revision,
  });
  assert.equal(enabled.status, 'running');
  const changed = await updateMessageRetention(api, PREVIEW_CHAT_ID, {
    enabled: true,
    hours: 48,
    expectedRevision: enabled.revision,
  });
  assert.equal(changed.hours, 48);
  assert.equal(changed.enabledAt, enabled.enabledAt);
  await assert.rejects(
    updateMessageRetention(api, PREVIEW_CHAT_ID, {
      enabled: false,
      hours: 24,
      expectedRevision: 0,
    }),
  );
  assert.equal((await getMessageRetention(api, PREVIEW_CHAT_ID)).enabled, true);
});

test('retention preview is scoped to one transport and chat', async () => {
  const first = createPreviewApiTransport();
  await updateMessageRetention(first, PREVIEW_CHAT_ID, {
    enabled: true,
    hours: 24,
    expectedRevision: 0,
  });
  assert.equal(
    (await getMessageRetention(createPreviewApiTransport(), PREVIEW_CHAT_ID)).enabled,
    false,
  );
  await assert.rejects(getMessageRetention(first, 'missing-chat'));
});

test('refresh preserves a dirty retention draft and makes revision conflicts explicit', async () => {
  const api = createPreviewApiTransport();
  const initial = await getMessageRetention(api, PREVIEW_CHAT_ID);
  const draft = { enabled: true, hours: 24 as const, expectedRevision: initial.revision };
  assert.deepEqual(retentionEditorState(initial, draft), {
    current: draft,
    dirty: true,
    conflict: false,
  });
  const newer = { ...initial, revision: initial.revision + 1 };
  assert.equal(retentionEditorState(newer, draft).conflict, true);
  assert.equal(retentionEditorState(newer, draft).current?.hours, 24);
  assert.equal(retentionEditorState(newer, null).current?.expectedRevision, newer.revision);
  assert.equal(
    retentionEditorState({ ...newer, enabled: true, hours: 24 }, draft).current?.expectedRevision,
    newer.revision,
  );
});

test('preview conflict does not commit the rejected draft', async () => {
  const api = createPreviewApiTransport({ search: '?retentionScenario=conflict' });
  await assert.rejects(
    updateMessageRetention(api, PREVIEW_CHAT_ID, { enabled: true, hours: 24, expectedRevision: 0 }),
  );
  const state = await getMessageRetention(api, PREVIEW_CHAT_ID);
  assert.equal(state.enabled, false);
  assert.equal(state.revision, 1);
  const saved = await updateMessageRetention(api, PREVIEW_CHAT_ID, {
    enabled: true,
    hours: 24,
    expectedRevision: state.revision,
  });
  assert.equal(saved.enabled, true);
});

test('accepted drafts stay cleared through later remote updates and chat changes', async () => {
  const initial = await getMessageRetention(createPreviewApiTransport(), PREVIEW_CHAT_ID);
  let editor = retentionDraftReducer(
    { chatId: PREVIEW_CHAT_ID, draft: null },
    {
      type: 'edit',
      chatId: PREVIEW_CHAT_ID,
      draft: { enabled: true, hours: 24, expectedRevision: initial.revision },
    },
  );
  const accepted = { ...initial, enabled: true, hours: 24 as const, revision: 1 };
  editor = retentionDraftReducer(editor, {
    type: 'snapshot',
    chatId: PREVIEW_CHAT_ID,
    state: accepted,
  });
  const changedAgain = { ...accepted, hours: 48 as const, revision: 2 };
  editor = retentionDraftReducer(editor, {
    type: 'snapshot',
    chatId: PREVIEW_CHAT_ID,
    state: changedAgain,
  });
  assert.equal(editor.draft, null);
  assert.deepEqual(retentionEditorState(changedAgain, editor.draft), {
    current: { enabled: true, hours: 48, expectedRevision: 2 },
    dirty: false,
    conflict: false,
  });
  editor = retentionDraftReducer(editor, {
    type: 'edit',
    chatId: PREVIEW_CHAT_ID,
    draft: { enabled: false, hours: 24, expectedRevision: 2 },
  });
  editor = retentionDraftReducer(editor, {
    type: 'snapshot',
    chatId: 'other-chat',
    state: initial,
  });
  assert.equal(editor.chatId, 'other-chat');
  assert.equal(editor.draft, null);
});

test('capability conflicts and uncertain writes have different recovery from revision conflicts', () => {
  const capability = new ApiRequestError(409, '{"code":"BOT_CAPABILITY_REQUIRED"}', 'Нет прав');
  const revision = new ApiRequestError(
    409,
    '{"code":"MESSAGE_RETENTION_REVISION_CONFLICT"}',
    'Конфликт',
  );
  assert.equal(isRetentionRevisionConflict(capability), false);
  assert.equal(isRetentionRevisionConflict(revision), true);
  assert.equal(isRetentionRevisionConflict(new ApiRequestError(409, '{}', 'Иной конфликт')), false);
  assert.equal(isRetentionWriteUncertain(capability), false);
  assert.equal(isRetentionWriteUncertain(revision), false);
  assert.equal(isRetentionWriteUncertain(new Error('Reply lost')), true);
  assert.equal(isRetentionWriteUncertain(new ApiRequestError(503, '{}', 'Unavailable')), true);
});

test('nested leave guards preserve the parent guard and stop navigation on a failed save', async () => {
  const events: string[] = [];
  const parent = () => ({
    dirty: true,
    save: async () => {
      events.push('parent');
      return true;
    },
    discard: () => events.push('discard-parent'),
  });
  const child = () => ({
    dirty: true,
    save: async () => {
      events.push('child');
      return false;
    },
    discard: () => events.push('discard-child'),
  });
  const combined = combineManagedEntityLeaveGuards([parent, child]);
  assert.equal(combined.dirty, true);
  assert.equal(await combined.save(), false);
  assert.deepEqual(events, ['child']);
  combined.discard();
  assert.deepEqual(events, ['child', 'discard-parent', 'discard-child']);
  assert.equal(await combineManagedEntityLeaveGuards([parent]).save(), true);
});
