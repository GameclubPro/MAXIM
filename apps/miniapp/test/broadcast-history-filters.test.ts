import assert from 'node:assert/strict';
import test from 'node:test';
import type { ManagedBroadcastSummary } from '@maxim/contracts';
import {
  countManagedBroadcastHistoryFilters,
  filterManagedBroadcastsByHistoryFilter,
} from '../src/lib/broadcast-history-filters';

function createBroadcastSummary(
  overrides: Partial<ManagedBroadcastSummary>,
): ManagedBroadcastSummary {
  return {
    id: 'broadcast-1',
    status: 'ACTIVE',
    text: 'Пост',
    hasImage: false,
    imageCount: 0,
    hasVideo: false,
    buttonEnabled: false,
    buttons: [],
    targetMode: 'current',
    targetChats: 1,
    targetPreviews: [],
    targetOverflowCount: 0,
    scheduleMode: 'legacy',
    scheduleTimezone: 'Europe/Moscow',
    scheduledSlots: [],
    nextSendAt: null,
    cycleEnabled: false,
    cycleEveryHours: 1,
    cycleCount: 1,
    sentCount: 0,
    currentOccurrence: 1,
    deliveredChats: 0,
    failedChats: 0,
    pendingChats: 1,
    blockedChats: 0,
    failureBreakdown: {
      transient: 0,
      permanentTarget: 0,
      quarantined: 0,
      unknown: 0,
    },
    canRetry: false,
    remainingCount: 1,
    createdAt: '2026-03-03T10:00:00.000Z',
    updatedAt: '2026-03-03T10:00:00.000Z',
    nextSendAtLabel: null,
    lastError: null,
    ...overrides,
  };
}

test('counts partial broadcasts only in the error history bucket', () => {
  const partial = createBroadcastSummary({
    id: 'partial',
    status: 'PARTIAL',
    nextSendAt: '2026-03-03T12:00:00.000Z',
    failedChats: 1,
    canRetry: true,
    lastError: 'MAX временно недоступен',
  });
  const counts = countManagedBroadcastHistoryFilters([partial]);

  assert.deepEqual(counts, {
    future: 0,
    active: 0,
    error: 1,
    sent: 0,
    canceled: 0,
  });
  assert.deepEqual(filterManagedBroadcastsByHistoryFilter([partial], 'error'), [partial]);
  assert.deepEqual(filterManagedBroadcastsByHistoryFilter([partial], 'future'), []);
});

test('counts active broadcasts with blocked targets in the error history bucket', () => {
  const blocked = createBroadcastSummary({
    id: 'blocked-target',
    status: 'ACTIVE',
    nextSendAt: '2026-03-03T12:00:00.000Z',
    blockedChats: 1,
    failureBreakdown: {
      transient: 0,
      permanentTarget: 1,
      quarantined: 0,
      unknown: 0,
    },
  });
  const counts = countManagedBroadcastHistoryFilters([blocked]);

  assert.deepEqual(counts, {
    future: 0,
    active: 0,
    error: 1,
    sent: 0,
    canceled: 0,
  });
  assert.deepEqual(filterManagedBroadcastsByHistoryFilter([blocked], 'error'), [blocked]);
  assert.deepEqual(filterManagedBroadcastsByHistoryFilter([blocked], 'future'), []);
});

test('keeps canceled broadcasts with blocked targets in the canceled history bucket', () => {
  const canceled = createBroadcastSummary({
    id: 'canceled-with-blocked-targets',
    status: 'CANCELED',
    pendingChats: 0,
    blockedChats: 1,
    failureBreakdown: {
      transient: 0,
      permanentTarget: 0,
      quarantined: 0,
      unknown: 0,
    },
  });
  const counts = countManagedBroadcastHistoryFilters([canceled]);

  assert.deepEqual(counts, {
    future: 0,
    active: 0,
    error: 0,
    sent: 0,
    canceled: 1,
  });
  assert.deepEqual(filterManagedBroadcastsByHistoryFilter([canceled], 'canceled'), [canceled]);
  assert.deepEqual(filterManagedBroadcastsByHistoryFilter([canceled], 'error'), []);
});
