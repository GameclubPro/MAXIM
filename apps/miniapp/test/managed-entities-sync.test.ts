import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatSummary, ManagedEntitiesRefreshState } from '@maxim/contracts';
import {
  applyManagedEntitiesResponseDiff,
  isManagedEntitiesUserVisibleComplete,
  mergeManagedEntitiesRefreshItems,
  readManagedEntitiesLocalCacheUserScopeFromInitData,
  resolveManagedEntitiesSettledPhase,
  resolveManagedEntitiesRefreshRequestOptions,
  resolveManagedEntitiesScopeTransitionState,
  shouldUseFreshManagedEntitiesReload,
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
      hasVisibleData: true,
    }),
    {
      startWithBackgroundRefresh: true,
      continueWithBackgroundRefreshAfterLoad: false,
      bypassRemoteCache: false,
      resetRefreshCursor: false,
    },
  );
});

test('cold start without visible data loads the default list first and refreshes only afterwards', () => {
  assert.deepEqual(
    resolveManagedEntitiesRefreshRequestOptions({
      forceRefreshSession: false,
      reloadBehavior: 'default',
      backgroundRefreshOnFirstLoad: true,
      hasLoadedFromServer: false,
      hasVisibleData: false,
    }),
    {
      startWithBackgroundRefresh: false,
      continueWithBackgroundRefreshAfterLoad: true,
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
      hasVisibleData: true,
    }),
    {
      startWithBackgroundRefresh: true,
      continueWithBackgroundRefreshAfterLoad: false,
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
      hasVisibleData: true,
    }),
    {
      startWithBackgroundRefresh: true,
      continueWithBackgroundRefreshAfterLoad: false,
      bypassRemoteCache: true,
      resetRefreshCursor: false,
    },
  );
});

test('uses the fresh endpoint for manual reloads when requested', () => {
  assert.equal(
    shouldUseFreshManagedEntitiesReload({
      forceRefreshSession: true,
      freshOnManualReload: true,
      requestedBackgroundRefresh: true,
      freshOnBackgroundRefresh: false,
    }),
    true,
  );
});

test('uses the fresh endpoint for first background refresh when requested', () => {
  assert.equal(
    shouldUseFreshManagedEntitiesReload({
      forceRefreshSession: false,
      freshOnManualReload: false,
      requestedBackgroundRefresh: true,
      freshOnBackgroundRefresh: true,
    }),
    true,
  );
});

