import {
  PUBLISHER_ENTITIES_CURSOR_INVALID_CODE,
  type PublisherEntitiesSummary,
  type PublisherEntity,
} from '@maxim/contracts/publisher';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { getChats, getChannels } from '../../lib/api/root-client';
import { listPublisherEntities, refreshPublisherEntities } from '../../lib/api/publisher-client';
import type { ApiTransport } from '../../lib/api/transport';
import { ApiRequestError } from '../../lib/api-request-error';
import {
  toPublicationTarget,
  type PublicationEntityFilter,
  type PublicationTarget,
} from './publication-model';

const PUBLISHER_TARGET_PAGE_SIZE = 30;
const PUBLISHER_RECHECK_SETTLE_MS = 15_500;

export function isInvalidPublisherEntitiesCursorError(error: unknown): boolean {
  return (
    error instanceof ApiRequestError &&
    error.status === 400 &&
    error.code === PUBLISHER_ENTITIES_CURSOR_INVALID_CODE
  );
}

export function publisherEntityToPublicationTarget(source: PublisherEntity): PublicationTarget {
  return {
    id: source.id,
    entityType: source.entityType,
    title: source.title.trim() || (source.entityType === 'channel' ? 'Канал' : 'Чат'),
    avatarUrl: source.avatarUrl,
    channelOverview:
      source.entityType === 'channel' && source.channelOverview
        ? {
            commentsEnabled: source.channelOverview.commentsEnabled,
            postSuggestionsEnabled: source.channelOverview.postSuggestionsEnabled,
          }
        : null,
    readiness: source.readiness,
  };
}

export function usePublicationTargetSources(api: ApiTransport, publisherProfile: boolean) {
  const queryClient = useQueryClient();
  const [publisherInputQuery, setPublisherInputQuery] = useState('');
  const [publisherQuery, setPublisherQuery] = useState('');
  const [publisherEntityFilter, setPublisherEntityFilter] =
    useState<PublicationEntityFilter>('all');
  const [publisherRechecking, setPublisherRechecking] = useState(false);
  const publisherSearchSettling = publisherInputQuery.trim() !== publisherQuery;
  const publisherEntityType = publisherEntityFilter === 'all' ? undefined : publisherEntityFilter;
  useEffect(() => {
    const timeoutId = window.setTimeout(() => setPublisherQuery(publisherInputQuery.trim()), 250);
    return () => window.clearTimeout(timeoutId);
  }, [publisherInputQuery]);
  const chats = useQuery({
    queryKey: ['publications', 'sources', 'chats'],
    queryFn: () => getChats(api, { fresh: false }),
    enabled: !publisherProfile,
  });
  const channels = useQuery({
    queryKey: ['publications', 'sources', 'channels'],
    queryFn: () => getChannels(api, { fresh: false }),
    enabled: !publisherProfile,
  });
  const publisherQueryKey = [
    'publications',
    'sources',
    'publisher',
    'cursor',
    { query: publisherQuery, entityType: publisherEntityType ?? null, readiness: 'ready' },
  ] as const;
  const publisher = useInfiniteQuery({
    queryKey: publisherQueryKey,
    queryFn: ({ pageParam, signal }) =>
      listPublisherEntities(api, {
        pagination: 'cursor',
        limit: PUBLISHER_TARGET_PAGE_SIZE,
        query: publisherQuery,
        entityType: publisherEntityType,
        readiness: 'ready',
        cursor: pageParam,
        signal,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: publisherProfile,
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });
  const targets = useMemo(
    () =>
      publisherProfile
        ? (publisher.data?.pages ?? [])
            .flatMap((page) => page.items)
            .map(publisherEntityToPublicationTarget)
        : [...(chats.data ?? []), ...(channels.data ?? [])].map(toPublicationTarget),
    [channels.data, chats.data, publisher.data?.pages, publisherProfile],
  );
  const publisherSummary: PublisherEntitiesSummary | null =
    publisher.data?.pages[0]?.summary ?? null;
  const publisherHasData = publisher.data !== undefined;
  const publisherInitialError = publisher.isError && !publisherHasData;

  return {
    targets,
    publisherInputQuery,
    publisherEntityFilter,
    publisherSearchSettling,
    setPublisherInputQuery,
    setPublisherEntityFilter,
    publisherSummary,
    filteredTotal: publisher.data?.pages[0]?.filteredTotal ?? null,
    hasNextPage: publisherProfile && Boolean(publisher.hasNextPage),
    fetchingNextPage: publisherProfile && publisher.isFetchingNextPage,
    fetchNextPageError: publisherProfile && publisher.isFetchNextPageError,
    fetchNextPage: async () => {
      const result = await publisher.fetchNextPage();
      if (result.isError && isInvalidPublisherEntitiesCursorError(result.error)) {
        await queryClient.resetQueries({ queryKey: publisherQueryKey, exact: true });
      }
    },
    loading: publisherProfile ? publisher.isLoading : chats.isLoading || channels.isLoading,
    fetching: publisherProfile
      ? publisher.isFetching || publisherRechecking
      : chats.isFetching || channels.isFetching,
    hasError: publisherProfile ? publisherInitialError : chats.isError || channels.isError,
    unavailable: publisherProfile ? publisherInitialError : chats.isError && channels.isError,
    ready: publisherProfile
      ? publisher.isSuccess || publisherHasData
      : chats.isSuccess && channels.isSuccess,
    chatsFailed: chats.isError,
    refetch: () =>
      publisherProfile
        ? queryClient.resetQueries({ queryKey: publisherQueryKey, exact: true })
        : Promise.all([chats.refetch(), channels.refetch()]).then(() => undefined),
    recheck: async () => {
      if (!publisherProfile || publisherRechecking) {
        return;
      }
      setPublisherRechecking(true);
      try {
        const refresh = await refreshPublisherEntities(api);
        window.setTimeout(
          () => {
            void Promise.all([
              queryClient.resetQueries({ queryKey: publisherQueryKey, exact: true }),
              queryClient.invalidateQueries({ queryKey: ['publisher', 'entity'] }),
            ]).finally(() => setPublisherRechecking(false));
          },
          refresh.queuedCount > 0 ? PUBLISHER_RECHECK_SETTLE_MS : 0,
        );
      } catch (error) {
        setPublisherRechecking(false);
        throw error;
      }
    },
    setupHandoffUrl: publisher.data?.pages[0]?.setupHandoffUrl ?? null,
  };
}
