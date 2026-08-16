import { QueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { getApiErrorStatus, shouldRetryTransientApiError } from './api-retry';
import type { AuthSessionCoordinator } from './auth-session-coordinator';
import { createMiniappBootTraceSessionId as createOpaqueSessionId } from './boot-trace-session-id';

export function resolveAuthQueryPrincipalKey(
  _initData: string | null,
  previewEnabled: boolean,
  createSessionId: () => string = createOpaqueSessionId,
): string {
  if (previewEnabled) {
    return 'preview';
  }

  // FLAG: launchBotId is server-only. Never key authenticated cache by parsed user or initData.
  return `credential:${createSessionId()}`;
}

export function useAuthQueryPrincipalKey(initData: string | null, previewEnabled: boolean): string {
  return useMemo(
    () => resolveAuthQueryPrincipalKey(initData, previewEnabled),
    [initData, previewEnabled],
  );
}

export function createAuthQueryClient(authSession?: AuthSessionCoordinator): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        retry: (failureCount, error) => shouldRetryTransientApiError(failureCount, error),
      },
    },
  });

  authSession?.subscribe((event) => {
    if (event.type !== 'recovered') {
      return;
    }

    void queryClient
      .refetchQueries({
        type: 'active',
        predicate: (query) => getApiErrorStatus(query.state.error) === 401,
      })
      .catch(() => undefined);
  });

  return queryClient;
}
