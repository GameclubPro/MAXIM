import assert from 'node:assert/strict';
import test from 'node:test';
import type { PublicationDetails, PublicationPostActions } from '@maxim/contracts/publication';
import {
  buildCreatePublicationRequest,
  buildTestPublicationRequest,
  buildUpdatePublicationRequest,
  createEmptyPublicationDraft,
  createPublicationDraftFromDetails,
  createPublicationDuplicateDraft,
  hasPublicationDraftChanges,
  isPublicationDraftEmpty,
  rebasePublicationDraft,
} from '../src/features/publications/publication-model';
import { parsePublicationDraftEnvelope } from '../src/features/publications/publication-draft-storage';
import {
  publicationPostActionLabels,
  publicationPostActionsPending,
  publicationPostActionsPollingInterval,
  publicationPostPublishLabels,
} from '../src/features/publications/publication-post-actions-presentation';

const policy = { pin: 'notify' as const, deleteAfterMinutes: 90 };

test('keeps publication actions in create, edit, duplicate and restored drafts', () => {
  const draft = { ...createEmptyPublicationDraft(), text: 'Post', postPublish: policy };
  assert.deepEqual(buildCreatePublicationRequest(draft, 'request-123').content.postPublish, policy);
  assert.deepEqual(
    buildUpdatePublicationRequest(draft, 1, 'request-123').content?.postPublish,
    policy,
  );
  assert.deepEqual(createPublicationDuplicateDraft(draft).postPublish, policy);
  assert.deepEqual(
    parsePublicationDraftEnvelope({ version: 3, savedAt: new Date().toISOString(), draft })
      ?.postPublish,
    policy,
  );
  const details = {
    title: 'Post',
    schedule: null,
    targets: [],
    content: { text: 'Post', textFormat: 'plain', buttons: [], media: [], postPublish: policy },
  } as unknown as PublicationDetails;
  assert.deepEqual(createPublicationDraftFromDetails(details).postPublish, policy);
});

test('test sends never pin or auto-delete', () => {
  const draft = { ...createEmptyPublicationDraft(), text: 'Post', postPublish: policy };
  assert.deepEqual(buildTestPublicationRequest(draft, 'request-123').content.postPublish, {
    pin: 'none',
    deleteAfterMinutes: null,
  });
});

test('tracks policy-only changes and preserves local policy during conflict rebase', () => {
  const initial = createEmptyPublicationDraft();
  const local = { ...initial, postPublish: policy };
  assert.equal(isPublicationDraftEmpty(initial), true);
  assert.equal(isPublicationDraftEmpty(local), false);
  assert.equal(hasPublicationDraftChanges(initial, local), true);
  assert.deepEqual(
    rebasePublicationDraft(initial, local, { ...initial, text: 'Remote text' }).postPublish,
    policy,
  );
});

test('restores old drafts safely with both actions disabled', () => {
  const restored = parsePublicationDraftEnvelope({
    version: 1,
    savedAt: new Date().toISOString(),
    draft: { text: 'Legacy' },
  });
  assert.deepEqual(restored?.postPublish, { pin: 'none', deleteAfterMinutes: null });
});

test('presents separate pin and delete outcomes without changing send status', () => {
  const actions: PublicationPostActions = {
    pinStatus: 'AMBIGUOUS',
    pinError: 'Check',
    deleteStatus: 'PENDING',
    deleteAt: '2026-09-09T13:00:00.000Z',
    deletedAt: null,
    deleteError: null,
  };
  assert.equal(publicationPostActionsPending(actions), true);
  assert.deepEqual(publicationPostActionLabels(actions), [
    'Закрепление требует проверки',
    'Удаление 9 сент., 16:00',
  ]);
  assert.equal(publicationPostActionsPending({ ...actions, deleteStatus: 'DONE' }), false);
  assert.equal(
    publicationPostActionsPollingInterval(actions, Date.parse('2026-09-09T12:00:00Z')),
    60_000,
  );
  assert.equal(
    publicationPostActionsPollingInterval(actions, Date.parse('2026-09-09T12:59:59Z')),
    5_000,
  );
  assert.deepEqual(publicationPostPublishLabels(policy), [
    'Закрепить с уведомлением',
    'Удаление через 90 мин',
  ]);
});
