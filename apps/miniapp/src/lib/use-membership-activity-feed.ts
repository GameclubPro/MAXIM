import type {
  MembershipActivityFilter,
  MembershipActivityPage,
  MembershipActivityRange,
} from '@maxim/contracts';
import { useEffect, useEffectEvent, useRef, useState } from 'react';

type LoadMembershipActivityPage = (
  query: {
    range: MembershipActivityRange;
    filter: MembershipActivityFilter;
    limit: number;
    cursor?: string;
  },
  request?: Pick<RequestInit, 'signal'>,
) => Promise<MembershipActivityPage>;

type UseMembershipActivityFeedOptions = {
  enabled?: boolean;
  range: MembershipActivityRange;
  initialPage?: MembershipActivityPage | null;
  refetchInitialPage?: boolean;
  loadPage: LoadMembershipActivityPage;
  limit?: number;
};

type FeedState = {
  items: MembershipActivityPage['items'];
  hasMore: boolean;
  nextCursor: string | null;
};

const EMPTY_FEED: FeedState = {
  items: [],
  hasMore: false,
  nextCursor: null,
};

function toFeedState(page: MembershipActivityPage): FeedState {
  return {
    items: page.items,
    hasMore: page.hasMore,
    nextCursor: page.nextCursor,
  };
}

function isAbortError(cause: unknown): boolean {
  return (
    (cause instanceof DOMException && cause.name === 'AbortError') ||
    (cause instanceof Error &&
      (cause.name === 'AbortError' || cause.message.toLowerCase().includes('abort')))
  );
}

export function shouldClearMembershipActivityFeed({
  scopeChanged,
  filter,
  hasInitialPage,
  itemCount,
}: {
  scopeChanged: boolean;
  filter: MembershipActivityFilter;
  hasInitialPage: boolean;
  itemCount: number;
}): boolean {
  return (scopeChanged && (filter !== 'all' || !hasInitialPage)) || itemCount === 0;
}

