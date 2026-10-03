import { createManagedEntitiesRefreshState } from './admin-managed-entities-refresh-state';
import {
  MANAGED_ENTITIES_REFRESH_CURSOR_DONE,
  MANAGED_ENTITIES_MANUAL_REFRESH_RECENT_SYNC_WINDOW_MS,
} from './admin.service.support';

describe('managed entities refresh presentation', () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(new Date('2026-10-03T12:00:00Z')));
  afterEach(() => jest.useRealTimers());

  it('preserves backoff precedence and rounds the next retry delay up', () => {
    expect(
      createManagedEntitiesRefreshState(2, true, 10.1, {
        totalCandidates: 4,
        lastSyncedAt: new Date().toISOString(),
      }),
    ).toEqual({
      complete: false,
      cursor: 2,
      backoffActive: true,
      nextPollAfterMs: 11,
      processedCandidates: 2,
      totalCandidates: 4,
      progressPercent: 50,
      lastSyncedAt: new Date().toISOString(),
      manualRefreshBlockedReason: 'backoff',
      manualRefreshRetryAfterMs: 11,
    });
  });

  it('re-enables a completed manual refresh exactly when the recent-sync window ends', () => {
    const presentation = { totalCandidates: 4, lastSyncedAt: new Date().toISOString() };
    const before = createManagedEntitiesRefreshState(
      MANAGED_ENTITIES_REFRESH_CURSOR_DONE,
      false,
      undefined,
      presentation,
    );
    expect(before).toEqual(
      expect.objectContaining({
        complete: true,
        processedCandidates: 4,
        progressPercent: 100,
        nextPollAfterMs: 0,
        manualRefreshBlockedReason: 'recent_sync',
        manualRefreshRetryAfterMs: MANAGED_ENTITIES_MANUAL_REFRESH_RECENT_SYNC_WINDOW_MS,
      }),
    );
    jest.advanceTimersByTime(MANAGED_ENTITIES_MANUAL_REFRESH_RECENT_SYNC_WINDOW_MS);
    expect(
      createManagedEntitiesRefreshState(
        MANAGED_ENTITIES_REFRESH_CURSOR_DONE,
        false,
        undefined,
        presentation,
      ),
    ).toEqual(
      expect.objectContaining({
        manualRefreshBlockedReason: null,
        manualRefreshRetryAfterMs: null,
      }),
    );
  });

  it('does not invent progress or a recent-sync block from missing or invalid presentation data', () => {
    expect(
      createManagedEntitiesRefreshState(null, false, 0, {
        totalCandidates: Number.NaN,
        lastSyncedAt: 'invalid',
      }),
    ).toEqual(
      expect.objectContaining({
        processedCandidates: null,
        totalCandidates: null,
        progressPercent: null,
        manualRefreshBlockedReason: null,
        manualRefreshRetryAfterMs: null,
      }),
    );
  });
});
