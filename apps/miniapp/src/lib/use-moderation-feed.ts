import type {
  LogsDashboardRange,
  ModerationFeedFilter,
  ModerationFeedPage,
} from '@maxim/contracts';
import { useEffect, useEffectEvent, useRef, useState } from 'react';

type LoadModerationFeedPage = (
  query: {
    range: LogsDashboardRange;
    filter: ModerationFeedFilter;
    limit: number;
    cursor?: string;
  },
  request?: Pick<RequestInit, 'signal'>,
) => Promise<ModerationFeedPage>;

type UseModerationFeedOptions = {
  enabled?: boolean;
  range: LogsDashboardRange;
  filter: ModerationFeedFilter;
  loadPage: LoadModerationFeedPage;
  initialPage?: ModerationFeedPage | null;
  limit?: number;
};

type FeedState = {
  items: ModerationFeedPage['items'];
  hasMore: boolean;
  nextCursor: string | null;
};

const EMPTY_FEED: FeedState = {
  items: [],
  hasMore: false,
  nextCursor: null,
};

function toFeedState(page: ModerationFeedPage): FeedState {
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

export function useModerationFeed({
  enabled = true,
  range,
  filter,
  loadPage,
  initialPage = null,
  limit = 50,
}: UseModerationFeedOptions) {
  const [feed, setFeed] = useState<FeedState>(EMPTY_FEED);
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

    const scopeKey = `${range}\u0000${filter}\u0000${limit}`;
    const scopeChanged = scopeKeyRef.current !== scopeKey;
    scopeKeyRef.current = scopeKey;

    if (filter === 'ALL' && initialPage) {
      setFeed(toFeedState(initialPage));
      setError(null);
      setStatus('idle');
      return;
    }

    const requestId = requestIdRef.current;
    const controller = new AbortController();
    activeControllerRef.current = controller;
    setStatus('reloading');
    setError(null);
    if (scopeChanged || feedRef.current.items.length === 0) {
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

        setError(cause instanceof Error ? cause.message : 'Не удалось загрузить события.');
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
  }, [enabled, filter, initialPage, limit, range]);

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

      setError(cause instanceof Error ? cause.message : 'Не удалось догрузить события.');
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

    if (filter === 'ALL' && initialPage) {
      setFeed(toFeedState(initialPage));
      setError(null);
      setStatus('idle');
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

      setError(cause instanceof Error ? cause.message : 'Не удалось загрузить события.');
      setStatus('idle');
      if (activeControllerRef.current === controller) {
        activeControllerRef.current = null;
      }
    }
  }

  return {
    items: feed.items,
    hasMore: feed.hasMore,
    error,
    isReloading: status === 'reloading',
    isLoadingMore: status === 'loadingMore',
    loadMore,
    retry,
  };
}
