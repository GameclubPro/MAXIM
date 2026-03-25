import { useEffect, useRef, useState } from 'react';
import type {
  ChatSummary,
  ManagedEntitiesListResponse,
  ManagedEntitiesRefreshState,
} from '@maxim/contracts';
import { getChannels, getChats } from './api/root-client';
import type { ApiTransport } from './api/transport';

const MANAGED_ENTITIES_REFRESH_DELAY_MS = 900;

type ManagedEntityKind = 'chat' | 'channel';
type ManagedEntitiesSyncPhase = 'idle' | 'loading' | 'syncing' | 'complete' | 'backoff' | 'error';

type ManagedEntitiesSyncState = {
  data: ChatSummary[] | null;
  error: Error | null;
  refreshState: ManagedEntitiesRefreshState | null;
  phase: ManagedEntitiesSyncPhase;
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

async function loadManagedEntities(
  api: ApiTransport,
  entityType: ManagedEntityKind,
): Promise<ChatSummary[]> {
  return entityType === 'chat' ? getChats(api) : getChannels(api);
}

async function refreshManagedEntities(
  api: ApiTransport,
  entityType: ManagedEntityKind,
): Promise<ManagedEntitiesListResponse> {
  return entityType === 'chat'
    ? getChats(api, { refresh: true, includeRefreshState: true })
    : getChannels(api, { refresh: true, includeRefreshState: true });
}

export function useManagedEntitiesSync({
  api,
  entityType,
  enabled = true,
  reloadNonce = 0,
  resumeOnVisibilityReturn = false,
}: {
  api: ApiTransport;
  entityType: ManagedEntityKind;
  enabled?: boolean;
  reloadNonce?: number;
  resumeOnVisibilityReturn?: boolean;
}): ManagedEntitiesSyncResult {
  const [state, setState] = useState<ManagedEntitiesSyncState>({
    data: null,
    error: null,
    refreshState: null,
    phase: 'loading',
  });
  const [visibilityResumeNonce, setVisibilityResumeNonce] = useState(0);
  const latestDataRef = useRef<ChatSummary[] | null>(null);

  useEffect(() => {
    if (!enabled || !resumeOnVisibilityReturn || typeof document === 'undefined') {
      return;
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') {
        return;
      }
      if (state.phase !== 'idle' || state.data === null) {
        return;
      }
      if (state.refreshState?.complete || state.refreshState?.backoffActive) {
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
  ]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    let cancelled = false;
    const hasCachedData = latestDataRef.current !== null;
    setState((current) => ({
      ...current,
      error: hasCachedData ? null : current.error,
      phase: hasCachedData ? 'syncing' : 'loading',
    }));

    const syncEntities = async () => {
      try {
        const initial = await loadManagedEntities(api, entityType);
        if (cancelled) {
          return;
        }

        latestDataRef.current = initial;
        const documentVisible =
          typeof document === 'undefined' || document.visibilityState === 'visible';
        setState({
          data: initial,
          error: null,
          refreshState: null,
          phase: documentVisible ? 'syncing' : 'idle',
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

          const next = await refreshManagedEntities(api, entityType);
          if (cancelled) {
            return;
          }

          latestDataRef.current = next.items;
          const phase = next.refresh.complete
            ? 'complete'
            : next.refresh.backoffActive
              ? 'backoff'
              : 'syncing';
          setState({
            data: next.items,
            error: null,
            refreshState: next.refresh,
            phase,
          });

          if (next.refresh.complete || next.refresh.backoffActive) {
            return;
          }

          await delay(MANAGED_ENTITIES_REFRESH_DELAY_MS);
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
  }, [api, enabled, entityType, reloadNonce, visibilityResumeNonce]);

  return {
    ...state,
    isLoading: state.phase === 'loading' && state.data === null,
    isRefreshing: state.phase === 'syncing',
    isSyncComplete: state.refreshState?.complete === true,
    isBackoffActive: state.refreshState?.backoffActive === true,
  };
}
