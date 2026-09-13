import { useLayoutEffect, useRef, useState, type UIEvent } from 'react';

const NEAR_BOTTOM_PX = 72;

function distanceToBottom(viewport: HTMLElement): number {
  return Math.max(0, viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight);
}

export function useCommentScroll(
  context: string,
  messages: readonly { id: string }[],
  enabled: boolean,
) {
  const viewportRef = useRef<HTMLElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const followLatestRef = useRef(true);
  const geometryRef = useRef({ height: 0, scrollHeight: 0 });
  const previousRef = useRef<{ context: string; ids: string[] }>({ context, ids: [] });
  const [isNearBottom, setIsNearBottom] = useState(true);
  const [firstUnreadMessageId, setFirstUnreadMessageId] = useState<string | null>(null);

  const scrollToLatest = (behavior: ScrollBehavior = 'auto') => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    followLatestRef.current = true;
    setIsNearBottom(true);
    setFirstUnreadMessageId(null);
    viewport.scrollTo({
      top: viewport.scrollHeight,
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : behavior,
    });
    geometryRef.current = { height: viewport.clientHeight, scrollHeight: viewport.scrollHeight };
  };

  const handleScroll = (event: UIEvent<HTMLElement>) => {
    const viewport = event.currentTarget;
    const previous = geometryRef.current;
    // FLAG: WebViews can emit the resize-induced scroll event before ResizeObserver runs.
    if (
      followLatestRef.current &&
      (previous.height !== viewport.clientHeight || previous.scrollHeight !== viewport.scrollHeight)
    ) {
      scrollToLatest();
      return;
    }
    geometryRef.current = { height: viewport.clientHeight, scrollHeight: viewport.scrollHeight };
    const nearBottom = distanceToBottom(viewport) < NEAR_BOTTOM_PX;
    followLatestRef.current = nearBottom;
    setIsNearBottom(nearBottom);
    if (nearBottom) setFirstUnreadMessageId(null);
  };

  useLayoutEffect(() => {
    if (!enabled) return;
    const previous = previousRef.current;
    if (previous.context !== context) {
      previous.ids = [];
      followLatestRef.current = true;
      setFirstUnreadMessageId(null);
    }
    if (previous.ids.length === 0) followLatestRef.current = true;

    // FLAG: Decide from the reader's position before the DOM grows, not the new bottom distance.
    if (followLatestRef.current) {
      scrollToLatest();
    } else if (previous.ids.length > 0) {
      const oldIds = new Set(previous.ids);
      const firstNew = messages.find((message) => !oldIds.has(message.id));
      if (firstNew) setFirstUnreadMessageId((current) => current ?? firstNew.id);
    }
    previousRef.current = { context, ids: messages.map((message) => message.id) };
  }, [context, enabled, messages]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const list = listRef.current;
    if (!enabled || !viewport || !list) return;

    // FLAG: Composer, keyboard and late-loading media all change the real scrollable area.
    const update = () => {
      if (followLatestRef.current) scrollToLatest();
      else {
        const nearBottom = distanceToBottom(viewport) < NEAR_BOTTOM_PX;
        followLatestRef.current = nearBottom;
        setIsNearBottom(nearBottom);
        if (nearBottom) setFirstUnreadMessageId(null);
      }
    };
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(viewport);
    observer?.observe(list);
    window.addEventListener('resize', update);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [context, enabled, messages.length > 0]);

  return {
    viewportRef,
    listRef,
    isNearBottom,
    firstUnreadMessageId,
    setFirstUnreadMessageId,
    handleScroll,
    scrollToLatest,
  };
}
