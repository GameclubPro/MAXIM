import type {
  MembershipActivityFilter,
  MembershipActivityPage,
  MembershipActivityRange,
} from '@maxim/contracts';
import { useEffect, useEffectEvent, useRef, useState } from 'react';

type LoadMembershipActivityPage = (query: {
  range: MembershipActivityRange;
  filter: MembershipActivityFilter;
  limit: number;
  cursor?: string;
}, request?: Pick<RequestInit, 'signal'>) => Promise<MembershipActivityPage>;

type UseMembershipActivityFeedOptions = {
  enabled?: boolean;
  range: MembershipActivityRange;
  initialPage?: MembershipActivityPage | null;
  loadPage: LoadMembershipActivityPage;
  limit?: number;
};

type FeedState = {
  items: MembershipActivityPage['items'];
  hasMore: boolean;
  nextCursor: string | null;
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

export function useMembershipActivityFeed({
  enabled = true,
  range,
  initialPage = null,
  loadPage,
  limit = 50,
}: UseMembershipActivityFeedOptions) {
  const [filter, setFilter] = useState<MembershipActivityFilter>('all');
  const [feed, setFeed] = useState<FeedState>(() => (initialPage ? toFeedState(initialPage) : {
    items: [],
    hasMore: false,
    nextCursor: null,
  }));
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'reloading' | 'loadingMore'>('idle');
  const requestIdRef = useRef(0);
  const activeControllerRef = useRef<AbortController | null>(null);
  const runLoadPage = useEffectEvent(loadPage);

  useEffect(() => {
    requestIdRef.current += 1;
    activeControllerRef.current?.abort();
    activeControllerRef.current = null;

    if (!enabled) {
      setFeed(
        initialPage
          ? toFeedState(initialPage)
          : {
              items: [],
              hasMore: false,
              nextCursor: null,
            },
      );
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

    if (filter === 'all') {
      if (initialPage) {
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
    setFeed({
      items: [],
      hasMore: false,
      nextCursor: null,
    });

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
        if (requestId !== requestIdRef.current || controller.signal.aborted || isAbortError(cause)) {
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
  }, [enabled, filter, limit, range]);

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
      const nextPage = await runLoadPage({
        range,
        filter,
        limit,
        cursor: feed.nextCursor,
      }, { signal: controller.signal });
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
      setFeed(
        initialPage
          ? toFeedState(initialPage)
          : {
              items: [],
              hasMore: false,
              nextCursor: null,
            },
      );
      setError(null);
      setStatus('idle');
      return;
    }

    if (filter === 'all' && initialPage) {
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
    error,
    isReloading: status === 'reloading',
    isLoadingMore: status === 'loadingMore',
    loadMore,
    retry,
  };
}
