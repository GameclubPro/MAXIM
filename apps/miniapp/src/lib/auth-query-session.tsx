import { QueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { createMiniappBootTraceSessionId as createOpaqueSessionId } from './boot-trace-session-id';
import { readUserIdFromInitData } from './init-data';

const PREVIEW_AUTH_PRINCIPAL_KEY = 'preview';

type UnresolvedAuthQueryPrincipal = [credentials: string, principalKey: string];

export function resolveAuthQueryPrincipalKey(
  initData: string | null,
  previewEnabled: boolean,
  previousUnresolvedPrincipal: UnresolvedAuthQueryPrincipal | null = null,
  createSessionId: () => string = createOpaqueSessionId,
): [string, UnresolvedAuthQueryPrincipal | null] {
  if (previewEnabled) {
    return [PREVIEW_AUTH_PRINCIPAL_KEY, previousUnresolvedPrincipal];
  }

  const userId = initData ? readUserIdFromInitData(initData) : null;
  if (userId) {
    // FLAG: Valid sessions are keyed by signed identity, not rotating auth_date/hash credentials.
    return [`user:${userId}`, previousUnresolvedPrincipal];
  }

  const credentials = initData ?? '';
  const unresolvedPrincipal =
    previousUnresolvedPrincipal?.[0] === credentials
      ? previousUnresolvedPrincipal
      : ([credentials, `unresolved:${createSessionId()}`] as UnresolvedAuthQueryPrincipal);

  return [unresolvedPrincipal[1], unresolvedPrincipal];
}

export function useAuthQueryPrincipalKey(
  initData: string | null,
  previewEnabled: boolean,
): string {
  const unresolvedPrincipalRef = useRef<UnresolvedAuthQueryPrincipal | null>(null);
  const [principalKey, unresolvedPrincipal] = resolveAuthQueryPrincipalKey(
    initData,
    previewEnabled,
    unresolvedPrincipalRef.current,
  );
  unresolvedPrincipalRef.current = unresolvedPrincipal;
  return principalKey;
}

export function createAuthQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: false,
        refetchOnReconnect: true,
        retry: 1,
      },
    },
  });
}

export async function disposeAuthQueryClient(queryClient: QueryClient): Promise<void> {
  await queryClient.cancelQueries();
  queryClient.clear();
}
