import type { PublisherEntitiesSummary, PublisherEntity } from '@maxim/contracts/publisher';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { getChats, getChannels } from '../../lib/api/root-client';
import { listPublisherEntities } from '../../lib/api/publisher-client';
import type { ApiTransport } from '../../lib/api/transport';
import {
  toPublicationTarget,
  type PublicationEntityFilter,
  type PublicationTarget,
} from './publication-model';

const PUBLISHER_TARGET_PAGE_SIZE = 30;

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
    { query: publisherQuery, entityType: publisherEntityType ?? null },
  ] as const;
  const publisher = useInfiniteQuery({
    queryKey: publisherQueryKey,
    queryFn: ({ pageParam, signal }) =>
      listPublisherEntities(api, {
        pagination: 'cursor',
        limit: PUBLISHER_TARGET_PAGE_SIZE,
        query: publisherQuery,
        entityType: publisherEntityType,
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
    fetchNextPage: () =>
      publisher.isFetchNextPageError
        ? queryClient.resetQueries({ queryKey: publisherQueryKey, exact: true })
        : publisher.fetchNextPage().then(() => undefined),
    loading: publisherProfile ? publisher.isLoading : chats.isLoading || channels.isLoading,
    fetching: publisherProfile ? publisher.isFetching : chats.isFetching || channels.isFetching,
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
  };
}
