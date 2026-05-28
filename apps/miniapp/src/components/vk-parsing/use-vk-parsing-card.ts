import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  UpdateVkParsingSettingsRequest,
  VkParsingFeedQuery,
  VkParsingPost,
  VkParsingPostFilterStatus,
} from '@maxim/contracts';
import {
  addVkParsingSource,
  getVkParsing,
  publishVkParsingPost,
  refreshVkParsing,
  removeVkParsingSource,
  retryVkParsingPost,
  updateVkParsingSettings,
  type VkParsingEntityType,
} from '../../lib/api/vk-parsing-client';
import type { ApiTransport } from '../../lib/api/transport';
import { maxNotify } from '../../lib/max-bridge';
import { queryKeys } from '../../lib/query-keys';
import { useToast } from '../ui/toast';
import { normalizeApiError, toggleValue } from './format';
import {
  VK_PARSING_PAGE_SIZE,
  type PublishPayload,
  type VkParsingHintKey,
  type VkParsingSettingKey,
} from './types';

type UseVkParsingCardParams = {
  api: ApiTransport;
  chatId: string;
  active: boolean;
  entityType: VkParsingEntityType;
};

export function useVkParsingCard({ api, chatId, active, entityType }: UseVkParsingCardParams) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [sourceUrl, setSourceUrl] = useState('');
  const [editingPostId, setEditingPostId] = useState<string | null>(null);
  const [draftText, setDraftText] = useState('');
  const [selectedPhotoUrls, setSelectedPhotoUrls] = useState<string[]>([]);
  const [selectedLinkUrls, setSelectedLinkUrls] = useState<string[]>([]);
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<VkParsingPostFilterStatus>('ALL');
  const [pageOffset, setPageOffset] = useState(0);
  const [openHintKey, setOpenHintKey] = useState<VkParsingHintKey | null>(null);

  const feedQueryScope = useMemo<Partial<VkParsingFeedQuery>>(
    () => ({
      status: statusFilter,
      sourceId: selectedSourceId ?? undefined,
      limit: VK_PARSING_PAGE_SIZE,
      offset: pageOffset,
    }),
    [pageOffset, selectedSourceId, statusFilter],
  );

  const feedQuery = useQuery({
    queryKey: queryKeys.vkParsing(entityType, chatId, feedQueryScope),
    queryFn: () => getVkParsing(api, entityType, chatId, feedQueryScope),
    enabled: Boolean(chatId) && active,
    staleTime: 30_000,
    refetchInterval: active ? 15_000 : false,
    refetchOnWindowFocus: false,
  });

  const addSourceMutation = useMutation({
    mutationFn: (url: string) => addVkParsingSource(api, entityType, chatId, url),
    onSuccess: () => {
      setSourceUrl('');
      void queryClient.invalidateQueries({ queryKey: queryKeys.vkParsing(entityType, chatId) });
      pushToast({
        tone: 'success',
        title: 'Источник добавлен',
        description: 'Обновление запущено',
      });
      maxNotify('success');
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Источник не добавлен',
        description: normalizeApiError(error),
      });
      maxNotify('error');
    },
  });

  const removeSourceMutation = useMutation({
    mutationFn: (sourceId: string) => removeVkParsingSource(api, entityType, chatId, sourceId),
    onSuccess: (_feed, sourceId) => {
      if (selectedSourceId === sourceId) {
        setSelectedSourceId(null);
      }
      void queryClient.invalidateQueries({ queryKey: queryKeys.vkParsing(entityType, chatId) });
      pushToast({ tone: 'info', title: 'Источник отключён' });
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Источник не отключён',
        description: normalizeApiError(error),
      });
      maxNotify('error');
    },
  });

  const refreshMutation = useMutation({
    mutationFn: () => refreshVkParsing(api, entityType, chatId),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.vkParsing(entityType, chatId) });
      pushToast({
        tone: result.queued > 0 ? 'success' : 'info',
        title: result.queued > 0 ? 'Обновление запущено' : 'Нечего обновлять',
      });
      maxNotify(result.queued > 0 ? 'success' : 'warning');
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Обновление не выполнено',
        description: normalizeApiError(error),
      });
      maxNotify('error');
    },
  });

  const updateSettingsMutation = useMutation({
    mutationFn: (payload: UpdateVkParsingSettingsRequest) =>
      updateVkParsingSettings(api, entityType, chatId, payload),
    onSuccess: (nextFeed) => {
      queryClient.setQueryData(queryKeys.vkParsing(entityType, chatId, feedQueryScope), nextFeed);
      void queryClient.invalidateQueries({ queryKey: queryKeys.vkParsing(entityType, chatId) });
      pushToast({ tone: 'success', title: 'Настройки сохранены' });
      maxNotify('success');
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Настройки не сохранены',
        description: normalizeApiError(error),
      });
      maxNotify('error');
    },
  });

  const publishMutation = useMutation({
    mutationFn: (payload: PublishPayload) =>
      publishVkParsingPost(api, entityType, chatId, payload.postId, {
        text: payload.text,
        photoUrls: payload.photoUrls,
        linkUrls: payload.linkUrls,
      }),
    onSuccess: () => {
      setEditingPostId(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.vkParsing(entityType, chatId) });
      pushToast({ tone: 'success', title: 'Пост опубликован' });
      maxNotify('success');
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Пост не опубликован',
        description: normalizeApiError(error),
      });
      maxNotify('error');
    },
  });

  const retryMutation = useMutation({
    mutationFn: (postId: string) => retryVkParsingPost(api, entityType, chatId, postId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.vkParsing(entityType, chatId) });
      pushToast({ tone: 'success', title: 'Повтор поставлен в очередь' });
      maxNotify('success');
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Повтор не запущен',
        description: normalizeApiError(error),
      });
      maxNotify('error');
    },
  });

  const feed = feedQuery.data;
  const settings = feed?.settings ?? {
    chatId,
    autoPublishEnabled: false,
    autoPublishEnabledAt: null,
    stripLinksEnabled: false,
    skipAdsEnabled: false,
    updatedAt: null,
  };
  const posts = feed?.posts ?? [];
  const sources = feed?.sources ?? [];
  const editingPost = useMemo(
    () => posts.find((post) => post.id === editingPostId) ?? null,
    [editingPostId, posts],
  );

  useEffect(() => {
    setPageOffset(0);
  }, [selectedSourceId, statusFilter]);

  useEffect(() => {
    if (!selectedSourceId || sources.some((source) => source.id === selectedSourceId)) {
      return;
    }

    setSelectedSourceId(null);
  }, [selectedSourceId, sources]);

  useEffect(() => {
    if (!editingPostId || editingPost) {
      return;
    }

    setEditingPostId(null);
  }, [editingPost, editingPostId]);

  function startEditing(post: VkParsingPost) {
    setEditingPostId(post.id);
    setDraftText(post.text);
    setSelectedPhotoUrls(post.photoUrls);
    setSelectedLinkUrls(settings.stripLinksEnabled ? [] : post.linkUrls);
  }

  function submitSource(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalized = sourceUrl.trim();
    if (!normalized || addSourceMutation.isPending) {
      return;
    }

    addSourceMutation.mutate(normalized);
  }

  function publishEditingPost() {
    if (!editingPost || publishMutation.isPending) {
      return;
    }

    publishMutation.mutate({
      postId: editingPost.id,
      text: draftText,
      photoUrls: selectedPhotoUrls,
      linkUrls: selectedLinkUrls,
    });
  }

  function toggleSetting(key: VkParsingSettingKey, checked: boolean) {
    if (updateSettingsMutation.isPending) {
      return;
    }

    updateSettingsMutation.mutate({ [key]: checked });
  }

  function toggleHint(key: VkParsingHintKey) {
    setOpenHintKey((current) => (current === key ? null : key));
  }

  return {
    feed,
    feedQuery,
    settings,
    posts,
    sources,
    sourceUrl,
    selectedSourceId,
    statusFilter,
    pageOffset,
    openHintKey,
    editingPostId,
    draftText,
    selectedPhotoUrls,
    selectedLinkUrls,
    publishingPostId: publishMutation.isPending
      ? (publishMutation.variables?.postId ?? null)
      : null,
    retryingPostId: retryMutation.isPending ? (retryMutation.variables ?? null) : null,
    isAddingSource: addSourceMutation.isPending,
    isRemovingSource: removeSourceMutation.isPending,
    isRefreshing: refreshMutation.isPending,
    isSavingSettings: updateSettingsMutation.isPending,
    setSourceUrl,
    setDraftText,
    setPageOffset,
    submitSource,
    refreshSources: () => refreshMutation.mutate(),
    removeSource: (sourceId: string) => removeSourceMutation.mutate(sourceId),
    selectSource: setSelectedSourceId,
    selectStatusFilter: setStatusFilter,
    toggleHint,
    toggleSetting,
    startEditing,
    cancelEditing: () => setEditingPostId(null),
    publishEditingPost,
    retryPost: (postId: string) => retryMutation.mutate(postId),
    togglePhoto: (url: string) => setSelectedPhotoUrls((current) => toggleValue(current, url)),
    toggleLink: (url: string) => setSelectedLinkUrls((current) => toggleValue(current, url)),
  };
}
