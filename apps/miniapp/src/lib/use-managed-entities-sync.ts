import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  ChatSummary,
  ManagedEntitiesListResponse,
  ManagedEntitiesRefreshState,
} from '@maxim/contracts';
import { getChannels, getChats } from './api/root-client';
import {
  readManagedEntitiesSnapshot,
  saveManagedEntitiesSnapshot,
  type ManagedEntityKind,
} from './managed-entities-cache';
import type { ApiTransport } from './api/transport';

const MANAGED_ENTITIES_REFRESH_FALLBACK_DELAY_MS = 900;

type ManagedEntitiesSyncPhase = 'idle' | 'loading' | 'syncing' | 'complete' | 'backoff' | 'error';
type ManagedEntitiesRefreshRequestOptions = {
  bypassRemoteCache?: boolean;
  resetRefreshCursor?: boolean;
};

type ManagedEntitiesSyncState = {
  data: ChatSummary[] | null;
  error: Error | null;
  refreshState: ManagedEntitiesRefreshState | null;
  phase: ManagedEntitiesSyncPhase;
  lastSyncedAtMs: number | null;
};

const EMPTY_SYNC_STATE: ManagedEntitiesSyncState = {
  data: null,
  error: null,
  refreshState: null,
  phase: 'loading',
  lastSyncedAtMs: null,
};

export type ManagedEntitiesSyncResult = ManagedEntitiesSyncState & {
  isLoading: boolean;
  isRefreshing: boolean;
  isSyncComplete: boolean;
  isBackoffActive: boolean;
};

function delay(ms: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error('Не удалось загрузить список.');
}

function mergeManagedEntityPresentation(
  previous: ChatSummary[] | null,
  next: ChatSummary[],
): ChatSummary[] {
  if (!previous || previous.length === 0 || next.length === 0) {
    return next;
  }

  const previousById = new Map(previous.map((item) => [item.id, item]));
  let changed = false;

  const merged = next.map((item) => {
    if (item.avatarUrl) {
      return item;
    }

    const previousItem = previousById.get(item.id);
    if (!previousItem?.avatarUrl) {
      return item;
    }

    changed = true;
    return {
      ...item,
      avatarUrl: previousItem.avatarUrl,
    };
  });

  return changed ? merged : next;
}

async function loadManagedEntities(
  api: ApiTransport,
  entityType: ManagedEntityKind,
): Promise<ChatSummary[]> {
  return entityType === 'chat' ? getChats(api) : getChannels(api);
}

async function refreshManagedEntities(
  api: ApiTransport,
  entityType: ManagedEntityKind,
  options: ManagedEntitiesRefreshRequestOptions = {},
): Promise<ManagedEntitiesListResponse> {
  return entityType === 'chat'
    ? getChats(api, {
        refresh: true,
        includeRefreshState: true,
        bypassRemoteCache: options.bypassRemoteCache,
        resetRefreshCursor: options.resetRefreshCursor,
      })
    : getChannels(api, {
        refresh: true,
        includeRefreshState: true,
        bypassRemoteCache: options.bypassRemoteCache,
        resetRefreshCursor: options.resetRefreshCursor,
      });
}

