import type { QueryClient } from '@tanstack/react-query';
import { getEntityDialog } from './api/channel-dialog-client';
import type { ApiTransport } from './api/transport';
import { queryKeys } from './query-keys';
import { preloadChannelDialogPage } from '../pages/page-preloads';

export function parseCommentDialogLocation(pathname: string, search: string) {
  const match = /^\/(chat|channel)\/([^/]+)\/dialog\/comments\/?$/u.exec(pathname);
  const token = new URLSearchParams(search).get('token')?.trim();
  if (!match || !token) return null;
  try {
    const chatId = decodeURIComponent(match[2]);
    if (!chatId || chatId === '.' || chatId === '..' || /[/\\?#]/u.test(chatId)) return null;
    return { entityType: match[1] as 'chat' | 'channel', chatId, token };
  } catch {
    return null;
  }
}

export function prepareCommentDialogStartup(
  queryClient: QueryClient,
  api: ApiTransport,
  pathname: string,
  search: string,
): () => void {
  const target = parseCommentDialogLocation(pathname, search);
  if (!target) return () => undefined;
  const { entityType, chatId, token } = target;
  const queryKey = queryKeys.entityDialog(entityType, chatId, 'comments', token);
  void preloadChannelDialogPage().catch(() => undefined);
  // FLAG: The caller owns a credential-scoped client. The API, never the launch URL,
  // authorizes the profile and thread; no private data is persisted across launches.
  void queryClient.prefetchQuery({
    queryKey,
    queryFn: ({ signal }) =>
      getEntityDialog(api, entityType, chatId, 'comments', token, { signal }),
    staleTime: 30_000,
    retry: false,
  });
  return () => {
    void queryClient.cancelQueries({ queryKey, exact: true });
  };
}
