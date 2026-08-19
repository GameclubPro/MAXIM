import assert from 'node:assert/strict';
import test from 'node:test';
import type { ManagedPollDetails } from '@maxim/contracts/poll';
import { ApiRequestError } from '../src/lib/api-request-error';
import {
  isManagedPollEditConflict,
  rebaseManagedPollDraftAfterConflict,
  type ManagedPollEditorDraft,
} from '../src/lib/managed-poll-edit-conflict';

const latestPoll: ManagedPollDetails = {
  id: 'poll-1',
  channelId: 'channel-1',
  question: 'Удалённый вопрос',
  questionFormat: 'plain',
  status: 'DRAFT',
  visibility: 'OPEN',
  imageCount: 0,
  images: [],
  totalVotes: 0,
  options: [
    { id: 'option-1', position: 0, text: 'Удалённый первый', votes: 0, percent: 0 },
    { id: 'option-3', position: 1, text: 'Удалённый второй', votes: 0, percent: 0 },
  ],
  publicationPending: false,
  publicationNeedsReview: false,
  renderRepairNeeded: false,
  publicationUrl: null,
  publicationMessageId: null,
  lastError: null,
  lastRenderError: null,
  publishedAt: null,
  closedAt: null,
  createdAt: '2026-08-19T09:00:00.000Z',
  updatedAt: '2026-08-19T10:00:00.000Z',
};

test('managed poll conflict detection only accepts API 409 errors', () => {
  assert.equal(
    isManagedPollEditConflict(
      new ApiRequestError(409, '{"statusCode":409}', 'Черновик уже изменён.'),
    ),
    true,
  );
  assert.equal(
    isManagedPollEditConflict(new ApiRequestError(400, '{"statusCode":400}', 'Ошибка.')),
    false,
  );
  assert.equal(isManagedPollEditConflict(new Error('409')), false);
});

test('rebasing a stale poll keeps authored fields and refreshes only remote identity data', () => {
  const localDraft: ManagedPollEditorDraft = {
    pollId: 'poll-1',
    expectedUpdatedAt: '2026-08-19T09:30:00.000Z',
    question: '**Локальный вопрос**',
    questionFormat: 'markdown',
    images: [{ base64: 'bG9jYWw=', mimeType: 'image/jpeg', fileName: 'local.jpg' }],
    imageRevision: 17,
    visibility: 'ANONYMOUS',
    options: [
      { key: 'first', id: 'option-1', text: 'Локальный первый' },
      { key: 'removed', id: 'option-2', text: 'Локальный удалённый' },
      { key: 'new', text: 'Локальный новый' },
    ],
  };

  const rebased = rebaseManagedPollDraftAfterConflict(localDraft, latestPoll);

  assert.equal(rebased.pollId, latestPoll.id);
  assert.equal(rebased.expectedUpdatedAt, latestPoll.updatedAt);
  assert.equal(rebased.question, localDraft.question);
  assert.equal(rebased.questionFormat, localDraft.questionFormat);
  assert.deepEqual(rebased.images, localDraft.images);
  assert.notEqual(rebased.images, localDraft.images);
  assert.equal(rebased.imageRevision, localDraft.imageRevision);
  assert.equal(rebased.visibility, localDraft.visibility);
  assert.deepEqual(rebased.options, [
    { key: 'first', id: 'option-1', text: 'Локальный первый' },
    { key: 'removed', text: 'Локальный удалённый' },
    { key: 'new', text: 'Локальный новый' },
  ]);
});
