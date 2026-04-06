import { useEffect, useRef } from 'react';
import { shouldRefreshManagedEntitiesOnVisibilityReturn } from './managed-entities-visibility-refresh';

export const MANAGED_ENTITIES_VISIBILITY_REFRESH_MIN_INTERVAL_MS = 15_000;
export const MANAGED_ENTITIES_VISIBILITY_REFRESH_MIN_HIDDEN_MS = 2_000;

export function buildManagedEntitiesSettledMarker(options: {
  scopeKey?: string | null;
  hasLoadedFromServer: boolean;
  isSyncComplete: boolean;
  isBackoffActive: boolean;
  snapshotVersion: string | null | undefined;
  snapshotBuiltAt: string | null | undefined;
  lastSyncedAt: string | null | undefined;
}): string | null {
  if (!options.hasLoadedFromServer) {
    return null;
  }
  if (!options.isSyncComplete && !options.isBackoffActive) {
    return null;
  }

  return [
    options.scopeKey ?? null,
    options.snapshotVersion ?? 'no-snapshot',
    options.snapshotBuiltAt ?? '',
    options.lastSyncedAt ?? '',
    options.isBackoffActive ? 'backoff' : 'complete',
  ]
    .filter((value): value is string => value !== null)
    .join(':');
}

export function useManagedEntitiesVisibilityRefresh(options: {
  enabled?: boolean;
  hasLoadedFromServer: boolean;
  isLoading: boolean;
  isRefreshing: boolean;
  isSyncComplete: boolean;
  snapshotStale: boolean | null;
  settledMarker: string | null;
  minIntervalMs: number;
  minHiddenDurationMs: number;
  onVisibilityReturnRefresh: () => void;
}) {
  const lastRefreshAtRef = useRef(0);
  const lastSettledMarkerRef = useRef<string | null>(null);
  const awaitingReturnRefreshRef = useRef(false);
  const hiddenAtRef = useRef<number | null>(null);

  useEffect(() => {
    if (!options.settledMarker) {
      return;
    }
    if (lastSettledMarkerRef.current === options.settledMarker) {
      return;
    }

    lastSettledMarkerRef.current = options.settledMarker;
    lastRefreshAtRef.current = Date.now();
  }, [options.settledMarker]);

  function noteRefreshRequested() {
    lastRefreshAtRef.current = Date.now();
    awaitingReturnRefreshRef.current = false;
    hiddenAtRef.current = null;
  }

  useEffect(() => {
    if (!options.enabled || typeof document === 'undefined' || typeof window === 'undefined') {
      return;
    }

    const markRefreshOnReturn = () => {
      awaitingReturnRefreshRef.current = true;
      hiddenAtRef.current = Date.now();
    };

    const refreshAfterReturn = () => {
      const now = Date.now();
      const hiddenDurationMs =
        typeof hiddenAtRef.current === 'number' ? Math.max(0, now - hiddenAtRef.current) : null;

      if (
        !shouldRefreshManagedEntitiesOnVisibilityReturn({
          awaitingReturnRefresh: awaitingReturnRefreshRef.current,
          documentVisible: document.visibilityState === 'visible',
          isLoading: options.isLoading,
          isRefreshing: options.isRefreshing,
          hasLoadedFromServer: options.hasLoadedFromServer,
          isSyncComplete: options.isSyncComplete,
          snapshotStale: options.snapshotStale,
          hiddenDurationMs,
          lastRefreshAtMs: lastRefreshAtRef.current,
          nowMs: now,
          minIntervalMs: options.minIntervalMs,
          minHiddenDurationMs: options.minHiddenDurationMs,
        })
      ) {
        return;
      }

      noteRefreshRequested();
      options.onVisibilityReturnRefresh();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        markRefreshOnReturn();
        return;
      }

      refreshAfterReturn();
    };

    window.addEventListener('blur', markRefreshOnReturn);
    window.addEventListener('pagehide', markRefreshOnReturn);
    window.addEventListener('focus', refreshAfterReturn);
    window.addEventListener('pageshow', refreshAfterReturn);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('blur', markRefreshOnReturn);
      window.removeEventListener('pagehide', markRefreshOnReturn);
      window.removeEventListener('focus', refreshAfterReturn);
      window.removeEventListener('pageshow', refreshAfterReturn);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [
    options.enabled,
    options.hasLoadedFromServer,
    options.isLoading,
    options.isRefreshing,
    options.isSyncComplete,
    options.minHiddenDurationMs,
    options.minIntervalMs,
    options.onVisibilityReturnRefresh,
    options.snapshotStale,
  ]);

  return {
    noteRefreshRequested,
  };
}
