import assert from 'node:assert/strict';
import test from 'node:test';
import { createEmptyPublicationDraft } from '../src/features/publications/publication-model';
import {
  PUBLICATION_TEST_RESULT_PENDING_FEEDBACK,
  arePublicationRequestKeysEqual,
  buildPublicationActionRequestKey,
  buildPublicationAmbiguousRequestKey,
  buildPublicationRetryRequestKey,
  buildPublicationSaveRequestKey,
  buildPublicationTestRequestKey,
  fingerprintPublicationRequestKey,
  isPublicationTestResultPendingError,
  resolvePublicationCreateRequestIdentity,
  resolvePublicationRequestIdentity,
  type PublicationRequestIdentity,
  type PublicationRequestKey,
} from '../src/features/publications/publication-request-identity';

const chatTarget = {
  id: 'chat-1',
  entityType: 'chat' as const,
  title: 'Чат',
  avatarUrl: null,
};
const channelTarget = {
  id: 'channel-1',
  entityType: 'channel' as const,
  title: 'Канал',
  avatarUrl: null,
};

function createIdentityResolver() {
  let sequence = 0;
  return (
    current: PublicationRequestIdentity | null,
    key: PublicationRequestKey,
  ): PublicationRequestIdentity =>
    resolvePublicationRequestIdentity(current, key, () => `request-id-${++sequence}`);
}

test('reuses a save request ID until payload, context, or replacement intent changes', () => {
  const draft = createEmptyPublicationDraft([chatTarget]);
  draft.title = 'План';
  draft.text = 'Текст';
  draft.timingMode = 'once';
  draft.scheduledSlots = ['2026-08-01T10:00:00.000Z'];
  const resolveIdentity = createIdentityResolver();

  const initialKey = buildPublicationSaveRequestKey(draft, { kind: 'create' }, false);
  const initial = resolveIdentity(null, initialKey);
  const unchanged = resolveIdentity(
    initial,
    buildPublicationSaveRequestKey(draft, { kind: 'create' }, false),
  );
  assert.equal(unchanged.requestId, initial.requestId);

  draft.title = '  План  ';
  const normalizedTitle = resolveIdentity(
    unchanged,
    buildPublicationSaveRequestKey(draft, { kind: 'create' }, false),
  );
  assert.equal(normalizedTitle.requestId, initial.requestId);

  const replacement = resolveIdentity(
    normalizedTitle,
    buildPublicationSaveRequestKey(draft, { kind: 'create' }, true),
  );
  assert.notEqual(replacement.requestId, initial.requestId);

  const duplicateContext = resolveIdentity(
    replacement,
    buildPublicationSaveRequestKey(draft, { kind: 'duplicate' }, true),
  );
  assert.notEqual(duplicateContext.requestId, replacement.requestId);

  draft.text = 'Новая версия';
  const changedPayload = resolveIdentity(
    duplicateContext,
    buildPublicationSaveRequestKey(draft, { kind: 'duplicate' }, true),
  );
  assert.notEqual(changedPayload.requestId, duplicateContext.requestId);

  const changedEndpoint = resolveIdentity(
    changedPayload,
    buildPublicationSaveRequestKey(
      draft,
      { kind: 'edit', publicationId: 'publication-1', expectedRevision: 2 },
      true,
    ),
  );
  assert.notEqual(changedEndpoint.requestId, changedPayload.requestId);
});

test('rotates the request ID after a confirmed success clears the current identity', () => {
  const draft = createEmptyPublicationDraft([chatTarget]);
  draft.text = 'Текст';
  const resolveIdentity = createIdentityResolver();
  const key = buildPublicationSaveRequestKey(draft, { kind: 'create' }, false);

  const beforeSuccess = resolveIdentity(null, key);
  const afterSuccess = resolveIdentity(null, key);

  assert.notEqual(afterSuccess.requestId, beforeSuccess.requestId);
});

