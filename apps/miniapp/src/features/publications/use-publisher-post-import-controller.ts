import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ApiTransport } from '../../lib/api/transport';
import {
  cancelPublisherPostImport,
  createPublisherPostImport,
  getActivePublisherPostImport,
  getPublisherPostImportByToken,
} from '../../lib/api/publisher-post-import-client';
import { maxImpact, maxNotify, openMaxBotLinkAndClose } from '../../lib/max-bridge';
import { describeUserFacingError } from '../../lib/user-facing-error';
import { useToast } from '../../components/ui/toast';
import { createPublicationRequestId } from './publication-request-identity';
import { mergePublicationPages } from './publication-pagination';
import type { PublisherPostImportStatusProps } from './publisher-post-import-status';
import { listPublications } from '../../lib/api/publication-client';
import {
  isPublisherDraftRouteId,
  isPublisherPostImportRouteToken,
  resolvePublisherPostImportRouteCleanup,
  STALE_IMPORT_ROUTE_KEYS,
} from './publisher-post-import-route';

const ACTIVE_IMPORT_QUERY_KEY = ['publisher', 'post-imports', 'active'] as const;
const SERVER_DRAFTS_QUERY_KEY = ['publications', 'list', 'drafts'] as const;

type ReplaceSearchParams = (next: URLSearchParams, options: { replace: boolean }) => void;

type PublisherPostImportControllerOptions = {
  api: ApiTransport;
  enabled: boolean;
  editorOpen: boolean;
  hydrated: boolean;
  openingDraft: boolean;
  searchParams: URLSearchParams;
  setSearchParams: ReplaceSearchParams;
  onOpenDraft: (publicationId: string, sessionId: string | null) => void;
};

function tokenQueryKey(token: string) {
  return ['publisher', 'post-imports', 'token', token] as const;
}