export function useMembershipActivityFeed({
  enabled = true,
  range,
  initialPage = null,
  refetchInitialPage = false,
  loadPage,
  limit = 50,
}: UseMembershipActivityFeedOptions) {
  const [filter, setFilter] = useState<MembershipActivityFilter>('all');
  const [feed, setFeed] = useState<FeedState>(() =>
    initialPage ? toFeedState(initialPage) : EMPTY_FEED,
  );
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'reloading' | 'loadingMore'>('idle');
  const requestIdRef = useRef(0);
  const activeControllerRef = useRef<AbortController | null>(null);
  const feedRef = useRef(feed);
  const scopeKeyRef = useRef(`${range}\u0000${filter}\u0000${limit}`);
  const runLoadPage = useEffectEvent(loadPage);

  useEffect(() => {
    feedRef.current = feed;
  }, [feed]);

  useEffect(() => {
    requestIdRef.current += 1;
    activeControllerRef.current?.abort();
    activeControllerRef.current = null;

    if (!enabled) {
      setError(null);
      setStatus('idle');
      return;
    }

    if (filter === 'all' && initialPage) {
      setFeed(toFeedState(initialPage));
      setError(null);
      setStatus('idle');
    }
  }, [enabled, filter, initialPage, range]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const scopeKey = `${range}\u0000${filter}\u0000${limit}`;
    const scopeChanged = scopeKeyRef.current !== scopeKey;
    scopeKeyRef.current = scopeKey;

    if (filter === 'all') {
      if (initialPage && !refetchInitialPage) {
        return;
      }
    }

    const requestId = requestIdRef.current + 1;
    activeControllerRef.current?.abort();
    const controller = new AbortController();
    activeControllerRef.current = controller;
    requestIdRef.current = requestId;
    setStatus('reloading');
    setError(null);
    if (
      shouldClearMembershipActivityFeed({
        scopeChanged,
        filter,
        hasInitialPage: Boolean(initialPage),
        itemCount: feedRef.current.items.length,
      })
    ) {
      setFeed(EMPTY_FEED);
    }

    void runLoadPage({ range, filter, limit }, { signal: controller.signal })
      .then((page) => {
        if (requestId !== requestIdRef.current || controller.signal.aborted) {
          return;
        }

        setFeed(toFeedState(page));
        setStatus('idle');
        if (activeControllerRef.current === controller) {
          activeControllerRef.current = null;
        }
      })
      .catch((cause: unknown) => {
        if (
          requestId !== requestIdRef.current ||
          controller.signal.aborted ||
          isAbortError(cause)
        ) {
          return;
        }

        setError(cause instanceof Error ? cause.message : 'Не удалось загрузить активность.');
        setStatus('idle');
        if (activeControllerRef.current === controller) {
          activeControllerRef.current = null;
        }
      });

    return () => {
      controller.abort();
      if (activeControllerRef.current === controller) {
        activeControllerRef.current = null;
      }
    };
  }, [enabled, filter, initialPage, limit, range, refetchInitialPage]);

  async function loadMore() {
    if (!enabled || status !== 'idle' || !feed.hasMore || !feed.nextCursor) {
      return;
    }

    const requestId = requestIdRef.current + 1;
    activeControllerRef.current?.abort();
    const controller = new AbortController();
    activeControllerRef.current = controller;
    requestIdRef.current = requestId;
    setStatus('loadingMore');
    setError(null);

    try {
      const nextPage = await runLoadPage(
        {
          range,
          filter,
          limit,
          cursor: feed.nextCursor,
        },
        { signal: controller.signal },
      );
      if (requestId !== requestIdRef.current || controller.signal.aborted) {
        return;
      }

      setFeed((current) => ({
        items: [...current.items, ...nextPage.items],
        hasMore: nextPage.hasMore,
        nextCursor: nextPage.nextCursor,
      }));
      setStatus('idle');
      if (activeControllerRef.current === controller) {
        activeControllerRef.current = null;
      }
    } catch (cause: unknown) {
      if (requestId !== requestIdRef.current || controller.signal.aborted || isAbortError(cause)) {
        return;
      }

      setError(cause instanceof Error ? cause.message : 'Не удалось догрузить активность.');
      setStatus('idle');
      if (activeControllerRef.current === controller) {
        activeControllerRef.current = null;
      }
    }
  }

  async function retry() {
    if (!enabled) {
      setError(null);
      setStatus('idle');
      return;
    }

    if (filter === 'all' && initialPage && !refetchInitialPage) {
      setFeed(toFeedState(initialPage));
      setError(null);
      return;
    }

    const requestId = requestIdRef.current + 1;
    activeControllerRef.current?.abort();
    const controller = new AbortController();
    activeControllerRef.current = controller;
    requestIdRef.current = requestId;
    setStatus('reloading');
    setError(null);
    if (feedRef.current.items.length === 0) {
      setFeed(EMPTY_FEED);
    }

    try {
      const page = await runLoadPage({ range, filter, limit }, { signal: controller.signal });
      if (requestId !== requestIdRef.current || controller.signal.aborted) {
        return;
      }

      setFeed(toFeedState(page));
      setStatus('idle');
      if (activeControllerRef.current === controller) {
        activeControllerRef.current = null;
      }
    } catch (cause: unknown) {
      if (requestId !== requestIdRef.current || controller.signal.aborted || isAbortError(cause)) {
        return;
      }

      setError(cause instanceof Error ? cause.message : 'Не удалось загрузить активность.');
      setStatus('idle');
      if (activeControllerRef.current === controller) {
        activeControllerRef.current = null;
      }
    }
  }

  return {
    filter,
    setFilter,
    items: feed.items,
    hasMore: feed.hasMore,
    nextCursor: feed.nextCursor,
    error,
    isReloading: status === 'reloading',
    isLoadingMore: status === 'loadingMore',
    loadMore,
    retry,
  };
}