export function useManagedEntitiesSync({
  api,
  entityType,
  enabled = true,
  reloadNonce = 0,
  resumeOnVisibilityReturn = false,
  skipInitialSyncIfCached = false,
  cacheMaxAgeMs = 0,
}: {
  api: ApiTransport;
  entityType: ManagedEntityKind;
  enabled?: boolean;
  reloadNonce?: number;
  resumeOnVisibilityReturn?: boolean;
  skipInitialSyncIfCached?: boolean;
  cacheMaxAgeMs?: number;
}): ManagedEntitiesSyncResult {
  const queryClient = useQueryClient();
  const cacheKey = useMemo(() => ['managed-entities-sync', entityType] as const, [entityType]);
  const [state, setState] = useState<ManagedEntitiesSyncState>(() => {
    const cachedState = queryClient.getQueryData<ManagedEntitiesSyncState>(cacheKey);
    if (cachedState) {
      return cachedState;
    }

    const snapshot = readManagedEntitiesSnapshot(entityType);
    if (!snapshot) {
      return {
        ...EMPTY_SYNC_STATE,
      };
    }

    return {
      data: snapshot.items,
      error: null,
      refreshState: snapshot.refreshState,
      phase: snapshot.refreshState?.complete
        ? 'complete'
        : snapshot.refreshState?.backoffActive
          ? 'backoff'
          : 'idle',
      lastSyncedAtMs: snapshot.lastSyncedAtMs,
    };
  });
  const [visibilityResumeNonce, setVisibilityResumeNonce] = useState(0);
  const latestDataRef = useRef<ChatSummary[] | null>(state.data);
  const skippedInitialSyncRef = useRef(false);
  const handledReloadNonceRef = useRef(reloadNonce);
  const backoffResumeAtRef = useRef<number | null>(null);

  useEffect(() => {
    queryClient.setQueryData(cacheKey, state);
  }, [cacheKey, queryClient, state]);

  useEffect(() => {
    latestDataRef.current = state.data;
  }, [state.data]);

  useEffect(() => {
    if (!state.data || state.data.length === 0) {
      return;
    }

    saveManagedEntitiesSnapshot(entityType, {
      items: state.data,
      refreshState: state.refreshState,
      lastSyncedAtMs: state.lastSyncedAtMs,
    });
  }, [entityType, state.data, state.lastSyncedAtMs, state.refreshState]);

  useEffect(() => {
    if (!state.refreshState?.backoffActive) {
      backoffResumeAtRef.current = null;
      return;
    }

    backoffResumeAtRef.current =
      Date.now() +
      (state.refreshState.nextPollAfterMs ?? MANAGED_ENTITIES_REFRESH_FALLBACK_DELAY_MS);
  }, [state.refreshState?.backoffActive, state.refreshState?.nextPollAfterMs]);

  useEffect(() => {
    if (!enabled || !resumeOnVisibilityReturn || typeof document === 'undefined') {
      return;
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') {
        return;
      }
      if ((state.phase !== 'idle' && state.phase !== 'backoff') || state.data === null) {
        return;
      }
      if (state.refreshState?.complete) {
        return;
      }
      if (
        state.refreshState?.backoffActive &&
        typeof backoffResumeAtRef.current === 'number' &&
        Date.now() < backoffResumeAtRef.current
      ) {
        return;
      }

      setVisibilityResumeNonce((current) => current + 1);
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [
    enabled,
    resumeOnVisibilityReturn,
    state.data,
    state.phase,
    state.refreshState?.backoffActive,
    state.refreshState?.complete,
    state.refreshState?.nextPollAfterMs,
  ]);

  useEffect(() => {
    if (
      !enabled ||
      state.refreshState?.backoffActive !== true ||
      typeof window === 'undefined' ||
      (typeof document !== 'undefined' && document.visibilityState !== 'visible')
    ) {
      return;
    }

    const resumeAtMs =
      backoffResumeAtRef.current ??
      Date.now() +
        (state.refreshState.nextPollAfterMs ?? MANAGED_ENTITIES_REFRESH_FALLBACK_DELAY_MS);
    const delayMs = Math.max(0, resumeAtMs - Date.now());
    const timeoutId = window.setTimeout(() => {
      setVisibilityResumeNonce((current) => current + 1);
    }, delayMs);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [enabled, state.refreshState?.backoffActive, state.refreshState?.nextPollAfterMs]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const forceRefreshSession = reloadNonce !== handledReloadNonceRef.current;

    if (
      skipInitialSyncIfCached &&
      !forceRefreshSession &&
      !skippedInitialSyncRef.current &&
      latestDataRef.current !== null &&
      state.lastSyncedAtMs !== null &&
      (cacheMaxAgeMs <= 0 || Date.now() - state.lastSyncedAtMs <= cacheMaxAgeMs)
    ) {
      skippedInitialSyncRef.current = true;
      handledReloadNonceRef.current = reloadNonce;
      setState((current) => ({
        ...current,
        error: null,
        phase: current.refreshState?.complete
          ? 'complete'
          : current.refreshState?.backoffActive
            ? 'backoff'
            : 'idle',
      }));
      return;
    }

    skippedInitialSyncRef.current = true;

    let cancelled = false;
    handledReloadNonceRef.current = reloadNonce;
    const hasCachedData = latestDataRef.current !== null;
    setState((current) => ({
      ...current,
      error: hasCachedData ? null : current.error,
      phase: hasCachedData ? 'syncing' : 'loading',
    }));

    const syncEntities = async () => {
      try {
        let forceRefreshPending = forceRefreshSession;
        const initial = await loadManagedEntities(api, entityType);
        if (cancelled) {
          return;
        }

        const initialData = mergeManagedEntityPresentation(latestDataRef.current, initial);
        latestDataRef.current = initialData;
        const documentVisible =
          typeof document === 'undefined' || document.visibilityState === 'visible';
        setState({
          data: initialData,
          error: null,
          refreshState: null,
          phase: documentVisible ? 'syncing' : 'idle',
          lastSyncedAtMs: Date.now(),
        });

        if (!documentVisible) {
          return;
        }

        while (!cancelled) {
          if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
            setState((current) => ({
              ...current,
              phase: current.refreshState?.complete
                ? 'complete'
                : current.refreshState?.backoffActive
                  ? 'backoff'
                  : 'idle',
            }));
            return;
          }

          const next = await refreshManagedEntities(api, entityType, {
            bypassRemoteCache: forceRefreshPending,
            resetRefreshCursor: forceRefreshPending,
          });
          forceRefreshPending = false;
          if (cancelled) {
            return;
          }

          const nextData = mergeManagedEntityPresentation(latestDataRef.current, next.items);
          latestDataRef.current = nextData;
          const phase = next.refresh.complete
            ? 'complete'
            : next.refresh.backoffActive
              ? 'backoff'
              : 'syncing';
          setState({
            data: nextData,
            error: null,
            refreshState: next.refresh,
            phase,
            lastSyncedAtMs: Date.now(),
          });

          if (next.refresh.complete || next.refresh.backoffActive) {
            return;
          }

          await delay(next.refresh.nextPollAfterMs ?? MANAGED_ENTITIES_REFRESH_FALLBACK_DELAY_MS);
        }
      } catch (error: unknown) {
        if (cancelled) {
          return;
        }

        const normalizedError = normalizeError(error);
        const hasData = latestDataRef.current !== null;
        setState((current) => ({
          ...current,
          error: hasData ? null : normalizedError,
          phase: hasData
            ? current.refreshState?.complete
              ? 'complete'
              : current.refreshState?.backoffActive
                ? 'backoff'
                : 'idle'
            : 'error',
        }));
      }
    };

    void syncEntities();

    return () => {
      cancelled = true;
    };
  }, [
    api,
    cacheMaxAgeMs,
    enabled,
    entityType,
    reloadNonce,
    skipInitialSyncIfCached,
    visibilityResumeNonce,
  ]);

  return {
    ...state,
    isLoading: state.phase === 'loading' && state.data === null,
    isRefreshing: state.phase === 'syncing',
    isSyncComplete: state.refreshState?.complete === true,
    isBackoffActive: state.refreshState?.backoffActive === true,
  };
}
