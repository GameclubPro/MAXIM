import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  ChatSummary,
  ManagedEntitiesListResponse,
  ManagedEntitiesRefreshState,
} from '@maxim/contracts';
import { getChannels, getChats } from './api/root-client';
import { isUnusableChatTitle, resolveChatTitle } from './chat-titles';
import type { ApiTransport } from './api/transport';

const MANAGED_ENTITIES_REFRESH_FALLBACK_DELAY_MS = 900;
const MANAGED_ENTITIES_LOCAL_CACHE_VERSION = 2;
const MANAGED_ENTITIES_LOCAL_COMPLETE_STATE: ManagedEntitiesRefreshState = {
  complete: true,
  cursor: -1,
  backoffActive: false,
  nextPollAfterMs: 0,
  processedCandidates: null,
  totalCandidates: null,
  progressPercent: 100,
  lastSyncedAt: null,
};

type ManagedEntityKind = 'chat' | 'channel';
type ManagedEntitiesSyncPhase = 'idle' | 'loading' | 'syncing' | 'complete' | 'backoff' | 'error';
type ManagedEntitiesRefreshRequestOptions = {
  bypassRemoteCache?: boolean;
  resetRefreshCursor?: boolean;
};

type ManagedEntitiesLocalCachePayload = {
  version: number;
  items: ChatSummary[];
  updatedAt: string;
};

type ManagedEntitiesSyncState = {
  data: ChatSummary[] | null;
  error: Error | null;
  refreshState: ManagedEntitiesRefreshState | null;
  phase: ManagedEntitiesSyncPhase;
};

const EMPTY_SYNC_STATE: ManagedEntitiesSyncState = {
  data: null,
  error: null,
  refreshState: null,
  phase: 'loading',
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

function buildManagedEntitiesLocalCacheKey(
  entityType: ManagedEntityKind,
  scope: string,
): string {
  return `maxim:managed-entities:v${MANAGED_ENTITIES_LOCAL_CACHE_VERSION}:${scope}:${entityType}`;
}

function readManagedEntitiesLocalCacheUserScope(): string {
  if (typeof window === 'undefined') {
    return 'default';
  }

  const bridgeCandidates = [
    window.MAX?.WebApp?.initDataUnsafe,
    window.MAX?.WebApp?.init_data_unsafe,
    window.WebApp?.initDataUnsafe,
    window.WebApp?.init_data_unsafe,
  ];

  for (const candidate of bridgeCandidates) {
    const userId =
      (candidate as { user?: { id?: unknown } } | undefined)?.user?.id ??
      (candidate as { user_id?: unknown } | undefined)?.user_id;
    if (typeof userId === 'string' || typeof userId === 'number') {
      const normalized = String(userId).trim();
      if (normalized) {
        return `user:${normalized}`;
      }
    }
  }

  return 'default';
}

function sanitizeManagedEntities(
  items: ChatSummary[],
  options: { dropUnusableTitles?: boolean } = {},
): ChatSummary[] {
  const sanitized: ChatSummary[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    const normalizedId = item.id.trim();
    if (!normalizedId || seen.has(normalizedId)) {
      continue;
    }
    seen.add(normalizedId);

    const resolvedTitle = resolveChatTitle(normalizedId, item.title);
    if (options.dropUnusableTitles === true && isUnusableChatTitle(normalizedId, resolvedTitle)) {
      continue;
    }

    sanitized.push(
      resolvedTitle === item.title
        ? item
        : {
            ...item,
            title: resolvedTitle,
          },
    );
  }

  return sanitized;
}

function sanitizeManagedEntitiesOrNull(items: ChatSummary[] | null | undefined): ChatSummary[] | null {
  if (!Array.isArray(items) || items.length === 0) {
    return null;
  }

  const sanitized = sanitizeManagedEntities(items);
  return sanitized.length > 0 ? sanitized : null;
}

function readManagedEntitiesLocalCache(
  entityType: ManagedEntityKind,
  scope: string,
): ChatSummary[] | null {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(buildManagedEntitiesLocalCacheKey(entityType, scope));
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as ManagedEntitiesLocalCachePayload | null;
    if (!parsed || parsed.version !== MANAGED_ENTITIES_LOCAL_CACHE_VERSION) {
      return null;
    }

    return Array.isArray(parsed.items) ? sanitizeManagedEntities(parsed.items) : null;
  } catch {
    return null;
  }
}

