import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatSummary, ManagedEntitiesRefreshState } from '@maxim/contracts';
import {
  mergeManagedEntitiesRefreshItems,
  resolveManagedEntitiesRefreshRequestOptions,
  shouldStartManagedEntitiesBackgroundRefresh,
} from '../src/lib/use-managed-entities-sync';

function createItem(id: string, title: string, overrides: Partial<ChatSummary> = {}): ChatSummary {
  return {
    id,
    title,
    createdAt: '2026-04-03T12:00:00.000Z',
    entityType: 'chat',
    link: null,
    avatarUrl: null,
    channelOverview: null,
    assignedBots: [],
    primaryBotId: null,
    sharedMode: 'owned',
    ...overrides,
  };
}

function createRefreshState(
  overrides: Partial<ManagedEntitiesRefreshState> = {},
): ManagedEntitiesRefreshState {
  return {
    complete: false,
    cursor: 1,
    backoffActive: false,
    nextPollAfterMs: 1000,
    processedCandidates: null,
    totalCandidates: null,
    progressPercent: null,
    lastSyncedAt: null,
    manualRefreshBlockedReason: null,
    manualRefreshRetryAfterMs: null,
    ...overrides,
  };
}

test('starts background refresh before the list has been confirmed by the server', () => {
  assert.equal(
    shouldStartManagedEntitiesBackgroundRefresh({
      forceRefreshSession: false,
      backgroundRefreshOnFirstLoad: true,
      hasLoadedFromServer: false,
    }),
    true,
  );
});

test('skips bootstrap background refresh after the current scope was already loaded from the server', () => {
  assert.equal(
    shouldStartManagedEntitiesBackgroundRefresh({
      forceRefreshSession: false,
      backgroundRefreshOnFirstLoad: true,
      hasLoadedFromServer: true,
    }),
    false,
  );
});

test('still allows an explicit reload session to force background refresh', () => {
  assert.equal(
    shouldStartManagedEntitiesBackgroundRefresh({
      forceRefreshSession: true,
      backgroundRefreshOnFirstLoad: false,
      hasLoadedFromServer: true,
    }),
    true,
  );
});

test('keeps the existing server cursor on the first background refresh session', () => {
  assert.deepEqual(
    resolveManagedEntitiesRefreshRequestOptions({
      forceRefreshSession: false,
      reloadBehavior: 'default',
      backgroundRefreshOnFirstLoad: true,
      hasLoadedFromServer: false,
    }),
    {
      startWithBackgroundRefresh: true,
      bypassRemoteCache: false,
      resetRefreshCursor: false,
    },
  );
});

test('manual refresh bypasses MAX cache without restarting the server cursor', () => {
  assert.deepEqual(
    resolveManagedEntitiesRefreshRequestOptions({
      forceRefreshSession: true,
      reloadBehavior: 'manual',
      backgroundRefreshOnFirstLoad: false,
      hasLoadedFromServer: true,
    }),
    {
      startWithBackgroundRefresh: true,
      bypassRemoteCache: true,
      resetRefreshCursor: false,
    },
  );
});

test('recovery refresh also resumes the existing server cursor', () => {
  assert.deepEqual(
    resolveManagedEntitiesRefreshRequestOptions({
      forceRefreshSession: true,
      reloadBehavior: 'recovery',
      backgroundRefreshOnFirstLoad: false,
      hasLoadedFromServer: true,
    }),
    {
      startWithBackgroundRefresh: true,
      bypassRemoteCache: true,
      resetRefreshCursor: false,
    },
  );
});

test('keeps already visible chats during partial refresh and appends newly discovered ones', () => {
  const previous = [createItem('1', 'Chat 1'), createItem('2', 'Chat 2')];
  const next = [createItem('3', 'Chat 3')];

  assert.deepEqual(
    mergeManagedEntitiesRefreshItems({
      previous,
      next,
      refreshState: createRefreshState(),
    }).map((item) => item.id),
    ['1', '2', '3'],
  );
});

test('updates overlapping chats during partial refresh without dropping the rest of the list', () => {
  const previous = [
    createItem('1', 'Chat 1', { avatarUrl: 'https://example.com/avatar.png' }),
    createItem('2', 'Chat 2'),
    createItem('3', 'Chat 3'),
  ];
  const next = [createItem('2', 'Updated Chat 2'), createItem('4', 'Chat 4')];

  const merged = mergeManagedEntitiesRefreshItems({
    previous,
    next,
    refreshState: createRefreshState(),
  });

  assert.deepEqual(
    merged.map((item) => ({
      id: item.id,
      title: item.title,
      avatarUrl: item.avatarUrl,
    })),
    [
      { id: '1', title: 'Chat 1', avatarUrl: 'https://example.com/avatar.png' },
      { id: '2', title: 'Updated Chat 2', avatarUrl: null },
      { id: '3', title: 'Chat 3', avatarUrl: null },
      { id: '4', title: 'Chat 4', avatarUrl: null },
    ],
  );
});

test('uses the final server snapshot once refresh is complete', () => {
  const previous = [createItem('1', 'Chat 1'), createItem('2', 'Chat 2')];
  const next = [createItem('2', 'Chat 2'), createItem('3', 'Chat 3')];

  assert.deepEqual(
    mergeManagedEntitiesRefreshItems({
      previous,
      next,
      refreshState: createRefreshState({ complete: true, cursor: -1, nextPollAfterMs: 0 }),
    }).map((item) => item.id),
    ['2', '3'],
  );
});
