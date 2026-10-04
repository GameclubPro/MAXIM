import { useMutation } from '@tanstack/react-query';
import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import {
  REQUIRED_SUBSCRIPTION_MAX_CHANNELS,
  type ChatSettings,
  type ChatSummary,
  type ManagedEntityHeader,
} from '@maxim/contracts';
import type { ApiTransport } from '../../lib/api/transport';
import { resolveRequiredSubscriptionChannel } from '../../lib/api/chat-settings-client';
import { useManagedEntitiesSync } from '../../lib/use-managed-entities-sync';
import { applyRequiredSubscriptionChannelAddition } from '../settings-page-state';
import { buildRequiredSubscriptionChannelCollections } from '../settings-required-subscription-state';

type ChatCatalog = {
  data: ChatSummary[] | null;
  isLoading: boolean;
  isRefreshing: boolean;
  error: Error | null;
  isBackoffActive: boolean;
};

type Dependencies = {
  api: ApiTransport;
  chatId: string | undefined;
  enabled: boolean;
  draft: ChatSettings | null;
  setDraft: Dispatch<SetStateAction<ChatSettings | null>>;
  chatsList: ChatCatalog;
  serverChannels: ManagedEntityHeader[] | undefined;
  refreshChats(): void;
  clearSelectionError(): void;
  formatError(error: unknown): string;
  onResolved(channel: ManagedEntityHeader, alreadySelected: boolean): void;
  onResolveError(): void;
};

type ResolveRequest = {
  chatId: string;
  generation: number;
  requestId: number;
  inputVersion: number;
  value: string;
};