export function usePublisherPostImportController({
  api,
  enabled,
  editorOpen,
  hydrated,
  openingDraft,
  searchParams,
  setSearchParams,
  onOpenDraft,
}: PublisherPostImportControllerOptions) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [createSheetOpen, setCreateSheetOpen] = useState(false);
  const pendingRequestIdRef = useRef<string | null>(null);
  const autoOpenedImportRef = useRef<string | null>(null);
  const onOpenDraftRef = useRef(onOpenDraft);
  onOpenDraftRef.current = onOpenDraft;

  const routeToken = searchParams.get('import');
  const validRouteToken = isPublisherPostImportRouteToken(routeToken) ? routeToken : null;
  const serverDraftsQuery = useInfiniteQuery({
    queryKey: SERVER_DRAFTS_QUERY_KEY,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      listPublications(api, { view: 'drafts', limit: 4, cursor: pageParam ?? undefined }),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: enabled && !editorOpen,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const activeImportQuery = useQuery({
    queryKey: ACTIVE_IMPORT_QUERY_KEY,
    queryFn: ({ signal }) => getActivePublisherPostImport(api, { signal }),
    enabled: enabled && !editorOpen && routeToken === null,
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
    refetchInterval: (query) => {
      const status = query.state.data?.session?.status;
      return status === 'waiting' || status === 'processing' ? 1_200 : false;
    },
  });
  const routeImportQuery = useQuery({
    queryKey: tokenQueryKey(validRouteToken ?? ''),
    queryFn: ({ signal }) => getPublisherPostImportByToken(api, validRouteToken ?? '', { signal }),
    enabled: enabled && !editorOpen && validRouteToken !== null,
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
    refetchInterval: (query) => {
      const status = query.state.data?.session?.status;
      return status === 'waiting' || status === 'processing' ? 1_200 : false;
    },
  });
  const displayedSession =
    routeToken !== null
      ? (routeImportQuery.data?.session ?? null)
      : (activeImportQuery.data?.session ?? null);
  const drafts = useMemo(
    () => mergePublicationPages(serverDraftsQuery.data?.pages),
    [serverDraftsQuery.data?.pages],
  );

  const createMutation = useMutation({
    mutationFn: (requestId: string) => createPublisherPostImport(api, { requestId }),
    onSuccess: (session) => {
      pendingRequestIdRef.current = null;
      setCreateSheetOpen(false);
      queryClient.setQueryData(ACTIVE_IMPORT_QUERY_KEY, { session });
      if (session.status === 'waiting') {
        if (!session.botUrl || !openMaxBotLinkAndClose(session.botUrl)) {
          pushToast({ tone: 'danger', title: 'Не удалось открыть диалог Публика' });
        }
      } else if (session.status === 'ready' && session.publicationId) {
        onOpenDraftRef.current(session.publicationId, session.id);
      }
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: describeUserFacingError(error, 'Не удалось начать перенос'),
      });
      maxNotify('error');
    },
  });
  const cancelMutation = useMutation({
    mutationFn: () => cancelPublisherPostImport(api),
    onSuccess: () => {
      queryClient.setQueryData(ACTIVE_IMPORT_QUERY_KEY, { session: null });
      pendingRequestIdRef.current = null;
      maxImpact('soft');
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: describeUserFacingError(error, 'Не удалось отменить перенос'),
      });
    },
  });

  useEffect(() => {
    if (!enabled || editorOpen) {
      return undefined;
    }
    const refresh = () => {
      if (document.visibilityState !== 'visible') {
        return;
      }
      void serverDraftsQuery.refetch();
      if (validRouteToken) {
        void routeImportQuery.refetch();
      } else {
        void activeImportQuery.refetch();
      }
    };
    document.addEventListener('visibilitychange', refresh);
    return () => document.removeEventListener('visibilitychange', refresh);
  }, [
    activeImportQuery.refetch,
    editorOpen,
    enabled,
    routeImportQuery.refetch,
    serverDraftsQuery.refetch,
    validRouteToken,
  ]);

  useEffect(() => {
    if (!enabled || !hydrated || editorOpen) {
      return;
    }
    const draftId = searchParams.get('draft');
    if (routeToken === null && draftId === null) {
      autoOpenedImportRef.current = null;
      return;
    }
    const session = routeToken ? routeImportQuery.data?.session : null;
    const cleanupKeys = resolvePublisherPostImportRouteCleanup({
      draftId,
      exactQueryResolved: routeImportQuery.isSuccess,
      hasExactSession: session !== null && session !== undefined,
      importToken: routeToken,
    });
    if (cleanupKeys.length > 0) {
      removeRouteParams(searchParams, setSearchParams, cleanupKeys);
      return;
    }
    const publicationId = isPublisherDraftRouteId(draftId)
      ? draftId
      : session?.status === 'ready' && session.publicationId
        ? session.publicationId
        : null;
    if (!publicationId || openingDraft) {
      return;
    }
    const autoOpenKey = `${routeToken ?? ''}:${publicationId}`;
    if (autoOpenedImportRef.current === autoOpenKey) {
      return;
    }
    autoOpenedImportRef.current = autoOpenKey;
    onOpenDraftRef.current(
      publicationId,
      session?.publicationId === publicationId ? session.id : null,
    );
  }, [
    editorOpen,
    enabled,
    hydrated,
    openingDraft,
    routeImportQuery.data?.session,
    routeImportQuery.isSuccess,
    routeToken,
    searchParams,
    setSearchParams,
  ]);

  function showCreateSheet() {
    setCreateSheetOpen(true);
    maxImpact('soft');
  }

  function hideCreateSheet() {
    setCreateSheetOpen(false);
  }

  function closeCreateSheet(): boolean {
    if (createMutation.isPending) {
      return false;
    }
    setCreateSheetOpen(false);
    pendingRequestIdRef.current = null;
    return true;
  }

  function startImport() {
    if (createMutation.isPending) {
      return;
    }
    const requestId = pendingRequestIdRef.current ?? createPublicationRequestId();
    pendingRequestIdRef.current = requestId;
    createMutation.mutate(requestId);
    maxImpact('soft');
  }

  async function finishPublishedImport() {
    queryClient.setQueryData(ACTIVE_IMPORT_QUERY_KEY, { session: null });
    await queryClient.invalidateQueries({ queryKey: ACTIVE_IMPORT_QUERY_KEY });
    if (validRouteToken) {
      queryClient.setQueryData(tokenQueryKey(validRouteToken), { session: null });
      await queryClient.invalidateQueries({ queryKey: tokenQueryKey(validRouteToken) });
    }
  }

  function dismissStaleImport() {
    removeRouteParams(searchParams, setSearchParams, STALE_IMPORT_ROUTE_KEYS);
    queryClient.setQueryData(ACTIVE_IMPORT_QUERY_KEY, { session: null });
    void queryClient.invalidateQueries({ queryKey: ACTIVE_IMPORT_QUERY_KEY });
    void serverDraftsQuery.refetch();
  }

  const statusProps: PublisherPostImportStatusProps = {
    session: displayedSession,
    drafts,
    busy: createMutation.isPending || cancelMutation.isPending || openingDraft,
    hasMoreDrafts: Boolean(serverDraftsQuery.hasNextPage),
    loadingMoreDrafts: serverDraftsQuery.isFetchingNextPage,
    onOpenBot(botUrl) {
      if (!openMaxBotLinkAndClose(botUrl)) {
        pushToast({ tone: 'info', title: 'Не удалось открыть диалог Публика' });
      }
    },
    onOpenDraft(publicationId) {
      onOpenDraftRef.current(
        publicationId,
        displayedSession?.publicationId === publicationId ? displayedSession.id : null,
      );
    },
    onLoadMoreDrafts: () => void serverDraftsQuery.fetchNextPage(),
    onRetry: startImport,
    onCancel: () => cancelMutation.mutate(),
  };

  return {
    closeCreateSheet,
    createPending: createMutation.isPending,
    createSheetOpen,
    dismissStaleImport,
    finishPublishedImport,
    hasImportRoute: searchParams.has('import') || searchParams.has('draft'),
    hideCreateSheet,
    showCreateSheet,
    startImport,
    statusProps,
  };
}

function removeRouteParams(
  searchParams: URLSearchParams,
  setSearchParams: ReplaceSearchParams,
  keys: readonly string[],
) {
  const next = new URLSearchParams(searchParams);
  keys.forEach((key) => next.delete(key));
  setSearchParams(next, { replace: true });
}
