import type { ChatParticipantsPage } from '@maxim/contracts';
import { useEffect, useEffectEvent, useRef, useState } from 'react';

type LoadChatParticipantsPage = (query: {
  limit: number;
  cursor?: string;
}, request?: Pick<RequestInit, 'signal'>) => Promise<ChatParticipantsPage>;

type UseChatParticipantsFeedOptions = {
  enabled?: boolean;
  initialPage?: ChatParticipantsPage | null;
  loadPage: LoadChatParticipantsPage;
  limit?: number;
};

type FeedState = {
  items: ChatParticipantsPage['items'];
  totalCount: number | null;
  hasMore: boolean;
  nextCursor: string | null;
};

const EMPTY_FEED: FeedState = {
  items: [],
  totalCount: null,
  hasMore: false,
  nextCursor: null,
};

function toFeedState(page: ChatParticipantsPage): FeedState {
  return {
    items: page.items,
    totalCount: page.totalCount,
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

function mergeParticipants(
  current: ChatParticipantsPage['items'],
  next: ChatParticipantsPage['items'],
): ChatParticipantsPage['items'] {
  const merged = [...current];
  const seen = new Set(current.map((item) => item.userId));

  for (const item of next) {
    if (seen.has(item.userId)) {
      continue;
    }

    seen.add(item.userId);
    merged.push(item);
  }

  return merged;
}

export function useChatParticipantsFeed({
  enabled = true,
  initialPage = null,
  loadPage,
  limit = 100,
}: UseChatParticipantsFeedOptions) {
  const [feed, setFeed] = useState<FeedState>(() =>
    initialPage ? toFeedState(initialPage) : EMPTY_FEED,
  );
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'reloading' | 'loadingMore'>('idle');
  const requestIdRef = useRef(0);
  const activeControllerRef = useRef<AbortController | null>(null);
  const feedRef = useRef(feed);
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

    if (initialPage) {
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
    if (feedRef.current.items.length === 0) {
      setFeed(EMPTY_FEED);
    }

    void runLoadPage({ limit }, { signal: controller.signal })
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

        setError(cause instanceof Error ? cause.message : 'Не удалось загрузить участников.');
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
  }, [enabled, initialPage, limit]);

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
          limit,
          cursor: feed.nextCursor,
        },
        { signal: controller.signal },
      );
      if (requestId !== requestIdRef.current || controller.signal.aborted) {
        return;
      }

      setFeed((current) => ({
        items: mergeParticipants(current.items, nextPage.items),
        totalCount: nextPage.totalCount ?? current.totalCount,
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

      setError(cause instanceof Error ? cause.message : 'Не удалось догрузить участников.');
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

    if (initialPage) {
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
      const page = await runLoadPage({ limit }, { signal: controller.signal });
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

      setError(cause instanceof Error ? cause.message : 'Не удалось загрузить участников.');
      setStatus('idle');
      if (activeControllerRef.current === controller) {
        activeControllerRef.current = null;
      }
    }
  }

  return {
    items: feed.items,
    totalCount: feed.totalCount,
    hasMore: feed.hasMore,
    nextCursor: feed.nextCursor,
    error,
    isReloading: status === 'reloading',
    isLoadingMore: status === 'loadingMore',
    loadMore,
    retry,
  };
}
