import assert from 'node:assert/strict';
import test from 'node:test';
import type { ManagedPollStatus, ManagedPollSummary } from '@maxim/contracts/poll';
import {
  isManagedPollEditable,
  reconcileManagedPollListData,
  removeManagedPollFromListData,
  resolveManagedPollListScope,
  type ManagedPollListData,
} from '../src/lib/managed-poll-cache';

const timestamp = '2026-08-19T10:00:00.000Z';

function createPoll(id: string, status: ManagedPollStatus): ManagedPollSummary {
  return {
    id,
    channelId: 'channel-1',
    question: `Вопрос ${id}`,
    questionFormat: 'plain',
    status,
    visibility: 'ANONYMOUS',
    imageCount: 0,
    totalVotes: 0,
    options: [
      { id: `${id}-1`, position: 0, text: 'Да', votes: 0, percent: 0 },
      { id: `${id}-2`, position: 1, text: 'Нет', votes: 0, percent: 0 },
    ],
    publicationPending: false,
    publicationNeedsReview: false,
    renderRepairNeeded: false,
    publicationUrl: null,
    publishedAt: null,
    closedAt: status === 'CLOSED' ? timestamp : null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function createListData(polls: ManagedPollSummary[], total: number): ManagedPollListData {
  return {
    pages: [{ items: polls, nextCursor: null, total }],
    pageParams: [null],
  };
}

test('poll cache reconciliation moves a closed poll between scoped lists and totals', () => {
  const draft = createPoll('poll-1', 'DRAFT');
  const closed = { ...draft, status: 'CLOSED' as const, closedAt: timestamp };
  const current = createListData([draft], 3);
  const archive = createListData([createPoll('poll-2', 'CLOSED')], 1);

  const nextCurrent = reconcileManagedPollListData(current, 'current', closed);
  const nextArchive = reconcileManagedPollListData(archive, 'archive', closed);

  assert.deepEqual(nextCurrent?.pages[0]?.items, []);
  assert.equal(nextCurrent?.pages[0]?.total, 2);
  assert.equal(nextArchive?.pages[0]?.items[0]?.id, closed.id);
  assert.equal(nextArchive?.pages[0]?.total, 2);
});

test('poll cache does not increment a fresh total when the moved poll is outside loaded pages', () => {
  const partialArchive = createListData([createPoll('poll-2', 'CLOSED')], 2);
  const movedPoll = createPoll('poll-1', 'CLOSED');
  partialArchive.pages[0] = {
    ...partialArchive.pages[0]!,
    nextCursor: 'archive-cursor',
  };

  const reconciled = reconcileManagedPollListData(partialArchive, 'archive', movedPoll);

  assert.equal(reconciled?.pages[0]?.items[0]?.id, movedPoll.id);
  assert.equal(reconciled?.pages[0]?.total, 2);
});

test('poll cache updates all page totals once and does not double-count replacements', () => {
  const draft = createPoll('poll-1', 'DRAFT');
  const data: ManagedPollListData = {
    pages: [
      { items: [draft], nextCursor: 'cursor-1', total: 2 },
      { items: [createPoll('poll-2', 'ACTIVE')], nextCursor: null, total: 2 },
    ],
    pageParams: [null, 'cursor-1'],
  };
  const refreshed = { ...draft, question: 'Обновлённый вопрос' };

  const replaced = reconcileManagedPollListData(data, 'current', refreshed);
  assert.deepEqual(
    replaced?.pages.map((page) => page.total),
    [2, 2],
  );
  assert.equal(replaced?.pages[0]?.items[0]?.question, refreshed.question);

  const removed = removeManagedPollFromListData(replaced, draft.id);
  assert.deepEqual(
    removed?.pages.map((page) => page.total),
    [1, 1],
  );
});

test('poll state helpers classify scopes and locked drafts', () => {
  const draft = createPoll('draft', 'DRAFT');

  assert.equal(resolveManagedPollListScope(draft), 'current');
  assert.equal(resolveManagedPollListScope(createPoll('closed', 'CLOSED')), 'archive');
  assert.equal(isManagedPollEditable(draft), true);
  assert.equal(isManagedPollEditable({ ...draft, publicationPending: true }), false);
  assert.equal(isManagedPollEditable({ ...draft, publicationNeedsReview: true }), false);
  assert.equal(isManagedPollEditable(createPoll('active', 'ACTIVE')), false);
});