test('restores a lost pending create across reload without persisting payload content', () => {
  const draft = createEmptyPublicationDraft([chatTarget]);
  draft.title = 'Закрытый план';
  draft.text = 'Секретный текст публикации';
  draft.buttonEnabled = true;
  draft.buttons = [{ text: 'Открыть', url: 'https://internal.example/private' }];
  draft.images = [{ base64: 'c2VjcmV0LWltYWdl', mimeType: 'image/jpeg', fileName: 'private.jpg' }];
  const initialKey = buildPublicationSaveRequestKey(draft, { kind: 'create' }, false);
  let sequence = 0;
  const createRequestId = () => `persisted-request-${++sequence}`;

  const firstAttempt = resolvePublicationCreateRequestIdentity(
    null,
    initialKey,
    null,
    createRequestId,
  );
  const storedValue = JSON.stringify(firstAttempt.record);
  assert.deepEqual(Object.keys(firstAttempt.record).sort(), ['fingerprint', 'requestId']);
  assert.equal(storedValue.includes(draft.text), false);
  assert.equal(storedValue.includes(draft.images[0]?.base64 ?? ''), false);
  assert.equal(storedValue.includes(draft.buttons[0]?.url ?? ''), false);

  const afterReload = resolvePublicationCreateRequestIdentity(
    null,
    buildPublicationSaveRequestKey(draft, { kind: 'create' }, false),
    firstAttempt.record,
    createRequestId,
  );
  assert.equal(afterReload.identity.requestId, firstAttempt.identity.requestId);
  assert.equal(sequence, 1);

  const storageFailureFallback = resolvePublicationCreateRequestIdentity(
    firstAttempt.identity,
    initialKey,
    null,
    createRequestId,
  );
  assert.equal(storageFailureFallback.identity.requestId, firstAttempt.identity.requestId);
  assert.equal(sequence, 1);

  const unrelatedSave = resolvePublicationRequestIdentity(
    null,
    buildPublicationSaveRequestKey(draft, { kind: 'duplicate' }, false),
    createRequestId,
  );
  const restoredAfterOtherSave = resolvePublicationCreateRequestIdentity(
    unrelatedSave,
    initialKey,
    firstAttempt.record,
    createRequestId,
  );
  assert.equal(restoredAfterOtherSave.identity.requestId, firstAttempt.identity.requestId);

  draft.text = 'Фактически другой текст';
  const changedPayload = resolvePublicationCreateRequestIdentity(
    null,
    buildPublicationSaveRequestKey(draft, { kind: 'create' }, false),
    firstAttempt.record,
    createRequestId,
  );
  assert.notEqual(changedPayload.identity.requestId, firstAttempt.identity.requestId);
  assert.notEqual(changedPayload.record.fingerprint, firstAttempt.record.fingerprint);
});

test('pending create fingerprint covers replacement intent and full media payload', () => {
  const draft = createEmptyPublicationDraft([chatTarget]);
  draft.text = 'Публикация';
  draft.timingMode = 'once';
  draft.scheduledSlots = ['2026-08-01T10:00:00.000Z'];
  draft.images = [{ base64: 'aW1hZ2UtMQ==', mimeType: 'image/jpeg', fileName: 'one.jpg' }];
  const ordinaryKey = buildPublicationSaveRequestKey(draft, { kind: 'create' }, false);
  const replacementKey = buildPublicationSaveRequestKey(draft, { kind: 'create' }, true);
  assert.notEqual(
    fingerprintPublicationRequestKey(ordinaryKey),
    fingerprintPublicationRequestKey(replacementKey),
  );

  draft.images[0] = { ...draft.images[0]!, base64: 'aW1hZ2UtMg==' };
  assert.notEqual(
    fingerprintPublicationRequestKey(ordinaryKey),
    fingerprintPublicationRequestKey(
      buildPublicationSaveRequestKey(draft, { kind: 'create' }, false),
    ),
  );
});

test('test request identity ignores fields that the test endpoint does not receive', () => {
  const draft = createEmptyPublicationDraft([chatTarget, channelTarget]);
  draft.title = 'Заголовок';
  draft.text = 'Тест';
  draft.timingMode = 'schedule';
  draft.scheduleKind = 'slots';
  draft.scheduledSlots = ['2026-08-01T10:00:00.000Z'];
  const initialKey = buildPublicationTestRequestKey(draft);

  draft.title = 'Другой заголовок';
  draft.scheduleKind = 'recurrence';
  draft.recurrence.times = ['18:30'];
  draft.targets[1] = { ...channelTarget, id: 'channel-2' };
  const irrelevantChangesKey = buildPublicationTestRequestKey(draft);

  assert.equal(arePublicationRequestKeysEqual(initialKey, irrelevantChangesKey), true);

  draft.targets[0] = { ...chatTarget, id: 'chat-2' };
  const changedPrimaryTargetKey = buildPublicationTestRequestKey(draft);
  assert.equal(arePublicationRequestKeysEqual(initialKey, changedPrimaryTargetKey), false);

  draft.targets[0] = chatTarget;
  draft.text = 'Изменённый тест';
  const changedContentKey = buildPublicationTestRequestKey(draft);
  assert.equal(arePublicationRequestKeysEqual(initialKey, changedContentKey), false);
});

