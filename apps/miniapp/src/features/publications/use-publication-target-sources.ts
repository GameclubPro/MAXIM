import type { PublisherEntity } from '@maxim/contracts/publisher';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { getChats, getChannels } from '../../lib/api/root-client';
import { listPublisherEntities } from '../../lib/api/publisher-client';
import type { ApiTransport } from '../../lib/api/transport';
import { toPublicationTarget, type PublicationTarget } from './publication-model';

function toPublisherTarget(source: PublisherEntity): PublicationTarget {
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
  const publisher = useQuery({
    queryKey: ['publications', 'sources', 'publisher'],
    queryFn: ({ signal }) => listPublisherEntities(api, { signal }),
    enabled: publisherProfile,
  });
  const targets = useMemo(
    () =>
      publisherProfile
        ? (publisher.data?.items ?? []).map(toPublisherTarget)
        : [...(chats.data ?? []), ...(channels.data ?? [])].map(toPublicationTarget),
    [channels.data, chats.data, publisher.data?.items, publisherProfile],
  );

  return {
    targets,
    loading: publisherProfile ? publisher.isLoading : chats.isLoading || channels.isLoading,
    fetching: publisherProfile ? publisher.isFetching : chats.isFetching || channels.isFetching,
    hasError: publisherProfile ? publisher.isError : chats.isError || channels.isError,
    unavailable: publisherProfile ? publisher.isError : chats.isError && channels.isError,
    ready: publisherProfile ? publisher.isSuccess : chats.isSuccess && channels.isSuccess,
    chatsFailed: chats.isError,
    refetch: () =>
      publisherProfile
        ? publisher.refetch().then(() => undefined)
        : Promise.all([chats.refetch(), channels.refetch()]).then(() => undefined),
  };
}