function saveManagedEntitiesLocalCache(
  entityType: ManagedEntityKind,
  scope: string,
  items: ChatSummary[],
): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    const sanitizedItems = sanitizeManagedEntities(items, { dropUnusableTitles: true });
    const payload: ManagedEntitiesLocalCachePayload = {
      version: MANAGED_ENTITIES_LOCAL_CACHE_VERSION,
      items: sanitizedItems,
      updatedAt: new Date().toISOString(),
    };
    window.localStorage.setItem(
      buildManagedEntitiesLocalCacheKey(entityType, scope),
      JSON.stringify(payload),
    );
  } catch {
    // Ignore localStorage failures in restrictive WebView environments.
  }
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
  options: { fresh?: boolean } = {},
): Promise<ChatSummary[]> {
  return entityType === 'chat'
    ? getChats(api, { fresh: options.fresh === true })
    : getChannels(api, { fresh: options.fresh === true });
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
  freshOnLoad = false,
  syncOnFirstLoad = false,
  backgroundRefreshOnFirstLoad = false,
  reloadOnMount = false,
  freshOnManualReload = false,
  persistLocalCache = false,
  localCacheScope = 'default',
}: {
  api: ApiTransport;
  entityType: ManagedEntityKind;
  enabled?: boolean;
  reloadNonce?: number;
  resumeOnVisibilityReturn?: boolean;
  skipInitialSyncIfCached?: boolean;
  freshOnLoad?: boolean;
  syncOnFirstLoad?: boolean;
  backgroundRefreshOnFirstLoad?: boolean;
  reloadOnMount?: boolean;
  freshOnManualReload?: boolean;
  persistLocalCache?: boolean;
  localCacheScope?: string;
}): ManagedEntitiesSyncResult {
  const queryClient = useQueryClient();
  const cacheKey = useMemo(() => ['managed-entities-sync', entityType] as const, [entityType]);
  const effectiveLocalCacheScope = useMemo(
    () => `${localCacheScope}:${readManagedEntitiesLocalCacheUserScope()}`,
    [localCacheScope],
  );
  const cachedState = queryClient.getQueryData<ManagedEntitiesSyncState>(cacheKey) ?? null;
  const persistedData = useMemo(
    () =>
      persistLocalCache ? readManagedEntitiesLocalCache(entityType, effectiveLocalCacheScope) : null,
    [effectiveLocalCacheScope, entityType, persistLocalCache],
  );
  const initialCachedData = useMemo(
    () => sanitizeManagedEntitiesOrNull(cachedState?.data ?? persistedData),
    [cachedState?.data, persistedData],
  );
  const [state, setState] = useState<ManagedEntitiesSyncState>(
    () =>
      freshOnLoad
        ? {
            ...EMPTY_SYNC_STATE,
          }
        : cachedState ??
          (initialCachedData !== null
            ? {
                data: initialCachedData,
                error: null,
                refreshState: MANAGED_ENTITIES_LOCAL_COMPLETE_STATE,
                phase: 'complete',
              }
            : {
                ...EMPTY_SYNC_STATE,
              }),
  );
  const [visibilityResumeNonce, setVisibilityResumeNonce] = useState(0);
  const latestDataRef = useRef<ChatSummary[] | null>(
    freshOnLoad
      ? sanitizeManagedEntitiesOrNull(cachedState?.data ?? persistedData)
      : state.data,
  );
  const skippedInitialSyncRef = useRef(false);
  const handledReloadNonceRef = useRef(reloadNonce);
  const backoffResumeAtRef = useRef<number | null>(null);

  useEffect(() => {
    queryClient.setQueryData(cacheKey, state);
  }, [cacheKey, queryClient, state]);

  useEffect(() => {
    if (
      !persistLocalCache ||
      state.error !== null ||
      state.data === null ||
      state.refreshState?.complete !== true
    ) {
      return;
    }

    saveManagedEntitiesLocalCache(entityType, effectiveLocalCacheScope, state.data);
  }, [
    effectiveLocalCacheScope,
    entityType,
    persistLocalCache,
    state.data,
    state.error,
    state.refreshState?.complete,
  ]);

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

    if (
      !freshOnLoad &&
      skipInitialSyncIfCached &&
      !skippedInitialSyncRef.current &&
      latestDataRef.current !== null
    ) {
      skippedInitialSyncRef.current = true;
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
    const forceRefreshSession = reloadNonce !== handledReloadNonceRef.current;
    handledReloadNonceRef.current = reloadNonce;
    const hasCachedData = latestDataRef.current !== null;
    const shouldStartWithBackgroundRefresh =
      forceRefreshSession || (backgroundRefreshOnFirstLoad && !hasCachedData);
    setState((current) => ({
      ...current,
      error: hasCachedData ? null : current.error,
      phase: hasCachedData ? 'syncing' : 'loading',
    }));

    const syncEntities = async () => {
      try {
        let forceRefreshPending = forceRefreshSession;
        const manualRefreshUsesFresh = forceRefreshPending && freshOnManualReload;
        const documentVisible =
          typeof document === 'undefined' || document.visibilityState === 'visible';

        if (!shouldStartWithBackgroundRefresh || manualRefreshUsesFresh) {
          const initial = await loadManagedEntities(api, entityType, {
            fresh: freshOnLoad || manualRefreshUsesFresh,
          });
          if (cancelled) {
            return;
          }

          const initialData = sanitizeManagedEntities(
            mergeManagedEntityPresentation(latestDataRef.current, initial),
          );
          latestDataRef.current = initialData;

          if (
            (!hasCachedData || freshOnLoad || reloadOnMount) &&
            !forceRefreshPending &&
            !syncOnFirstLoad
          ) {
            setState({
              data: initialData,
              error: null,
              refreshState: MANAGED_ENTITIES_LOCAL_COMPLETE_STATE,
              phase: documentVisible ? 'complete' : 'idle',
            });
            return;
          }

          if (manualRefreshUsesFresh) {
            setState({
              data: initialData,
              error: null,
              refreshState: MANAGED_ENTITIES_LOCAL_COMPLETE_STATE,
              phase: documentVisible ? 'complete' : 'idle',
            });
            return;
          }

          setState({
            data: initialData,
            error: null,
            refreshState: null,
            phase: documentVisible ? 'syncing' : 'idle',
          });

          if (!documentVisible) {
            return;
          }
        }

        let resetRefreshCursor = shouldStartWithBackgroundRefresh;

        while (!cancelled) {
          if (
            typeof document !== 'undefined' &&
            document.visibilityState !== 'visible' &&
            latestDataRef.current !== null
          ) {
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
            resetRefreshCursor: resetRefreshCursor,
          });
          forceRefreshPending = false;
          resetRefreshCursor = false;
          if (cancelled) {
            return;
          }

          const nextData = sanitizeManagedEntities(
            mergeManagedEntityPresentation(latestDataRef.current, next.items),
          );
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
    enabled,
    entityType,
    backgroundRefreshOnFirstLoad,
    freshOnLoad,
    freshOnManualReload,
    reloadNonce,
    reloadOnMount,
    skipInitialSyncIfCached,
    syncOnFirstLoad,
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
