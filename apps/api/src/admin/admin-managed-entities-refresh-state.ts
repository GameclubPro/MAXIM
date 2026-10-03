import type { ManagedEntitiesRefreshState } from '@maxim/contracts';
import {
  MANAGED_ENTITIES_REFRESH_BACKOFF_MS,
  MANAGED_ENTITIES_REFRESH_CURSOR_DONE,
  MANAGED_ENTITIES_REFRESH_IDLE_NEXT_POLL_AFTER_MS,
  MANAGED_ENTITIES_REFRESH_NEXT_POLL_AFTER_MS,
  MANAGED_ENTITIES_MANUAL_REFRESH_RECENT_SYNC_WINDOW_MS,
  type ManagedEntitiesManualRefreshBlockReason,
  type ManagedEntitiesRefreshPresentation,
} from './admin.service.support';

export function createManagedEntitiesRefreshState(
  cursor: number | null,
  backoffActive: boolean,
  nextPollAfterMsOverride?: number,
  presentation: ManagedEntitiesRefreshPresentation = {
    totalCandidates: null,
    lastSyncedAt: null,
  },
): ManagedEntitiesRefreshState {
  const normalizedNextPollAfterMs =
    typeof nextPollAfterMsOverride === 'number'
      ? Math.max(0, Math.ceil(nextPollAfterMsOverride))
      : backoffActive
        ? MANAGED_ENTITIES_REFRESH_BACKOFF_MS
        : cursor === MANAGED_ENTITIES_REFRESH_CURSOR_DONE
          ? 0
          : cursor === null
            ? MANAGED_ENTITIES_REFRESH_IDLE_NEXT_POLL_AFTER_MS
            : MANAGED_ENTITIES_REFRESH_NEXT_POLL_AFTER_MS;
  const manualRefreshBlock = resolveManagedEntitiesManualRefreshBlockState(
    cursor,
    backoffActive,
    normalizedNextPollAfterMs,
    presentation.lastSyncedAt ?? null,
  );
  const totalCandidates =
    typeof presentation.totalCandidates === 'number' &&
    Number.isFinite(presentation.totalCandidates)
      ? Math.max(0, Math.trunc(presentation.totalCandidates))
      : null;
  const processedCandidates =
    totalCandidates === null
      ? null
      : cursor === MANAGED_ENTITIES_REFRESH_CURSOR_DONE
        ? totalCandidates
        : cursor === null
          ? 0
          : Math.max(0, Math.min(totalCandidates, Math.trunc(cursor)));
  const progressPercent =
    cursor === MANAGED_ENTITIES_REFRESH_CURSOR_DONE
      ? 100
      : totalCandidates === null
        ? null
        : totalCandidates === 0
          ? 100
          : processedCandidates === null
            ? null
            : Math.max(0, Math.min(100, Math.round((processedCandidates / totalCandidates) * 100)));

  return {
    complete: cursor === MANAGED_ENTITIES_REFRESH_CURSOR_DONE,
    cursor,
    backoffActive,
    nextPollAfterMs: normalizedNextPollAfterMs,
    processedCandidates,
    totalCandidates,
    progressPercent,
    lastSyncedAt: presentation.lastSyncedAt ?? null,
    manualRefreshBlockedReason: manualRefreshBlock.reason,
    manualRefreshRetryAfterMs: manualRefreshBlock.retryAfterMs,
  };
}

export function resolveManagedEntitiesManualRefreshBlockState(
  cursor: number | null,
  backoffActive: boolean,
  nextPollAfterMs: number,
  lastSyncedAt: string | null,
): {
  reason: ManagedEntitiesManualRefreshBlockReason | null;
  retryAfterMs: number | null;
} {
  if (backoffActive) {
    return {
      reason: 'backoff',
      retryAfterMs: Math.max(0, Math.ceil(nextPollAfterMs)),
    };
  }

  if (typeof cursor === 'number' && cursor >= 0) {
    return {
      reason: 'in_progress',
      retryAfterMs: Math.max(0, Math.ceil(nextPollAfterMs)),
    };
  }

  if (!lastSyncedAt) {
    return {
      reason: null,
      retryAfterMs: null,
    };
  }

  const lastSyncedAtMs = Date.parse(lastSyncedAt);
  if (!Number.isFinite(lastSyncedAtMs)) {
    return {
      reason: null,
      retryAfterMs: null,
    };
  }

  const recentSyncRemainingMs =
    MANAGED_ENTITIES_MANUAL_REFRESH_RECENT_SYNC_WINDOW_MS - (Date.now() - lastSyncedAtMs);
  if (recentSyncRemainingMs <= 0) {
    return {
      reason: null,
      retryAfterMs: null,
    };
  }

  return {
    reason: 'recent_sync',
    retryAfterMs: Math.max(0, Math.ceil(recentSyncRemainingMs)),
  };
}