export function useSettingsRequiredSubscription(dependencies: Dependencies) {
  const { api, chatId, enabled, draft, setDraft, chatsList, serverChannels } = dependencies;
  const latest = useRef(dependencies);
  latest.current = dependencies;
  const scope = useRef({ chatId, generation: 0, requestId: 0, inputVersion: 0 });
  const [externalValue, setExternalValue] = useState('');
  const [externalError, setExternalError] = useState('');
  const [resolvedChannels, setResolvedChannels] = useState<ManagedEntityHeader[]>([]);
  const [refreshRequest, setRefreshRequest] = useState<{
    nonce: number;
    behavior: 'default' | 'manual' | 'recovery';
  }>({ nonce: 0, behavior: 'default' });
  const channelsList = useManagedEntitiesSync({
    api,
    entityType: 'channel',
    enabled,
    reloadNonce: refreshRequest.nonce,
    reloadBehavior: refreshRequest.behavior,
    resumeOnVisibilityReturn: true,
    backgroundRefreshOnFirstLoad: true,
    persistLocalCache: true,
    localCacheScope: 'home',
  });

  function isCurrent(request: ResolveRequest) {
    return (
      scope.current.chatId === request.chatId &&
      scope.current.generation === request.generation &&
      scope.current.requestId === request.requestId
    );
  }

  const resolveMutation = useMutation({
    mutationFn: (request: ResolveRequest) =>
      resolveRequiredSubscriptionChannel(api, request.chatId, request.value),
    onSuccess: ({ channel }, request) => {
      if (!isCurrent(request)) return;
      const currentDraft = latest.current.draft;
      if (!currentDraft) return;
      const alreadySelected = currentDraft.requiredSubscriptionChannelIds.includes(channel.id);
      if (
        !alreadySelected &&
        currentDraft.requiredSubscriptionChannelIds.length >= REQUIRED_SUBSCRIPTION_MAX_CHANNELS
      ) {
        setExternalError(
          `Можно выбрать максимум ${REQUIRED_SUBSCRIPTION_MAX_CHANNELS} чатов и каналов.`,
        );
        return;
      }
      setResolvedChannels((current) => [
        ...current.filter((item) => item.id !== channel.id),
        channel,
      ]);
      if (!alreadySelected) {
        setDraft((current) =>
          current && isCurrent(request)
            ? applyRequiredSubscriptionChannelAddition(
                current,
                channel.id,
                REQUIRED_SUBSCRIPTION_MAX_CHANNELS,
              )
            : current,
        );
        latest.current.clearSelectionError();
      }
      // FLAG: A reply may settle after the user starts typing the next source.
      if (scope.current.inputVersion === request.inputVersion) {
        setExternalValue('');
        setExternalError('');
      }
      latest.current.onResolved(channel, alreadySelected);
    },
    onError: (error, request) => {
      if (!isCurrent(request)) return;
      if (scope.current.inputVersion === request.inputVersion)
        setExternalError(latest.current.formatError(error));
      latest.current.onResolveError();
    },
  });

  useLayoutEffect(() => {
    // FLAG: Navigation and unmount invalidate both successful and failed late replies.
    scope.current.chatId = chatId;
    scope.current.generation += 1;
    scope.current.inputVersion += 1;
    setExternalValue('');
    setExternalError('');
    setResolvedChannels([]);
    setRefreshRequest({ nonce: 0, behavior: 'default' });
    resolveMutation.reset();
    return () => {
      scope.current.generation += 1;
    };
  }, [chatId]);

  const resolvedCandidates = useMemo(() => {
    const byId = new Map<string, ManagedEntityHeader>();
    for (const channel of serverChannels ?? []) byId.set(channel.id, channel);
    for (const channel of resolvedChannels) byId.set(channel.id, channel);
    return [...byId.values()];
  }, [serverChannels, resolvedChannels]);
  const collections = useMemo(
    () =>
      buildRequiredSubscriptionChannelCollections({
        managedChats: chatsList.data,
        managedChannels: channelsList.data,
        resolvedChannels: resolvedCandidates,
        selectedChannelIds: draft?.requiredSubscriptionChannelIds ?? [],
      }),
    [chatsList.data, channelsList.data, resolvedCandidates, draft?.requiredSubscriptionChannelIds],
  );

  function addRequiredSubscriptionChannel(channelId: string) {
    setDraft((current) =>
      current
        ? applyRequiredSubscriptionChannelAddition(
            current,
            channelId,
            REQUIRED_SUBSCRIPTION_MAX_CHANNELS,
          )
        : current,
    );
    latest.current.clearSelectionError();
  }

  function removeRequiredSubscriptionChannel(channelId: string) {
    setDraft((current) => {
      if (!current) return current;
      const ids = current.requiredSubscriptionChannelIds.filter((item) => item !== channelId);
      return {
        ...current,
        requiredSubscriptionEnabled: ids.length > 0,
        requiredSubscriptionChannelIds: ids,
        requiredSubscriptionExpiresAt: '',
      };
    });
    latest.current.clearSelectionError();
  }

  function refreshRequiredSubscriptionChannels() {
    latest.current.refreshChats();
    setRefreshRequest((current) => ({ nonce: current.nonce + 1, behavior: 'manual' }));
  }

  function handleResolveRequiredSubscriptionExternalChannel() {
    const value = externalValue.trim();
    if (!chatId || resolveMutation.isPending) return;
    if (!value) {
      setExternalError('Укажите публичную ссылку на чат, канал или пост MAX.');
      return;
    }
    if (
      (latest.current.draft?.requiredSubscriptionChannelIds.length ?? 0) >=
      REQUIRED_SUBSCRIPTION_MAX_CHANNELS
    ) {
      setExternalError(
        `Можно выбрать максимум ${REQUIRED_SUBSCRIPTION_MAX_CHANNELS} чатов и каналов.`,
      );
      return;
    }
    setExternalError('');
    scope.current.requestId += 1;
    resolveMutation.mutate({
      chatId,
      value,
      generation: scope.current.generation,
      requestId: scope.current.requestId,
      inputVersion: scope.current.inputVersion,
    });
  }

  return {
    requiredSubscriptionExternalChannelValue: externalValue,
    setRequiredSubscriptionExternalChannelValue(value: string) {
      scope.current.inputVersion += 1;
      setExternalValue(value);
    },
    requiredSubscriptionExternalChannelError: externalError,
    setRequiredSubscriptionExternalChannelError: setExternalError,
    isResolvingRequiredSubscriptionChannel: resolveMutation.isPending,
    requiredSubscriptionEntitiesLoading: enabled && (channelsList.isLoading || chatsList.isLoading),
    requiredSubscriptionEntitiesSyncing:
      enabled && (channelsList.isRefreshing || chatsList.isRefreshing),
    requiredSubscriptionEntitiesError: channelsList.error ?? chatsList.error,
    requiredSubscriptionEntitiesBackoffActive:
      channelsList.isBackoffActive || chatsList.isBackoffActive,
    selectedRequiredSubscriptionChannels: collections.selectedChannels,
    selectedRequiredSubscriptionChannelHeaders: collections.selectedHeaders,
    selectedUnavailableRequiredSubscriptionChannels: collections.selectedUnavailableChannels,
    unavailableManagedRequiredSubscriptionChannels: collections.unavailableManagedChannels,
    availableRequiredSubscriptionChannelChoices: collections.availableChoices,
    addRequiredSubscriptionChannel,
    removeRequiredSubscriptionChannel,
    refreshRequiredSubscriptionChannels,
    handleResolveRequiredSubscriptionExternalChannel,
  };
}
