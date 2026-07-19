import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  ChatSummary,
  ManagedEntitiesListResponse,
  ManagedEntitiesResponseDiff,
  ManagedEntitiesRefreshState,
  ManagedEntitiesResponseSnapshot,
} from '@maxim/contracts';
import { getChannels, getChats } from './api/root-client';
import { isUnusableChatTitle, resolveChatTitle } from './chat-titles';
import { getInitData } from './init-data';
import type { ApiTransport } from './api/transport';

const MANAGED_ENTITIES_REFRESH_FALLBACK_DELAY_MS = 1500;
const MANAGED_ENTITIES_LOCAL_CACHE_VERSION = 2;
const MANAGED_ENTITIES_LOCAL_COMPLETE_STATE: ManagedEntitiesRefreshState = {
  complete: true,
  cursor: -1,
  backoffActive: false,
  userVisibleComplete: true,
  nextPollAfterMs: 0,
  processedCandidates: null,
  totalCandidates: null,
  progressPercent: 100,
  lastSyncedAt: null,
  manualRefreshBlockedReason: null,
  manualRefreshRetryAfterMs: null,
};

type ManagedEntityKind = 'chat' | 'channel';
type ManagedEntitiesSyncPhase = 'idle' | 'loading' | 'syncing' | 'complete' | 'backoff' | 'error';
type ManagedEntitiesReloadBehavior = 'default' | 'manual' | 'recovery';
type ManagedEntitiesRefreshRequestOptions = {
  bypassRemoteCache?: boolean;
  resetRefreshCursor?: boolean;
  sinceVersion?: string | null;
};

type ManagedEntitiesLocalCachePayload = {
  version: number;
  items: ChatSummary[];
  updatedAt: string;
  snapshot?: ManagedEntitiesResponseSnapshot | null;
};

type ManagedEntitiesSyncState = {
  data: ChatSummary[] | null;
  error: Error | null;
  refreshState: ManagedEntitiesRefreshState | null;
  snapshot: ManagedEntitiesResponseSnapshot | null;
  phase: ManagedEntitiesSyncPhase;
  hasLoadedFromServer: boolean;
};

const EMPTY_SYNC_STATE: ManagedEntitiesSyncState = {
  data: null,
  error: null,
  refreshState: null,
  snapshot: null,
  phase: 'loading',
  hasLoadedFromServer: false,
};

export function shouldStartManagedEntitiesBackgroundRefresh(options: {
  forceRefreshSession: boolean;
  backgroundRefreshOnFirstLoad: boolean;
  hasLoadedFromServer: boolean;
}): boolean {
  return (
    options.forceRefreshSession ||
    (options.backgroundRefreshOnFirstLoad && !options.hasLoadedFromServer)
  );
}

export function resolveManagedEntitiesRefreshRequestOptions(options: {
  forceRefreshSession: boolean;
  reloadBehavior: 'default' | 'manual' | 'recovery';
  backgroundRefreshOnFirstLoad: boolean;
  hasLoadedFromServer: boolean;
  hasVisibleData: boolean;
}): {
  startWithBackgroundRefresh: boolean;
  continueWithBackgroundRefreshAfterLoad: boolean;
  bypassRemoteCache: boolean;
  resetRefreshCursor: boolean;
} {
  const requestedBackgroundRefresh = shouldStartManagedEntitiesBackgroundRefresh({
    forceRefreshSession: options.forceRefreshSession,
    backgroundRefreshOnFirstLoad: options.backgroundRefreshOnFirstLoad,
    hasLoadedFromServer: options.hasLoadedFromServer,
  });
  const startWithBackgroundRefresh =
    requestedBackgroundRefresh && (options.forceRefreshSession || options.hasVisibleData);
  const bypassRemoteCache =
    options.forceRefreshSession &&
    (options.reloadBehavior === 'manual' || options.reloadBehavior === 'recovery');

  return {
    startWithBackgroundRefresh,
    continueWithBackgroundRefreshAfterLoad:
      requestedBackgroundRefresh && !startWithBackgroundRefresh,
    bypassRemoteCache,
    // Let the backend resume an in-flight scan instead of restarting from zero on each cold open.
    resetRefreshCursor: false,
  };
}

