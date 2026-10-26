import assert from 'node:assert/strict';
import test from 'node:test';
import { createPreviewApiTransport } from '../src/lib/api/preview-transport';
import {
  getMessageRetention,
  updateMessageRetention,
} from '../src/lib/api/message-retention-client';
import { PREVIEW_CHAT_ID } from '../src/lib/design-preview';
import {
  isRetentionOperationConfirmed,
  isRetentionRevisionConflict,
  isRetentionWriteUncertain,
  retentionDraftReducer,
  retentionEditorState,
  retentionErrorMessage,
} from '../src/pages/settings/settings-message-retention-editor-state';
import { ApiRequestError } from '../src/lib/api-request-error';
import { combineManagedEntityLeaveGuards } from '../src/lib/managed-entity-leave-guards';

test('message retention starts off and persists all three modes independently', async () => {
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
  const weekly = await updateMessageRetention(api, PREVIEW_CHAT_ID, {
    enabled: true,
    hours: 168,
    expectedRevision: changed.revision,
  });
  assert.equal(weekly.hours, 168);
  assert.equal(weekly.captureAfter, null);
  assert.equal(weekly.historyStatus, 'running');
  await assert.rejects(
    updateMessageRetention(api, PREVIEW_CHAT_ID, {
      enabled: false,
      hours: 24,
      expectedRevision: 0,
    }),
  );
  assert.equal((await getMessageRetention(api, PREVIEW_CHAT_ID)).enabled, true);
});

test('a repeated retention operation returns its receipt without a second revision', async () => {
  const api = createPreviewApiTransport();
  const request = {
    enabled: true,
    hours: 168 as const,
    expectedRevision: 0,
    operationId: '39d74930-2ef0-483b-952e-89821e20b2b4',
  };
  const saved = await updateMessageRetention(api, PREVIEW_CHAT_ID, request);
  assert.equal(saved.lastOperationId, request.operationId);
  assert.deepEqual(await updateMessageRetention(api, PREVIEW_CHAT_ID, request), saved);
  assert.equal((await getMessageRetention(api, PREVIEW_CHAT_ID)).revision, 1);
  await assert.rejects(updateMessageRetention(api, PREVIEW_CHAT_ID, { ...request, hours: 24 }));
});

test('a connection request is confirmed while cleanup stays off and retries keep its deadline', async () => {
  const api = createPreviewApiTransport();
  const request = {
    enabled: true,
    connectWhenReady: true,
    hours: 168 as const,
    expectedRevision: 0,
    operationId: '981843e9-b0fc-4314-b8dc-8d858915dbf4',
  };
  const pending = await updateMessageRetention(api, PREVIEW_CHAT_ID, request);
  assert.equal(pending.enabled, false);
  assert.equal(pending.connectionRequest?.status, 'pending');
  assert.equal(isRetentionOperationConfirmed(pending, request), true);
  assert.equal(
    isRetentionOperationConfirmed(pending, { ...request, operationId: undefined }),
    false,
  );
  assert.equal(isRetentionOperationConfirmed(pending, { ...request, hours: 24 }), false);
  assert.equal(
    isRetentionOperationConfirmed({ ...pending, connectionRequest: null }, request),
    false,
  );
  assert.deepEqual(await updateMessageRetention(api, PREVIEW_CHAT_ID, request), pending);
  const editor = retentionDraftReducer(
    { chatId: PREVIEW_CHAT_ID, draft: request },
    { type: 'snapshot', chatId: PREVIEW_CHAT_ID, state: pending },
  );
  assert.equal(editor.draft, null);
  assert.equal(retentionEditorState(pending, editor.draft).current?.enabled, false);
});

test('a normal off write cancels pending connection and cannot be mistaken for its acceptance', async () => {
  const api = createPreviewApiTransport();
  const request = {
    enabled: true,
    connectWhenReady: true,
    hours: 24 as const,
    expectedRevision: 0,
    operationId: '5e98b21f-3fc2-4879-b596-910c22e220d2',
  };
  const pending = await updateMessageRetention(api, PREVIEW_CHAT_ID, request);
  const cancelled = await updateMessageRetention(api, PREVIEW_CHAT_ID, {
    enabled: false,
    hours: pending.hours,
    expectedRevision: pending.revision,
    operationId: '611b419c-805b-47da-a46b-ed5ab9d6cbd5',
  });
  assert.equal(cancelled.enabled, false);
  assert.equal(cancelled.connectionRequest, null);
  assert.equal(isRetentionOperationConfirmed(cancelled, request), false);
});

