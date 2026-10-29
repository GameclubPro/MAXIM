import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ApiTransport } from '../../lib/api/transport';
import { getSettingsScreen } from '../../lib/api/chat-settings-client';
import { isTerminalApiClientError, shouldRetryTransientApiError } from '../../lib/api-retry';
import { getNavigationAllowlistRefreshInterval } from './settings-link-allowlist';

export function getNightStatusRefreshDelay(
  nextTransitionAt: string | null | undefined,
  now = Date.now(),
) {
  const boundary = nextTransitionAt ? Date.parse(nextTransitionAt) : NaN;
  return Number.isFinite(boundary) && boundary > now
    ? Math.min(60_000, Math.max(1_000, boundary - now + 250))
    : 60_000;
}

export function useSettingsScreenQuery({
  api,
  chatId,
  handoffRequested = false,
  expandedSections,
}: {
  api: ApiTransport;
  chatId: string | undefined;
  handoffRequested?: boolean;
  expandedSections: Record<'links' | 'duplicates' | 'night', boolean>;
}) {
  const query = useQuery({
    queryKey: ['settings-screen', chatId],
    queryFn: ({ signal }) =>
      getSettingsScreen(api, chatId ?? '', { signal, prefetch: handoffRequested }),
    enabled: Boolean(chatId),
    refetchOnMount: 'always',
    refetchOnWindowFocus: expandedSections.links,
    refetchInterval: (current) => {
      const expiry = expandedSections.links
        ? getNavigationAllowlistRefreshInterval(current.state.data?.domains)
        : false;
      return expandedSections.duplicates ? Math.min(60_000, expiry || Infinity) : expiry;
    },
    ...(handoffRequested
      ? {
          retry: (failureCount: number, error: unknown) =>
            shouldRetryTransientApiError(failureCount, error, 7),
          retryDelay: (failureCount: number) => Math.min(800 + failureCount * 400, 2600),
        }
      : {}),
  });
  const boundary = query.data?.closure?.nextTransitionAt;
  const refetch = query.refetch;
  const terminalError = isTerminalApiClientError(query.error);
  useEffect(() => {
    if (!chatId || !expandedSections.night || terminalError) return;
    let disposed = false;
    let pending = false;
    let lastRequested = -Infinity;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      if (
        disposed ||
        pending ||
        document.visibilityState === 'hidden' ||
        Date.now() - lastRequested < 750
      )
        return;
      pending = true;
      lastRequested = Date.now();
      try {
        await refetch({ cancelRefetch: false, throwOnError: false });
      } finally {
        pending = false;
      }
    };
    const schedule = () => {
      timer = setTimeout(() => {
        void refresh().finally(() => {
          if (!disposed) schedule();
        });
      }, getNightStatusRefreshDelay(boundary));
    };
    const onReturn = () => {
      void refresh();
    };
    // FLAG: Only saved server boundaries schedule reads. Refresh never hydrates a dirty
    // settings draft itself; useSettingsDraft retains that separate write boundary.
    void refresh();
    schedule();
    window.addEventListener('focus', onReturn);
    document.addEventListener('visibilitychange', onReturn);
    return () => {
      disposed = true;
      clearTimeout(timer);
      window.removeEventListener('focus', onReturn);
      document.removeEventListener('visibilitychange', onReturn);
    };
  }, [chatId, expandedSections.night, boundary, refetch, terminalError]);
  return query;
}
