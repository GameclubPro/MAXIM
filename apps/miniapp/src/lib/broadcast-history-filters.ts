import type { ManagedBroadcastSummary } from '@maxim/contracts';

export type BroadcastHistoryFilter = 'future' | 'active' | 'error' | 'sent' | 'canceled';

export type BroadcastHistoryCounts = Record<BroadcastHistoryFilter, number>;

const EMPTY_HISTORY_COUNTS: BroadcastHistoryCounts = {
  future: 0,
  active: 0,
  error: 0,
  sent: 0,
  canceled: 0,
};

function isFutureBroadcast(broadcast: ManagedBroadcastSummary): boolean {
  return (
    (broadcast.status === 'ACTIVE' || broadcast.status === 'PARTIAL') &&
    Boolean(broadcast.nextSendAt)
  );
}

function isActiveBroadcast(broadcast: ManagedBroadcastSummary): boolean {
  return (
    (broadcast.status === 'ACTIVE' || broadcast.status === 'PARTIAL') &&
    !isFutureBroadcast(broadcast)
  );
}

function isErrorBroadcast(broadcast: ManagedBroadcastSummary): boolean {
  const blockedFailures =
    broadcast.blockedChats > 0 ||
    broadcast.failureBreakdown.permanentTarget > 0 ||
    broadcast.failureBreakdown.quarantined > 0;

  return (
    broadcast.status === 'FAILED' ||
    broadcast.status === 'PARTIAL' ||
    broadcast.failedChats > 0 ||
    blockedFailures ||
    Boolean(broadcast.lastError) ||
    broadcast.canRetry
  );
}

function resolveManagedBroadcastHistoryFilter(
  broadcast: ManagedBroadcastSummary,
): BroadcastHistoryFilter | null {
  if (broadcast.status === 'CANCELED') {
    return 'canceled';
  }

  if (isErrorBroadcast(broadcast)) {
    return 'error';
  }

  if (broadcast.status === 'COMPLETED') {
    return 'sent';
  }

  if (isFutureBroadcast(broadcast)) {
    return 'future';
  }

  if (isActiveBroadcast(broadcast)) {
    return 'active';
  }

  return null;
}

export function filterManagedBroadcastsByHistoryFilter<T extends ManagedBroadcastSummary>(
  broadcasts: T[],
  filter: BroadcastHistoryFilter,
): T[] {
  return broadcasts.filter(
    (broadcast) => resolveManagedBroadcastHistoryFilter(broadcast) === filter,
  );
}

export function countManagedBroadcastHistoryFilters(
  broadcasts: ManagedBroadcastSummary[],
): BroadcastHistoryCounts {
  return broadcasts.reduce<BroadcastHistoryCounts>(
    (counts, broadcast) => {
      const bucket = resolveManagedBroadcastHistoryFilter(broadcast);
      if (bucket) {
        counts[bucket] += 1;
      }

      return counts;
    },
    { ...EMPTY_HISTORY_COUNTS },
  );
}
