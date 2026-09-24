import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { isTerminalApiClientError } from './api-retry';

type EventPage<Item> = { items: Item[]; hasMore: boolean; nextCursor: string | null };
type RequestMode = 'reload' | 'more' | 'refresh';
type FeedState<Item> = {
  key: string;
  page: EventPage<Item>;
  firstPage: EventPage<Item> | null;
  status: 'idle' | RequestMode;
  error: string | null;
  errorKind: RequestMode | null;
  updatedAt: number | null;
  failures: number;
  terminalError: boolean;
  paginated: boolean;
};

export function mergeEventItems<Item extends { id: string }>(
  current: Item[],
  next: Item[],
): Item[] {
  const items = new Map(current.map((item) => [item.id, item]));
  for (const item of next) items.set(item.id, item);
  return [...items.values()];
}

function createFeed<Item>(key: string, seed: EventPage<Item> | null): FeedState<Item> {
  return {
    key,
    page: seed ?? { items: [], hasMore: false, nextCursor: null },
    firstPage: null,
    status: 'idle',
    error: null,
    errorKind: null,
    updatedAt: null,
    failures: 0,
    terminalError: false,
    paginated: false,
  };
}

export function useEventFeed<Item extends { id: string }, Query extends { cursor?: string }>({
  scopeKey,
  enabled,
  query,
  initialPage = null,
  loadPage,
}: {
  scopeKey: string;
  enabled: boolean;
  query: Query;
  initialPage?: EventPage<Item> | null;
  loadPage: (query: Query, request: Pick<RequestInit, 'signal'>) => Promise<EventPage<Item>>;
}) {
  const [state, setState] = useState(() => createFeed(scopeKey, initialPage));
  const controllerRef = useRef<AbortController | null>(null);
  const visitedCursorsRef = useRef(new Set<string>());
  // FLAG: Scope changes must hide old rows before effects, including actionable user identities.
  const current = state.key === scopeKey ? state : createFeed(scopeKey, initialPage);

  async function requestPage(mode: RequestMode) {
    if (!enabled) return;
    if (mode !== 'reload' && controllerRef.current) return;
    if (mode === 'more' && (!current.page.hasMore || !current.page.nextCursor)) return;
    // Preserve the history and its cursor while the reader is paging through older events.
    if (mode === 'refresh' && current.paginated) return;

    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const cursor = mode === 'more' ? current.page.nextCursor : null;
    const visited = mode === 'more' ? new Set(visitedCursorsRef.current) : new Set<string>();
    if (cursor) visited.add(cursor);
    setState({ ...current, status: mode, error: null, errorKind: null });

    try {
      const page = await loadPage(
        { ...query, cursor: cursor ?? undefined },
        { signal: controller.signal },
      );
      if (controller.signal.aborted || controllerRef.current !== controller) return;
      if (page.hasMore && (!page.nextCursor || visited.has(page.nextCursor))) {
        throw new Error('Не удалось продолжить список. Обновите события.');
      }
      visitedCursorsRef.current = visited;
      setState((previous) => ({
        key: scopeKey,
        firstPage: mode === 'more' ? previous.firstPage : page,
        page: {
          ...page,
          items: mergeEventItems(mode === 'more' ? previous.page.items : [], page.items),
        },
        status: 'idle',
        error: null,
        errorKind: null,
        updatedAt: Date.now(),
        failures: 0,
        terminalError: false,
        paginated: mode === 'more',
      }));
    } catch (cause: unknown) {
      if (controller.signal.aborted || controllerRef.current !== controller) return;
      setState((previous) => ({
        ...previous,
        status: 'idle',
        error: cause instanceof Error ? cause.message : 'Не удалось загрузить события.',
        errorKind: mode,
        failures: previous.failures + 1,
        terminalError: isTerminalApiClientError(cause),
      }));
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }

  const loadInitialPage = useEffectEvent(() => void requestPage('reload'));
  useEffect(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    visitedCursorsRef.current = new Set();
    if (enabled) loadInitialPage();
    return () => {
      controllerRef.current?.abort();
      controllerRef.current = null;
    };
    // A dashboard snapshot is a seed, never authority over a completed or in-flight feed request.
  }, [enabled, scopeKey]);

  return {
    ...current.page,
    firstPage: current.firstPage,
    error: current.error,
    updatedAt: current.updatedAt,
    isReloading: enabled && (state.key !== scopeKey || current.status === 'reload'),
    isRefreshing: enabled && current.status === 'refresh',
    isLoadingMore: enabled && current.status === 'more',
    canAutoRefresh:
      enabled &&
      !current.paginated &&
      !current.terminalError &&
      current.errorKind !== 'more' &&
      current.status === 'idle',
    refreshFailures: current.failures,
    refresh: () => requestPage('refresh'),
    loadMore: () => requestPage('more'),
    retry: () => requestPage('reload'),
    retryFailed: () => requestPage(current.errorKind === 'more' ? 'more' : 'reload'),
  };
}
