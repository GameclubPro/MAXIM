import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldRefreshManagedEntitiesOnVisibilityReturn } from '../src/lib/managed-entities-visibility-refresh';

const BASE_OPTIONS = {
  awaitingReturnRefresh: true,
  documentVisible: true,
  isLoading: false,
  isRefreshing: false,
  hasLoadedFromServer: true,
  isSyncComplete: true,
  snapshotStale: false,
  hiddenDurationMs: 500,
  lastRefreshAtMs: 10_000,
  nowMs: 20_000,
  minIntervalMs: 15_000,
  minHiddenDurationMs: 2_000,
} as const;

test('refreshes on visibility return after a meaningful time away even for a fresh snapshot', () => {
  assert.equal(
    shouldRefreshManagedEntitiesOnVisibilityReturn({
      ...BASE_OPTIONS,
      hiddenDurationMs: 5_000,
      nowMs: 12_000,
    }),
    true,
  );
});

test('skips visibility return refresh for a fresh snapshot after a brief focus bounce', () => {
  assert.equal(
    shouldRefreshManagedEntitiesOnVisibilityReturn({
      ...BASE_OPTIONS,
      hiddenDurationMs: 400,
      nowMs: 12_000,
    }),
    false,
  );
});

test('refreshes on visibility return when the snapshot is stale', () => {
  assert.equal(
    shouldRefreshManagedEntitiesOnVisibilityReturn({
      ...BASE_OPTIONS,
      snapshotStale: true,
      hiddenDurationMs: 400,
      nowMs: 12_000,
    }),
    true,
  );
});

test('skips visibility return refresh while the screen is already loading', () => {
  assert.equal(
    shouldRefreshManagedEntitiesOnVisibilityReturn({
      ...BASE_OPTIONS,
      isLoading: true,
      hiddenDurationMs: 5_000,
    }),
    false,
  );
});
