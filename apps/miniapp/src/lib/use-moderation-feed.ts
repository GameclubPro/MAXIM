import type {
  LogsDashboardRange,
  ModerationFeedFilter,
  ModerationFeedPage,
} from '@maxim/contracts';
import { useEffect, useEffectEvent, useRef, useState } from 'react';

type LoadModerationFeedPage = (query: {
  range: LogsDashboardRange;
  filter: ModerationFeedFilter;
  limit: number;
  cursor?: string;
}) => Promise<ModerationFeedPage>;

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
  const runLoadPage = useEffectEvent(loadPage);

  useEffect(() => {
    requestIdRef.current += 1;

    if (!enabled) {
      setFeed(EMPTY_FEED);
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

    const requestId = requestIdRef.current;
    setStatus('reloading');
    setError(null);
    setFeed(EMPTY_FEED);

    void runLoadPage({ range, filter, limit })
      .then((page) => {
        if (requestId !== requestIdRef.current) {
          return;
        }

        setFeed(toFeedState(page));
        setStatus('idle');
      })
      .catch((cause: unknown) => {
        if (requestId !== requestIdRef.current) {
          return;
        }

        setError(cause instanceof Error ? cause.message : 'Не удалось загрузить события.');
        setStatus('idle');
      });
  }, [enabled, filter, initialPage, limit, range]);

  async function loadMore() {
    if (!enabled || status !== 'idle' || !feed.hasMore || !feed.nextCursor) {
      return;
    }

    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setStatus('loadingMore');
    setError(null);

    try {
      const nextPage = await runLoadPage({
        range,
        filter,
        limit,
        cursor: feed.nextCursor,
      });
      if (requestId !== requestIdRef.current) {
        return;
      }

      setFeed((current) => ({
        items: [...current.items, ...nextPage.items],
        hasMore: nextPage.hasMore,
        nextCursor: nextPage.nextCursor,
      }));
      setStatus('idle');
    } catch (cause: unknown) {
      if (requestId !== requestIdRef.current) {
        return;
      }

      setError(cause instanceof Error ? cause.message : 'Не удалось догрузить события.');
      setStatus('idle');
    }
  }

  async function retry() {
    if (!enabled) {
      setFeed(EMPTY_FEED);
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
    requestIdRef.current = requestId;
    setStatus('reloading');
    setError(null);

    try {
      const page = await runLoadPage({ range, filter, limit });
      if (requestId !== requestIdRef.current) {
        return;
      }

      setFeed(toFeedState(page));
      setStatus('idle');
    } catch (cause: unknown) {
      if (requestId !== requestIdRef.current) {
        return;
      }

      setError(cause instanceof Error ? cause.message : 'Не удалось загрузить события.');
      setStatus('idle');
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