export function shouldUseFreshManagedEntitiesReload(options: {
  forceRefreshSession: boolean;
  freshOnManualReload: boolean;
  requestedBackgroundRefresh: boolean;
  freshOnBackgroundRefresh: boolean;
}): boolean {
  if (options.forceRefreshSession) {
    return options.freshOnManualReload;
  }

  return options.requestedBackgroundRefresh && options.freshOnBackgroundRefresh;
}

export function shouldSettleManagedEntitiesFreshReload(options: {
  freshReloadUsesFreshEndpoint: boolean;
  startWithBackgroundRefresh: boolean;
  continueWithBackgroundRefreshAfterLoad: boolean;
  forceRefreshSession: boolean;
}): boolean {
  if (!options.freshReloadUsesFreshEndpoint) {
    return false;
  }

  // A fresh reload is a fast, partial MAX revalidation. It can return a small
  // visible subset before the durable background refresh reaches the full allowlist.
  return (
    !options.forceRefreshSession &&
    !options.startWithBackgroundRefresh &&
    !options.continueWithBackgroundRefreshAfterLoad
  );
}

export type ManagedEntitiesSyncResult = ManagedEntitiesSyncState & {
  isLoading: boolean;
  isRefreshing: boolean;
  isSyncComplete: boolean;
  isUserVisibleComplete: boolean;
  isBackoffActive: boolean;
};

