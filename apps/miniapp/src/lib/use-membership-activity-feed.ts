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
}) => Promise<MembershipActivityPage>;

type UseMembershipActivityFeedOptions = {
  range: MembershipActivityRange;
  initialPage: MembershipActivityPage;
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

export function useMembershipActivityFeed({
  range,
  initialPage,
  loadPage,
  limit = 50,
}: UseMembershipActivityFeedOptions) {
  const [filter, setFilter] = useState<MembershipActivityFilter>('all');
  const [feed, setFeed] = useState<FeedState>(() => toFeedState(initialPage));
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'reloading' | 'loadingMore'>('idle');
  const requestIdRef = useRef(0);
  const runLoadPage = useEffectEvent(loadPage);

  useEffect(() => {
    requestIdRef.current += 1;

    if (filter === 'all') {
      setFeed(toFeedState(initialPage));
      setError(null);
      setStatus('idle');
    }
  }, [filter, initialPage, range]);

  useEffect(() => {
    if (filter === 'all') {
      return;
    }

    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setStatus('reloading');
    setError(null);
    setFeed({
      items: [],
      hasMore: false,
      nextCursor: null,
    });

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

        setError(cause instanceof Error ? cause.message : 'Не удалось загрузить активность.');
        setStatus('idle');
      });
  }, [filter, limit, range]);

  async function loadMore() {
    if (status !== 'idle' || !feed.hasMore || !feed.nextCursor) {
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

      setError(cause instanceof Error ? cause.message : 'Не удалось догрузить активность.');
      setStatus('idle');
    }
  }

  async function retry() {
    if (filter === 'all') {
      setFeed(toFeedState(initialPage));
      setError(null);
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

      setError(cause instanceof Error ? cause.message : 'Не удалось загрузить активность.');
      setStatus('idle');
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
