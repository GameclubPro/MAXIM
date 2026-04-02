import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldStartManagedEntitiesBackgroundRefresh } from '../src/lib/use-managed-entities-sync';

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