test('keeps the regular refresh endpoint for passive background refreshes by default', () => {
  assert.equal(
    shouldUseFreshManagedEntitiesReload({
      forceRefreshSession: false,
      freshOnManualReload: false,
      requestedBackgroundRefresh: true,
      freshOnBackgroundRefresh: false,
    }),
    false,
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

test('keeps the visible list stable when refresh returns the same snapshot version', () => {
  const previous = [createItem('1', 'Chat 1'), createItem('2', 'Chat 2')];
  const next = [createItem('2', 'Chat 2'), createItem('3', 'Chat 3')];

  assert.deepEqual(
    mergeManagedEntitiesRefreshItems({
      previous,
      next,
      refreshState: createRefreshState({ complete: true, cursor: -1, nextPollAfterMs: 0 }),
      keepVisibleOnSameSnapshotVersion: true,
      previousSnapshotVersion: 'snapshot-v1',
      nextSnapshotVersion: 'snapshot-v1',
    }).map((item) => item.id),
    ['1', '2'],
  );
});

test('switches the visible list when refresh returns a new snapshot version', () => {
  const previous = [createItem('1', 'Chat 1'), createItem('2', 'Chat 2')];
  const next = [createItem('2', 'Chat 2'), createItem('3', 'Chat 3')];

  assert.deepEqual(
    mergeManagedEntitiesRefreshItems({
      previous,
      next,
      refreshState: createRefreshState({ complete: true, cursor: -1, nextPollAfterMs: 0 }),
      keepVisibleOnSameSnapshotVersion: true,
      previousSnapshotVersion: 'snapshot-v1',
      nextSnapshotVersion: 'snapshot-v2',
    }).map((item) => item.id),
    ['2', '3'],
  );
});

test('treats a user-visible refresh state as settled for home screens', () => {
  const refreshState = createRefreshState({
    userVisibleComplete: true,
  });

  assert.equal(isManagedEntitiesUserVisibleComplete(refreshState), true);
  assert.equal(
    resolveManagedEntitiesSettledPhase(refreshState, {
      treatUserVisibleCompleteAsSettled: true,
    }),
    'complete',
  );
  assert.equal(
    resolveManagedEntitiesSettledPhase(refreshState, {
      treatUserVisibleCompleteAsSettled: false,
    }),
    'idle',
  );
});

test('still treats a fully completed refresh as settled everywhere', () => {
  const refreshState = createRefreshState({
    complete: true,
    cursor: -1,
    nextPollAfterMs: 0,
  });

  assert.equal(isManagedEntitiesUserVisibleComplete(refreshState), true);
  assert.equal(
    resolveManagedEntitiesSettledPhase(refreshState, {
      treatUserVisibleCompleteAsSettled: false,
    }),
    'complete',
  );
});

test('applies a published snapshot patch using the canonical server order', () => {
  const previous = [
    createItem('1', 'Chat 1', { avatarUrl: 'https://example.com/avatar-1.png' }),
    createItem('2', 'Chat 2'),
  ];

  const next = applyManagedEntitiesResponseDiff({
    previous,
    previousSnapshotVersion: 'snapshot-v1',
    diff: {
      mode: 'patch',
      baseVersion: 'snapshot-v1',
      nextVersion: 'snapshot-v2',
      added: [createItem('3', 'Chat 3')],
      updated: [createItem('2', 'Chat 2 updated')],
      removedIds: ['1'],
      orderedIds: ['3', '2'],
    },
  });

  assert.deepEqual(next, [
    createItem('3', 'Chat 3'),
    createItem('2', 'Chat 2 updated'),
  ]);
});

test('rejects a published snapshot patch when the ordered ids cannot reconstruct the next list', () => {
  const previous = [createItem('1', 'Chat 1'), createItem('2', 'Chat 2')];

  const next = applyManagedEntitiesResponseDiff({
    previous,
    previousSnapshotVersion: 'snapshot-v1',
    diff: {
      mode: 'patch',
      baseVersion: 'snapshot-v1',
      nextVersion: 'snapshot-v2',
      added: [],
      updated: [],
      removedIds: [],
      orderedIds: ['1'],
    },
  });

  assert.equal(next, null);
});

test('extracts local cache user scope from init data user payload', () => {
  assert.equal(
    readManagedEntitiesLocalCacheUserScopeFromInitData(
      'query_id=test&user=%7B%22id%22%3A123456%2C%22first_name%22%3A%22Max%22%7D&hash=test',
    ),
    'u:123456',
  );
});

test('preserves the visible list when cache scope switches but the new scope has no data yet', () => {
  const currentState = {
    data: [createItem('1', 'Chat 1')],
    error: new Error('stale'),
    refreshState: createRefreshState({ complete: true, cursor: -1, nextPollAfterMs: 0 }),
    snapshot: {
      version: 'snapshot-v1',
      builtAt: '2026-04-04T10:00:00.000Z',
      lastSyncedAt: '2026-04-04T09:59:00.000Z',
      source: 'published_snapshot' as const,
      stale: false,
    },
    phase: 'complete' as const,
    hasLoadedFromServer: true,
  };
  const nextInitialState = {
    data: null,
    error: null,
    refreshState: null,
    snapshot: null,
    phase: 'loading' as const,
    hasLoadedFromServer: false,
  };

  assert.deepEqual(
    resolveManagedEntitiesScopeTransitionState({
      currentState,
      nextInitialState,
    }),
    {
      ...currentState,
      error: null,
    },
  );
});

test('prefers the new scope cache when it already has visible data', () => {
  const currentState = {
    data: [createItem('1', 'Chat 1')],
    error: null,
    refreshState: createRefreshState({ complete: true, cursor: -1, nextPollAfterMs: 0 }),
    snapshot: null,
    phase: 'complete' as const,
    hasLoadedFromServer: true,
  };
  const nextInitialState = {
    data: [createItem('2', 'Chat 2')],
    error: null,
    refreshState: createRefreshState({ complete: true, cursor: -1, nextPollAfterMs: 0 }),
    snapshot: {
      version: 'snapshot-v2',
      builtAt: '2026-04-04T10:02:00.000Z',
      lastSyncedAt: '2026-04-04T10:01:00.000Z',
      source: 'published_snapshot' as const,
      stale: false,
    },
    phase: 'complete' as const,
    hasLoadedFromServer: false,
  };

  assert.deepEqual(
    resolveManagedEntitiesScopeTransitionState({
      currentState,
      nextInitialState,
    }),
    nextInitialState,
  );
});

test('can keep the already visible home list when a complete refresh returns empty', () => {
  const previous = [createItem('1', 'Chat 1'), createItem('2', 'Chat 2')];

  assert.deepEqual(
    mergeManagedEntitiesRefreshItems({
      previous,
      next: [],
      refreshState: createRefreshState({ complete: true, cursor: -1, nextPollAfterMs: 0 }),
      preservePreviousOnEmptyComplete: true,
    }).map((item) => item.id),
    ['1', '2'],
  );
});
