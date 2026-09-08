import type { ChatParticipantsPage, ChatParticipantsQuery } from '@maxim/contracts';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import {
  buildParticipantsFeedKey,
  mergeParticipants,
  normalizeParticipantsSearch,
  validateParticipantsCursor,
} from './chat-participants-feed';

type UseChatParticipantsFeedOptions = {
  chatId: string;
  enabled?: boolean;
  initialPage?: ChatParticipantsPage | null;
  refetchInitialPage?: boolean;
  loadPage: (
    query: ChatParticipantsQuery,
    request?: Pick<RequestInit, 'signal'>,
  ) => Promise<ChatParticipantsPage>;
  range?: ChatParticipantsQuery['range'];
  roleFilter?: ChatParticipantsQuery['roleFilter'];
  limit?: number;
  search?: string;
};

type FeedState = {
  key: string;
  page: ChatParticipantsPage;
  firstPage: ChatParticipantsPage | null;
  status: 'idle' | 'reloading' | 'loadingMore';
  error: string | null;
  errorKind: 'reload' | 'more' | null;
  updatedAt: number | null;
};

const EMPTY_PAGE: ChatParticipantsPage = {
  items: [],
  totalCount: null,
  hasMore: false,
  nextCursor: null,
};

function createFeed(key: string, page: ChatParticipantsPage | null): FeedState {
  return {
    key,
    page: page ?? EMPTY_PAGE,
    firstPage: null,
    status: 'idle',
    error: null,
    errorKind: null,
    updatedAt: null,
  };
}

export function useChatParticipantsFeed({
  chatId,
  enabled = true,
  initialPage = null,
  refetchInitialPage = false,
  loadPage,
  range = '7d',
  roleFilter = 'all',
  limit = 100,
  search = '',
}: UseChatParticipantsFeedOptions) {
  const normalizedSearch = normalizeParticipantsSearch(search);
  const requestLimit = normalizedSearch ? Math.min(limit, 24) : limit;
  const query: ChatParticipantsQuery = {
    range,
    roleFilter,
    limit: requestLimit,
    search: normalizedSearch || undefined,
  };
  const key = buildParticipantsFeedKey(chatId, query);
  const seed = !normalizedSearch ? initialPage : null;
  const [state, setState] = useState(() => createFeed(key, seed));
  const activeControllerRef = useRef<AbortController | null>(null);
  const visitedCursorsRef = useRef(new Set<string>());
  // FLAG: Never expose another chat/filter's rows, counts, actions, or snapshot before effects run.
  const current = state.key === key ? state : createFeed(key, seed);

  async function requestPage(mode: 'reload' | 'more') {
    if (!enabled || !chatId) return;
    if (
      mode === 'more' &&
      (activeControllerRef.current ||
        state.key !== key ||
        !current.page.hasMore ||
        !current.page.nextCursor)
    )
      return;

    activeControllerRef.current?.abort();
    const controller = new AbortController();
    activeControllerRef.current = controller;
    const cursor = mode === 'more' ? current.page.nextCursor : null;
    const visited = mode === 'more' ? new Set(visitedCursorsRef.current) : new Set<string>();
    if (cursor) visited.add(cursor);
    setState({
      ...current,
      status: mode === 'more' ? 'loadingMore' : 'reloading',
      error: null,
      errorKind: null,
    });

    try {
      const page = await loadPage(
        { ...query, ...(cursor ? { cursor } : {}) },
        { signal: controller.signal },
      );
      if (controller.signal.aborted || activeControllerRef.current !== controller) return;
      validateParticipantsCursor(page, visited);
      const normalizedPage = { ...page, items: mergeParticipants([], page.items) };
      visitedCursorsRef.current = visited;
      setState((previous) => ({
        key,
        page:
          mode === 'more'
            ? {
                ...normalizedPage,
                items: mergeParticipants(previous.page.items, normalizedPage.items),
                totalCount: page.totalCount ?? previous.page.totalCount,
              }
            : normalizedPage,
        // FLAG: Persist the actual first page with its own cursor, never a truncated merged list.
        firstPage: mode === 'more' ? previous.firstPage : normalizedPage,
        status: 'idle',
        error: null,
        errorKind: null,
        updatedAt: Date.now(),
      }));
    } catch (cause: unknown) {
      if (controller.signal.aborted || activeControllerRef.current !== controller) return;
      setState((previous) => ({
        ...previous,
        status: 'idle',
        errorKind: mode,
        error: cause instanceof Error ? cause.message : 'Не удалось загрузить участников.',
      }));
    } finally {
      if (activeControllerRef.current === controller) activeControllerRef.current = null;
    }
  }

  const startInitialRequest = useEffectEvent(() => {
    if (seed && !refetchInitialPage) {
      setState(createFeed(key, seed));
      return;
    }
    void requestPage('reload');
  });

  useEffect(() => {
    activeControllerRef.current?.abort();
    activeControllerRef.current = null;
    visitedCursorsRef.current = new Set();
    if (enabled && chatId) startInitialRequest();

    return () => {
      activeControllerRef.current?.abort();
      activeControllerRef.current = null;
    };
  }, [chatId, enabled, key, initialPage, refetchInitialPage]);

  return {
    ...current.page,
    firstPage: current.firstPage,
    error: current.error,
    errorKind: current.errorKind,
    updatedAt: current.updatedAt,
    isReloading:
      enabled &&
      (state.key !== key ||
        current.status === 'reloading' ||
        (!seed && current.updatedAt === null && current.error === null)),
    isLoadingMore: enabled && current.status === 'loadingMore',
    loadMore: () => requestPage('more'),
    retry: () => requestPage('reload'),
    retryFailed: () => requestPage(current.errorKind === 'more' ? 'more' : 'reload'),
  };
}