test('an expired accepted connection settles a lost response without claiming enabled cleanup', async () => {
  const pending = await getMessageRetention(createPreviewApiTransport(), PREVIEW_CHAT_ID);
  const request = {
    enabled: true,
    connectWhenReady: true,
    hours: 48 as const,
    expectedRevision: 0,
    operationId: 'c08cb809-6ec0-49ab-b0db-9187a44c4786',
  };
  const expired = {
    ...pending,
    revision: 1,
    lastOperationId: request.operationId,
    connectionRequest: { status: 'expired' as const, expiresAt: new Date(0).toISOString() },
  };
  assert.equal(isRetentionOperationConfirmed(expired, request), true);
  assert.equal(expired.enabled, false);
});

test('reconnecting an enabled policy preserves the explicit intent through an old read', async () => {
  const initial = await getMessageRetention(createPreviewApiTransport(), PREVIEW_CHAT_ID);
  const inaccessible = { ...initial, enabled: true, connectionStatus: 'no_access' as const };
  const request = {
    enabled: true,
    connectWhenReady: true,
    hours: inaccessible.hours,
    expectedRevision: inaccessible.revision,
    operationId: 'dcbf68ad-f894-4a84-bf7c-6020d6d128a6',
  };
  const refreshed = retentionDraftReducer(
    { chatId: PREVIEW_CHAT_ID, draft: request },
    { type: 'snapshot', chatId: PREVIEW_CHAT_ID, state: inaccessible },
  );
  assert.deepEqual(refreshed.draft, request);
  assert.deepEqual(retentionEditorState(inaccessible, refreshed.draft), {
    current: request,
    dirty: true,
    conflict: false,
  });
  const accepted = {
    ...inaccessible,
    enabled: false,
    revision: inaccessible.revision + 1,
    lastOperationId: request.operationId,
    connectionRequest: {
      status: 'pending' as const,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    },
  };
  assert.equal(
    retentionDraftReducer(refreshed, {
      type: 'snapshot',
      chatId: PREVIEW_CHAT_ID,
      state: accepted,
    }).draft,
    null,
  );
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

test('an old read cannot confirm a lost write; its exact operation can be recovered once', async () => {
  const api = createPreviewApiTransport({ search: '?retentionScenario=write-error' });
  const input = {
    enabled: true,
    hours: 24 as const,
    expectedRevision: 0,
    operationId: '58d9c023-e016-46d1-9acc-ab2dd109282d',
  };
  await assert.rejects(updateMessageRetention(api, PREVIEW_CHAT_ID, input));
  const old = await getMessageRetention(api, PREVIEW_CHAT_ID);
  assert.equal(old.revision, 0);
  assert.equal(isRetentionOperationConfirmed(old, input), false);
  assert.equal(isRetentionOperationConfirmed({ ...old, enabled: true, hours: 24 }, input), false);
  const saved = await updateMessageRetention(api, PREVIEW_CHAT_ID, input);
  assert.equal(isRetentionOperationConfirmed(saved, input), true);
  assert.equal(isRetentionOperationConfirmed(saved, { ...input, operationId: undefined }), false);
  assert.equal(isRetentionOperationConfirmed(saved, { ...input, hours: 48 }), false);
  assert.deepEqual(await updateMessageRetention(api, PREVIEW_CHAT_ID, input), saved);
  assert.equal((await getMessageRetention(api, PREVIEW_CHAT_ID)).revision, 1);
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

test('retention feedback explains recovery without exposing raw technical errors', () => {
  const internal = new ApiRequestError(
    503,
    '{"code":"ERASER_UNAVAILABLE"}',
    'SQL failed eraser_postgres:5432',
  );
  assert.equal(
    retentionErrorMessage(internal),
    'Не удалось связаться с ботом. Попробуйте ещё раз чуть позже.',
  );
  assert.equal(
    retentionErrorMessage(new Error('fetch stack trace')),
    retentionErrorMessage(internal),
  );
  assert.match(retentionErrorMessage(new ApiRequestError(401, '{}', 'unauthorized')), /заново/);
  assert.match(
    retentionErrorMessage(
      new ApiRequestError(409, '{"code":"ERASER_CONNECTION_REQUIRED"}', 'internal'),
    ),
    /Добавьте «Ластика»/,
  );
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