function delay(ms: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

export function isManagedEntitiesUserVisibleComplete(
  refreshState: ManagedEntitiesRefreshState | null | undefined,
): boolean {
  return refreshState?.complete === true || refreshState?.userVisibleComplete === true;
}

export function resolveManagedEntitiesSettledPhase(
  refreshState: ManagedEntitiesRefreshState | null | undefined,
  options: {
    treatUserVisibleCompleteAsSettled: boolean;
  },
): ManagedEntitiesSyncPhase {
  const settled =
    refreshState?.complete === true ||
    (options.treatUserVisibleCompleteAsSettled &&
      isManagedEntitiesUserVisibleComplete(refreshState));
  if (settled) {
    return 'complete';
  }

  return refreshState?.backoffActive ? 'backoff' : 'idle';
}

export function shouldContinueManagedEntitiesRefreshPolling(
  refreshState: ManagedEntitiesRefreshState,
  options: {
    treatUserVisibleCompleteAsSettled: boolean;
  },
): boolean {
  if (refreshState.complete || refreshState.backoffActive) {
    return false;
  }

  return !(
    options.treatUserVisibleCompleteAsSettled && isManagedEntitiesUserVisibleComplete(refreshState)
  );
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error('Не удалось загрузить список.');
}

function buildManagedEntitiesLocalCacheKey(entityType: ManagedEntityKind, scope: string): string {
  return `me:v${MANAGED_ENTITIES_LOCAL_CACHE_VERSION}:${scope}:${entityType}`;
}

export function readManagedEntitiesLocalCacheUserScope(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const initDataUserScope = readManagedEntitiesLocalCacheUserScopeFromInitData(getInitData());
  if (initDataUserScope) {
    return initDataUserScope;
  }

  return null;
}

export function readManagedEntitiesLocalCacheUserScopeFromInitData(
  initData: string | null | undefined,
): string | null {
  if (typeof initData !== 'string' || initData.trim().length === 0) {
    return null;
  }

  const params = new URLSearchParams(initData);
  const directUserId = params.get('user_id');
  if (directUserId?.trim()) {
    return `u:${directUserId.trim()}`;
  }

  const rawUser = params.get('user');
  if (!rawUser?.trim()) {
    return null;
  }

  try {
    const parsed = JSON.parse(rawUser) as { id?: unknown } | null;
    if (typeof parsed?.id === 'string' || typeof parsed?.id === 'number') {
      const normalized = String(parsed.id).trim();
      if (normalized) {
        return `u:${normalized}`;
      }
    }
  } catch {
    return null;
  }

  return null;
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

function sanitizeManagedEntitiesOrNull(
  items: ChatSummary[] | null | undefined,
): ChatSummary[] | null {
  if (!Array.isArray(items) || items.length === 0) {
    return null;
  }

  const sanitized = sanitizeManagedEntities(items);
  return sanitized.length > 0 ? sanitized : null;
}

function sanitizeManagedEntitiesSnapshot(
  snapshot: ManagedEntitiesResponseSnapshot | null | undefined,
): ManagedEntitiesResponseSnapshot | null {
  if (!snapshot) {
    return null;
  }

  const version = snapshot.version.trim();
  const builtAt = snapshot.builtAt.trim();
  if (!version || !builtAt) {
    return null;
  }

  return {
    version,
    builtAt,
    lastSyncedAt:
      typeof snapshot.lastSyncedAt === 'string' && snapshot.lastSyncedAt.trim().length > 0
        ? snapshot.lastSyncedAt.trim()
        : null,
    source: snapshot.source,
    stale: snapshot.stale === true,
  };
}

function normalizeManagedEntitiesSnapshotVersion(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function readManagedEntitiesLocalCache(
  entityType: ManagedEntityKind,
  scope: string,
): ManagedEntitiesLocalCachePayload | null {
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

    return {
      version: parsed.version,
      items: Array.isArray(parsed.items) ? sanitizeManagedEntities(parsed.items) : [],
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
      snapshot: sanitizeManagedEntitiesSnapshot(parsed.snapshot),
    };
  } catch {
    return null;
  }
}

function saveManagedEntitiesLocalCache(
  entityType: ManagedEntityKind,
  scope: string,
  items: ChatSummary[],
  snapshot: ManagedEntitiesResponseSnapshot | null,
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
      snapshot: sanitizeManagedEntitiesSnapshot(snapshot),
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

export function mergeManagedEntitiesInitialItems(options: {
  previous: ChatSummary[] | null;
  next: ChatSummary[];
  preservePreviousOnEmpty?: boolean;
}): ChatSummary[] {
  if (
    options.preservePreviousOnEmpty === true &&
    options.next.length === 0 &&
    Array.isArray(options.previous) &&
    options.previous.length > 0
  ) {
    return options.previous;
  }

  return mergeManagedEntityPresentation(options.previous, options.next);
}

function mergeManagedEntityPresentationItem(
  previousById: ReadonlyMap<string, ChatSummary>,
  next: ChatSummary,
): ChatSummary {
  if (next.avatarUrl) {
    return next;
  }

  const previous = previousById.get(next.id);
  if (!previous?.avatarUrl) {
    return next;
  }

  return {
    ...next,
    avatarUrl: previous.avatarUrl,
  };
}

function mergeManagedEntitiesIncrementally(
  previous: ChatSummary[] | null,
  next: ChatSummary[],
): ChatSummary[] {
  if (!previous || previous.length === 0 || next.length === 0) {
    return next.length > 0 ? next : (previous ?? next);
  }

  const nextById = new Map(next.map((item) => [item.id, item]));
  let changed = false;

  const merged = previous.map((item) => {
    const updated = nextById.get(item.id);
    if (!updated) {
      return item;
    }

    nextById.delete(item.id);
    if (updated !== item) {
      changed = true;
    }
    return updated;
  });

  if (nextById.size === 0) {
    return changed ? merged : previous;
  }

  changed = true;
  for (const item of next) {
    if (nextById.has(item.id)) {
      merged.push(item);
    }
  }

  return merged;
}

export function mergeManagedEntitiesRefreshItems(options: {
  previous: ChatSummary[] | null;
  next: ChatSummary[];
  refreshState: ManagedEntitiesRefreshState;
  preservePreviousOnEmptyComplete?: boolean;
  keepVisibleOnSameSnapshotVersion?: boolean;
  previousSnapshotVersion?: string | null;
  nextSnapshotVersion?: string | null;
}): ChatSummary[] {
  const previousSnapshotVersion = normalizeManagedEntitiesSnapshotVersion(
    options.previousSnapshotVersion,
  );
  const nextSnapshotVersion = normalizeManagedEntitiesSnapshotVersion(options.nextSnapshotVersion);
  if (
    options.keepVisibleOnSameSnapshotVersion === true &&
    nextSnapshotVersion !== null &&
    previousSnapshotVersion === nextSnapshotVersion &&
    Array.isArray(options.previous)
  ) {
    return options.previous;
  }

  if (
    options.preservePreviousOnEmptyComplete === true &&
    options.refreshState.complete === true &&
    options.next.length === 0 &&
    Array.isArray(options.previous) &&
    options.previous.length > 0
  ) {
    return options.previous;
  }

  const nextWithPresentation = mergeManagedEntityPresentation(options.previous, options.next);

  if (options.refreshState.complete === true) {
    return nextWithPresentation;
  }

  return mergeManagedEntitiesIncrementally(options.previous, nextWithPresentation);
}

export function applyManagedEntitiesResponseDiff(options: {
  previous: ChatSummary[] | null;
  diff: ManagedEntitiesResponseDiff | null | undefined;
  previousSnapshotVersion?: string | null;
}): ChatSummary[] | null {
  const previous = options.previous;
  const diff = options.diff;
  const previousSnapshotVersion = normalizeManagedEntitiesSnapshotVersion(
    options.previousSnapshotVersion,
  );

  if (!Array.isArray(previous) || !diff || previousSnapshotVersion === null) {
    return null;
  }

  if (
    diff.mode === 'noop' &&
    previousSnapshotVersion === normalizeManagedEntitiesSnapshotVersion(diff.baseVersion) &&
    previousSnapshotVersion === normalizeManagedEntitiesSnapshotVersion(diff.nextVersion)
  ) {
    return previous;
  }

  if (
    diff.mode !== 'patch' ||
    previousSnapshotVersion !== normalizeManagedEntitiesSnapshotVersion(diff.baseVersion)
  ) {
    return null;
  }

  const removedIds = new Set(diff.removedIds);
  const previousById = new Map(previous.map((item) => [item.id, item]));
  const nextById = new Map<string, ChatSummary>();

  for (const item of previous) {
    if (!removedIds.has(item.id)) {
      nextById.set(item.id, item);
    }
  }

  for (const item of diff.updated) {
    nextById.set(item.id, mergeManagedEntityPresentationItem(previousById, item));
  }

  for (const item of diff.added) {
    nextById.set(item.id, mergeManagedEntityPresentationItem(previousById, item));
  }

  const orderedIds = diff.orderedIds;
  if (orderedIds.length !== nextById.size) {
    return null;
  }

  const orderedItems: ChatSummary[] = [];
  for (const id of orderedIds) {
    const item = nextById.get(id);
    if (!item) {
      return null;
    }

    orderedItems.push(item);
  }

  return orderedItems;
}

export function resolveManagedEntitiesScopeTransitionState(options: {
  currentState: ManagedEntitiesSyncState;
  nextInitialState: ManagedEntitiesSyncState;
}): ManagedEntitiesSyncState {
  const currentHasVisibleData =
    Array.isArray(options.currentState.data) && options.currentState.data.length > 0;
  const nextHasVisibleData =
    Array.isArray(options.nextInitialState.data) && options.nextInitialState.data.length > 0;

  if (nextHasVisibleData || !currentHasVisibleData) {
    return options.nextInitialState;
  }

  return {
    ...options.currentState,
    error: null,
  };
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
        sinceVersion: options.sinceVersion ?? undefined,
      })
    : getChannels(api, {
        refresh: true,
        includeRefreshState: true,
        bypassRemoteCache: options.bypassRemoteCache,
        resetRefreshCursor: options.resetRefreshCursor,
        sinceVersion: options.sinceVersion ?? undefined,
      });
}

export function useManagedEntitiesSync({
  api,
  entityType,
  enabled = true,
  reloadNonce = 0,
  reloadBehavior = 'default',
  resumeOnVisibilityReturn = false,
  skipInitialSyncIfCached = false,
  freshOnLoad = false,
  syncOnFirstLoad = false,
  backgroundRefreshOnFirstLoad = false,
  reloadOnMount = false,
  freshOnManualReload = false,
  freshOnBackgroundRefresh = false,
  persistLocalCache = false,
  localCacheScope = 'default',
  preserveVisibleDataOnEmptyComplete = false,
  keepVisibleOnSameSnapshotVersion = false,
  treatUserVisibleCompleteAsSettled = false,
}: {
  api: ApiTransport;
  entityType: ManagedEntityKind;
  enabled?: boolean;
  reloadNonce?: number;
  reloadBehavior?: ManagedEntitiesReloadBehavior;
  resumeOnVisibilityReturn?: boolean;
  skipInitialSyncIfCached?: boolean;
  freshOnLoad?: boolean;
  syncOnFirstLoad?: boolean;
  backgroundRefreshOnFirstLoad?: boolean;
  reloadOnMount?: boolean;
  freshOnManualReload?: boolean;
  freshOnBackgroundRefresh?: boolean;
  persistLocalCache?: boolean;
  localCacheScope?: string;
  preserveVisibleDataOnEmptyComplete?: boolean;
  keepVisibleOnSameSnapshotVersion?: boolean;
  treatUserVisibleCompleteAsSettled?: boolean;
}): ManagedEntitiesSyncResult {
  const queryClient = useQueryClient();
  const [ephemeralCacheScope] = useState(() => `s:${Math.random().toString(36).slice(2, 10)}`);
  const localCacheUserScope = readManagedEntitiesLocalCacheUserScope();
  const effectiveLocalCacheScope =
    localCacheUserScope !== null ? `${localCacheScope}:${localCacheUserScope}` : null;
  const effectiveStateCacheScope =
    effectiveLocalCacheScope ?? `${localCacheScope}:${ephemeralCacheScope}`;
  const cacheKey = useMemo(
    () => ['me-sync', entityType, effectiveStateCacheScope] as const,
    [effectiveStateCacheScope, entityType],
  );
  const cachedState = queryClient.getQueryData<ManagedEntitiesSyncState>(cacheKey) ?? null;
  const normalizedCachedState =
    cachedState === null
      ? null
      : {
          ...cachedState,
          hasLoadedFromServer: cachedState.hasLoadedFromServer === true,
          snapshot: sanitizeManagedEntitiesSnapshot(cachedState.snapshot),
        };
  const persistedCache = useMemo(
    () =>
      persistLocalCache && effectiveLocalCacheScope !== null
        ? readManagedEntitiesLocalCache(entityType, effectiveLocalCacheScope)
        : null,
    [effectiveLocalCacheScope, entityType, persistLocalCache],
  );
  const initialCachedData = sanitizeManagedEntitiesOrNull(
    cachedState?.data ?? persistedCache?.items ?? null,
  );
  const initialSnapshot = sanitizeManagedEntitiesSnapshot(
    normalizedCachedState?.snapshot ?? persistedCache?.snapshot ?? null,
  );
  const initialState: ManagedEntitiesSyncState = freshOnLoad
    ? {
        ...EMPTY_SYNC_STATE,
      }
    : (normalizedCachedState ??
      (initialCachedData !== null
        ? {
            data: initialCachedData,
            error: null,
            refreshState: MANAGED_ENTITIES_LOCAL_COMPLETE_STATE,
            snapshot: initialSnapshot,
            phase: 'complete',
            hasLoadedFromServer: false,
          }
        : {
            ...EMPTY_SYNC_STATE,
          }));
  const [state, setState] = useState<ManagedEntitiesSyncState>(() => initialState);
  const [visibilityResumeNonce, setVisibilityResumeNonce] = useState(0);
  const latestDataRef = useRef<ChatSummary[] | null>(initialState.data);
  const latestSnapshotRef = useRef<ManagedEntitiesResponseSnapshot | null>(initialState.snapshot);
  const hasLoadedFromServerRef = useRef(initialState.hasLoadedFromServer);
  const skippedInitialSyncRef = useRef(false);
  const handledReloadNonceRef = useRef(reloadNonce);
  const backoffResumeAtRef = useRef<number | null>(null);
  const cacheScopeRef = useRef(effectiveStateCacheScope);

  useEffect(() => {
    if (cacheScopeRef.current === effectiveStateCacheScope) {
      return;
    }

    cacheScopeRef.current = effectiveStateCacheScope;
    skippedInitialSyncRef.current = false;
    backoffResumeAtRef.current = null;
    setState((current) => {
      const nextState = resolveManagedEntitiesScopeTransitionState({
        currentState: current,
        nextInitialState: initialState,
      });
      latestDataRef.current = nextState.data;
      latestSnapshotRef.current = nextState.snapshot;
      hasLoadedFromServerRef.current = nextState.hasLoadedFromServer;
      return nextState;
    });
  }, [effectiveStateCacheScope, initialState]);

  useEffect(() => {
    hasLoadedFromServerRef.current = state.hasLoadedFromServer;
  }, [state.hasLoadedFromServer]);

  useEffect(() => {
    latestSnapshotRef.current = state.snapshot;
  }, [state.snapshot]);

  useEffect(() => {
    queryClient.setQueryData(cacheKey, state);
  }, [cacheKey, queryClient, state]);

  useEffect(() => {
    const dataToPersist = state.data;
    const shouldPersistServerState =
      state.error === null &&
      dataToPersist !== null &&
      state.hasLoadedFromServer &&
      (state.refreshState === null ||
        state.refreshState.complete === true ||
        (treatUserVisibleCompleteAsSettled &&
          isManagedEntitiesUserVisibleComplete(state.refreshState)));
    if (!persistLocalCache || effectiveLocalCacheScope === null || !shouldPersistServerState) {
      return;
    }

    saveManagedEntitiesLocalCache(
      entityType,
      effectiveLocalCacheScope,
      dataToPersist,
      state.snapshot,
    );
  }, [
    effectiveLocalCacheScope,
    entityType,
    persistLocalCache,
    state.data,
    state.error,
    state.hasLoadedFromServer,
    state.refreshState,
    state.snapshot,
    treatUserVisibleCompleteAsSettled,
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
      if (
        state.refreshState?.complete ||
        (treatUserVisibleCompleteAsSettled &&
          isManagedEntitiesUserVisibleComplete(state.refreshState))
      ) {
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
    state.refreshState?.userVisibleComplete,
    state.refreshState?.nextPollAfterMs,
    treatUserVisibleCompleteAsSettled,
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
        phase: resolveManagedEntitiesSettledPhase(current.refreshState, {
          treatUserVisibleCompleteAsSettled,
        }),
      }));
      return;
    }

    skippedInitialSyncRef.current = true;

    let cancelled = false;
    const forceRefreshSession = reloadNonce !== handledReloadNonceRef.current;
    handledReloadNonceRef.current = reloadNonce;
    const hasCachedData = latestDataRef.current !== null;
    const refreshRequestOptions = resolveManagedEntitiesRefreshRequestOptions({
      forceRefreshSession,
      reloadBehavior,
      backgroundRefreshOnFirstLoad,
      hasLoadedFromServer: hasLoadedFromServerRef.current,
      hasVisibleData: hasCachedData,
    });
    const forceRefreshUsesBypassRemoteCache = refreshRequestOptions.bypassRemoteCache;
    const shouldStartWithBackgroundRefresh = refreshRequestOptions.startWithBackgroundRefresh;
    const shouldContinueWithBackgroundRefreshAfterLoad =
      refreshRequestOptions.continueWithBackgroundRefreshAfterLoad;
    const freshReloadUsesFreshEndpoint = shouldUseFreshManagedEntitiesReload({
      forceRefreshSession,
      freshOnManualReload,
      requestedBackgroundRefresh:
        shouldStartWithBackgroundRefresh || shouldContinueWithBackgroundRefreshAfterLoad,
      freshOnBackgroundRefresh,
    });
    setState((current) => ({
      ...current,
      error: hasCachedData ? null : current.error,
      phase: hasCachedData ? 'syncing' : 'loading',
    }));

    const syncEntities = async () => {
      try {
        let forceRefreshPending = forceRefreshSession;
        let emptyFreshRecoveryPending = false;
        const documentVisible =
          typeof document === 'undefined' || document.visibilityState === 'visible';

        if (!shouldStartWithBackgroundRefresh || freshReloadUsesFreshEndpoint) {
          const initial = await loadManagedEntities(api, entityType, {
            fresh: freshOnLoad || freshReloadUsesFreshEndpoint,
          });
          if (cancelled) {
            return;
          }

          const initialData = sanitizeManagedEntities(
            mergeManagedEntitiesInitialItems({
              previous: latestDataRef.current,
              next: initial,
              preservePreviousOnEmpty: freshReloadUsesFreshEndpoint,
            }),
          );
          latestDataRef.current = initialData;

          if (
            (!hasCachedData || freshOnLoad || reloadOnMount) &&
            !forceRefreshPending &&
            !syncOnFirstLoad &&
            !shouldContinueWithBackgroundRefreshAfterLoad
          ) {
            latestSnapshotRef.current = null;
            setState({
              data: initialData,
              error: null,
              refreshState: MANAGED_ENTITIES_LOCAL_COMPLETE_STATE,
              snapshot: null,
              phase: documentVisible ? 'complete' : 'idle',
              hasLoadedFromServer: true,
            });
            return;
          }

          if (
            shouldSettleManagedEntitiesFreshReload({
              freshReloadUsesFreshEndpoint,
              startWithBackgroundRefresh: shouldStartWithBackgroundRefresh,
              continueWithBackgroundRefreshAfterLoad: shouldContinueWithBackgroundRefreshAfterLoad,
              forceRefreshSession,
            })
          ) {
            latestSnapshotRef.current = null;
            setState({
              data: initialData,
              error: null,
              refreshState: MANAGED_ENTITIES_LOCAL_COMPLETE_STATE,
              snapshot: null,
              phase: documentVisible ? 'complete' : 'idle',
              hasLoadedFromServer: true,
            });
            return;
          }

          emptyFreshRecoveryPending = freshReloadUsesFreshEndpoint;

          setState({
            data: initialData,
            error: null,
            refreshState: null,
            snapshot: latestSnapshotRef.current,
            phase: documentVisible ? 'syncing' : 'idle',
            hasLoadedFromServer: true,
          });

          if (!documentVisible) {
            return;
          }
        }

        let resetRefreshCursor = refreshRequestOptions.resetRefreshCursor;

        while (!cancelled) {
          if (
            typeof document !== 'undefined' &&
            document.visibilityState !== 'visible' &&
            latestDataRef.current !== null
          ) {
            setState((current) => ({
              ...current,
              phase: resolveManagedEntitiesSettledPhase(current.refreshState, {
                treatUserVisibleCompleteAsSettled,
              }),
            }));
            return;
          }

          let next = await refreshManagedEntities(api, entityType, {
            bypassRemoteCache:
              (forceRefreshPending && forceRefreshUsesBypassRemoteCache) ||
              emptyFreshRecoveryPending,
            resetRefreshCursor: resetRefreshCursor || emptyFreshRecoveryPending,
            sinceVersion:
              latestDataRef.current !== null ? (latestSnapshotRef.current?.version ?? null) : null,
          });
          forceRefreshPending = false;
          resetRefreshCursor = false;
          emptyFreshRecoveryPending = false;
          if (cancelled) {
            return;
          }
          let diffItems = applyManagedEntitiesResponseDiff({
            previous: latestDataRef.current,
            diff: next.diff,
            previousSnapshotVersion: latestSnapshotRef.current?.version ?? null,
          });
          if (next.diff && diffItems === null) {
            next = await refreshManagedEntities(api, entityType, {
              bypassRemoteCache: false,
              resetRefreshCursor: false,
            });
            if (cancelled) {
              return;
            }
            diffItems = null;
          }

          const resolvedSnapshot = sanitizeManagedEntitiesSnapshot(next.snapshot);
          const nextData = sanitizeManagedEntities(
            diffItems ??
              mergeManagedEntitiesRefreshItems({
                previous: latestDataRef.current,
                next: next.items,
                refreshState: next.refresh,
                preservePreviousOnEmptyComplete:
                  keepVisibleOnSameSnapshotVersion && resolvedSnapshot?.version
                    ? false
                    : preserveVisibleDataOnEmptyComplete,
                keepVisibleOnSameSnapshotVersion,
                previousSnapshotVersion: latestSnapshotRef.current?.version ?? null,
                nextSnapshotVersion: resolvedSnapshot?.version ?? null,
              }),
          );
          latestDataRef.current = nextData;
          latestSnapshotRef.current = resolvedSnapshot;
          const userVisibleSettled =
            treatUserVisibleCompleteAsSettled && isManagedEntitiesUserVisibleComplete(next.refresh);
          const phase =
            next.refresh.complete || userVisibleSettled
              ? 'complete'
              : next.refresh.backoffActive
                ? 'backoff'
                : 'syncing';
          setState({
            data: nextData,
            error: null,
            refreshState: next.refresh,
            snapshot: resolvedSnapshot,
            phase,
            hasLoadedFromServer: true,
          });

          if (
            !shouldContinueManagedEntitiesRefreshPolling(next.refresh, {
              treatUserVisibleCompleteAsSettled,
            })
          ) {
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
            ? resolveManagedEntitiesSettledPhase(current.refreshState, {
                treatUserVisibleCompleteAsSettled,
              })
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
    freshOnBackgroundRefresh,
    freshOnLoad,
    freshOnManualReload,
    reloadNonce,
    reloadBehavior,
    reloadOnMount,
    skipInitialSyncIfCached,
    syncOnFirstLoad,
    keepVisibleOnSameSnapshotVersion,
    treatUserVisibleCompleteAsSettled,
    visibilityResumeNonce,
    effectiveStateCacheScope,
  ]);

  return {
    ...state,
    isLoading: state.phase === 'loading' && state.data === null,
    isRefreshing: state.phase === 'syncing',
    isSyncComplete: state.refreshState?.complete === true,
    isUserVisibleComplete: isManagedEntitiesUserVisibleComplete(state.refreshState),
    isBackoffActive: state.refreshState?.backoffActive === true,
    hasLoadedFromServer: state.hasLoadedFromServer,
  };
}
