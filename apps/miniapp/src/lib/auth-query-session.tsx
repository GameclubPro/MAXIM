import { QueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { createMiniappBootTraceSessionId as createOpaqueSessionId } from './boot-trace-session-id';
import { readUserIdFromInitData } from './init-data';

export function resolveAuthQueryPrincipalKey(
  initData: string | null,
  previewEnabled: boolean,
  createSessionId: () => string = createOpaqueSessionId,
): string {
  if (previewEnabled) {
    return 'preview';
  }

  const userId = initData ? readUserIdFromInitData(initData) : null;
  if (userId) {
    // FLAG: Valid sessions are keyed by signed identity, not rotating auth_date/hash credentials.
    return `user:${userId}`;
  }

  return `unresolved:${createSessionId()}`;
}

export function useAuthQueryPrincipalKey(
  initData: string | null,
  previewEnabled: boolean,
): string {
  return useMemo(
    () => resolveAuthQueryPrincipalKey(initData, previewEnabled),
    [initData, previewEnabled],
  );
}

export function createAuthQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        retry: 1,
      },
    },
  });
}
