import { useEffect, useEffectEvent } from 'react';

export function eventFeedRefreshDelay(intervalMs: number, failures: number): number {
  return Math.min(60_000, intervalMs * 2 ** Math.min(6, failures));
}

export function useEventFeedRefresh({
  enabled,
  scopeKey,
  feed,
}: {
  enabled: boolean;
  scopeKey: string;
  feed: { canAutoRefresh: boolean; refreshFailures: number; refresh: () => Promise<void> };
}) {
  const refresh = useEffectEvent(() => {
    if (document.visibilityState === 'visible' && navigator.onLine !== false) void feed.refresh();
  });
  useEffect(() => {
    if (!enabled || !feed.canAutoRefresh) return;
    const timer = window.setInterval(refresh, eventFeedRefreshDelay(10_000, feed.refreshFailures));
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('online', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('online', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, [enabled, scopeKey, feed.canAutoRefresh, feed.refreshFailures]);
}