test('action request identity includes operation, publication, and expected revision', () => {
  const resolveIdentity = createIdentityResolver();
  const initial = resolveIdentity(
    null,
    buildPublicationActionRequestKey('publication-1', 'pause', 4),
  );
  const unchanged = resolveIdentity(
    initial,
    buildPublicationActionRequestKey('publication-1', 'pause', 4),
  );
  assert.equal(unchanged.requestId, initial.requestId);

  const changedAction = resolveIdentity(
    unchanged,
    buildPublicationActionRequestKey('publication-1', 'cancel', 4),
  );
  const changedRevision = resolveIdentity(
    changedAction,
    buildPublicationActionRequestKey('publication-1', 'cancel', 5),
  );
  const changedPublication = resolveIdentity(
    changedRevision,
    buildPublicationActionRequestKey('publication-2', 'cancel', 5),
  );
  assert.notEqual(changedAction.requestId, unchanged.requestId);
  assert.notEqual(changedRevision.requestId, changedAction.requestId);
  assert.notEqual(changedPublication.requestId, changedRevision.requestId);
});

test('retry request identity includes occurrence, content mode, and optimistic revisions', () => {
  const resolveIdentity = createIdentityResolver();
  const originalInput = {
    publicationId: 'publication-1',
    occurrenceId: 'occurrence-1',
    contentMode: 'original' as const,
  };
  const initial = resolveIdentity(null, buildPublicationRetryRequestKey(originalInput));
  const unchanged = resolveIdentity(initial, buildPublicationRetryRequestKey(originalInput));
  assert.equal(unchanged.requestId, initial.requestId);

  const latestInput = {
    ...originalInput,
    contentMode: 'latest' as const,
    expectedPublicationVersion: 7,
    expectedContentRevision: 3,
  };
  const latest = resolveIdentity(unchanged, buildPublicationRetryRequestKey(latestInput));
  const changedRevision = resolveIdentity(
    latest,
    buildPublicationRetryRequestKey({ ...latestInput, expectedContentRevision: 4 }),
  );
  const changedOccurrence = resolveIdentity(
    changedRevision,
    buildPublicationRetryRequestKey({ ...latestInput, occurrenceId: 'occurrence-2' }),
  );
  assert.notEqual(latest.requestId, unchanged.requestId);
  assert.notEqual(changedRevision.requestId, latest.requestId);
  assert.notEqual(changedOccurrence.requestId, changedRevision.requestId);
});

test('ambiguous resolution identity distinguishes delivery and selected outcome', () => {
  const resolveIdentity = createIdentityResolver();
  const input = {
    publicationId: 'publication-1',
    occurrenceId: 'occurrence-1',
    deliveryId: 'delivery-1',
    resolution: 'mark_sent' as const,
  };
  const initial = resolveIdentity(null, buildPublicationAmbiguousRequestKey(input));
  const unchanged = resolveIdentity(initial, buildPublicationAmbiguousRequestKey(input));
  assert.equal(unchanged.requestId, initial.requestId);

  const changedOutcome = resolveIdentity(
    unchanged,
    buildPublicationAmbiguousRequestKey({ ...input, resolution: 'mark_failed' }),
  );
  const changedDelivery = resolveIdentity(
    changedOutcome,
    buildPublicationAmbiguousRequestKey({ ...input, deliveryId: 'delivery-2' }),
  );
  assert.notEqual(changedOutcome.requestId, unchanged.requestId);
  assert.notEqual(changedDelivery.requestId, changedOutcome.requestId);
});

test('recognizes an ambiguous test result and provides actionable copy', () => {
  assert.equal(
    isPublicationTestResultPendingError({ code: 'BROADCAST_TEST_RESULT_PENDING' }),
    true,
  );
  assert.equal(isPublicationTestResultPendingError(new Error('timeout')), false);
  assert.deepEqual(PUBLICATION_TEST_RESULT_PENDING_FEEDBACK, {
    tone: 'info',
    title: 'Тест мог быть отправлен',
    description: 'Проверьте личный диалог с ботом перед повтором.',
    durationMs: 6_000,
  });
});
