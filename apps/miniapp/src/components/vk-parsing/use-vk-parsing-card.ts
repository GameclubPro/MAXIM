import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  BulkUpdateVkParsingSourcesRequest,
  UpdateVkParsingSettingsRequest,
  UpdateVkParsingSourceRequest,
  VkParsingFeedQuery,
  VkParsingPost,
  VkParsingPostFilterStatus,
} from '@maxim/contracts';
import {
  addVkParsingSource,
  applyVkParsingSourcePreset,
  cancelVkParsingPost,
  dryRunVkParsingAutopublish,
  getVkParsing,
  publishVkParsingPost,
  publishVkParsingPostNow,
  refreshVkParsing,
  refreshVkParsingSource,
  removeVkParsingSource,
  retryVkParsingPost,
  scheduleVkParsingPost,
  updateVkParsingReviewDraft,
  updateVkParsingSource,
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
  const [selectedVideoUrls, setSelectedVideoUrls] = useState<string[]>([]);
  const [selectedLinkUrls, setSelectedLinkUrls] = useState<string[]>([]);
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<VkParsingPostFilterStatus>('ALL');
  const [pageOffset, setPageOffset] = useState(0);
  const [openHintKey, setOpenHintKey] = useState<VkParsingHintKey | null>(null);
  const [selectedBulkSourceIds, setSelectedBulkSourceIds] = useState<string[]>([]);

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

  const updateSourceMutation = useMutation({
    mutationFn: ({
      sourceId,
      payload,
    }: {
      sourceId: string;
      payload: UpdateVkParsingSourceRequest;
    }) => updateVkParsingSource(api, entityType, chatId, sourceId, payload),
    onSuccess: (nextFeed) => {
      queryClient.setQueryData(queryKeys.vkParsing(entityType, chatId, feedQueryScope), nextFeed);
      void queryClient.invalidateQueries({ queryKey: queryKeys.vkParsing(entityType, chatId) });
      pushToast({ tone: 'success', title: 'Источник сохранён' });
      maxNotify('success');
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Источник не сохранён',
        description: normalizeApiError(error),
      });
      maxNotify('error');
    },
  });

  const updateSourcesMutation = useMutation({
    mutationFn: async ({
      sourceIds,
      payload,
    }: {
      sourceIds: string[];
      payload: UpdateVkParsingSourceRequest;
    }) => {
      let nextFeed = feedQuery.data ?? null;
      for (const sourceId of sourceIds) {
        nextFeed = await updateVkParsingSource(api, entityType, chatId, sourceId, payload);
      }
      if (!nextFeed) {
        throw new Error('Источники не выбраны.');
      }
      return nextFeed;
    },
    onSuccess: (nextFeed) => {
      queryClient.setQueryData(queryKeys.vkParsing(entityType, chatId, feedQueryScope), nextFeed);
      void queryClient.invalidateQueries({ queryKey: queryKeys.vkParsing(entityType, chatId) });
      pushToast({ tone: 'success', title: 'Источники сохранены' });
      maxNotify('success');
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Источники не сохранены',
        description: normalizeApiError(error),
      });
      maxNotify('error');
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.vkParsing(entityType, chatId) });
    },
  });

  const sourcePresetMutation = useMutation({
    mutationFn: (payload: BulkUpdateVkParsingSourcesRequest) =>
      applyVkParsingSourcePreset(api, entityType, chatId, payload),
    onSuccess: (nextFeed) => {
      setSelectedBulkSourceIds([]);
      queryClient.setQueryData(queryKeys.vkParsing(entityType, chatId, feedQueryScope), nextFeed);
      void queryClient.invalidateQueries({ queryKey: queryKeys.vkParsing(entityType, chatId) });
      pushToast({ tone: 'success', title: 'Настройки применены' });
      maxNotify('success');
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Настройки не применены',
        description: normalizeApiError(error),
      });
      maxNotify('error');
    },
  });

  const refreshSourceMutation = useMutation({
    mutationFn: (sourceId: string) => refreshVkParsingSource(api, entityType, chatId, sourceId),
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
        title: 'Источник не обновлён',
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
        videoUrls: payload.videoUrls,
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

  const reviewDraftMutation = useMutation({
    mutationFn: (payload: PublishPayload) =>
      updateVkParsingReviewDraft(api, entityType, chatId, payload.postId, {
        text: payload.text,
        photoUrls: payload.photoUrls,
        videoUrls: payload.videoUrls,
        linkUrls: payload.linkUrls,
      }),
    onSuccess: (nextFeed) => {
      setEditingPostId(null);
      queryClient.setQueryData(queryKeys.vkParsing(entityType, chatId, feedQueryScope), nextFeed);
      void queryClient.invalidateQueries({ queryKey: queryKeys.vkParsing(entityType, chatId) });
      pushToast({ tone: 'success', title: 'Сохранено на модерации' });
      maxNotify('success');
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не сохранено',
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

  const scheduleMutation = useMutation({
    mutationFn: ({ postId, scheduledAt }: { postId: string; scheduledAt: string }) =>
      scheduleVkParsingPost(api, entityType, chatId, postId, { scheduledAt }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.vkParsing(entityType, chatId) });
      pushToast({ tone: 'success', title: 'Время обновлено' });
      maxNotify('success');
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Время не обновлено',
        description: normalizeApiError(error),
      });
      maxNotify('error');
    },
  });

  const cancelPostMutation = useMutation({
    mutationFn: (postId: string) => cancelVkParsingPost(api, entityType, chatId, postId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.vkParsing(entityType, chatId) });
      pushToast({ tone: 'info', title: 'Публикация снята' });
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Публикация не снята',
        description: normalizeApiError(error),
      });
      maxNotify('error');
    },
  });

  const publishNowMutation = useMutation({
    mutationFn: (postId: string) => publishVkParsingPostNow(api, entityType, chatId, postId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.vkParsing(entityType, chatId) });
      pushToast({ tone: 'success', title: 'Поставлено сейчас' });
      maxNotify('success');
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не поставлено',
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
    autoPublishKillSwitchEnabled: false,
    stripLinksEnabled: false,
    skipAdsEnabled: false,
    schedulerTimezone: 'Europe/Moscow',
    quietHoursStart: null,
    quietHoursEnd: null,
    workHoursStart: '09:00',
    workHoursEnd: '22:00',
    distributeEvenlyEnabled: true,
    roundRobinEnabled: true,
    circuitBreakerEnabled: true,
    circuitBreakerWindowMinutes: 10,
    circuitBreakerPostLimit: 10,
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
    if (
      !selectedSourceId ||
      feedQuery.isLoading ||
      sources.some((source) => source.id === selectedSourceId)
    ) {
      return;
    }

    setSelectedSourceId(null);
  }, [feedQuery.isLoading, selectedSourceId, sources]);

  useEffect(() => {
    if (!editingPostId || editingPost) {
      return;
    }

    setEditingPostId(null);
  }, [editingPost, editingPostId]);

  function startEditing(post: VkParsingPost) {
    const initialVideoUrls = post.videoUrls.slice(0, 1);
    setEditingPostId(post.id);
    setDraftText(post.text);
    setSelectedPhotoUrls(initialVideoUrls.length > 0 ? [] : post.photoUrls);
    setSelectedVideoUrls(initialVideoUrls);
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
    if (!editingPost || publishMutation.isPending || reviewDraftMutation.isPending) {
      return;
    }

    const payload = {
      postId: editingPost.id,
      text: draftText,
      photoUrls: selectedPhotoUrls,
      videoUrls: selectedVideoUrls,
      linkUrls: selectedLinkUrls,
    };

    if (editingPost.sourcePublishMode === 'REVIEW') {
      reviewDraftMutation.mutate(payload);
      return;
    }

    publishMutation.mutate(payload);
  }

  function toggleSetting(key: VkParsingSettingKey, checked: boolean) {
    if (updateSettingsMutation.isPending) {
      return;
    }

    updateSettingsMutation.mutate({ [key]: checked });
  }

  async function updateSetting(payload: UpdateVkParsingSettingsRequest) {
    if (updateSettingsMutation.isPending) {
      return;
    }
    if (payload.autoPublishEnabled === true) {
      const dryRun = await dryRunVkParsingAutopublish(api, entityType, chatId);
      if (dryRun.eligibleNow > 0) {
        pushToast({
          tone: 'danger',
          title: 'Автопубликация пока не включена',
          description: `Сначала проверьте старые посты: ${dryRun.eligibleNow} готовы к публикации.`,
        });
        maxNotify('warning');
        return;
      }
    }
    updateSettingsMutation.mutate(payload);
  }

  async function updateSource(sourceId: string, payload: UpdateVkParsingSourceRequest) {
    if (updateSourceMutation.isPending || updateSourcesMutation.isPending) {
      return;
    }
    if (payload.autoPublishEnabled === true) {
      const dryRun = await dryRunVkParsingAutopublish(api, entityType, chatId, sourceId);
      if (dryRun.eligibleNow > 0) {
        pushToast({
          tone: 'danger',
          title: 'Автопубликация пока не включена',
          description: `Сначала проверьте старые посты: ${dryRun.eligibleNow} готовы к публикации.`,
        });
        maxNotify('warning');
        return;
      }
    }
    updateSourceMutation.mutate({ sourceId, payload });
  }

  function updateSources(sourceIds: string[], payload: UpdateVkParsingSourceRequest) {
    if (
      updateSourceMutation.isPending ||
      updateSourcesMutation.isPending ||
      sourceIds.length === 0
    ) {
      return;
    }

    updateSourcesMutation.mutate({ sourceIds, payload });
  }

  function toggleHint(key: VkParsingHintKey) {
    setOpenHintKey((current) => (current === key ? null : key));
  }

  function toggleBulkSource(sourceId: string) {
    setSelectedBulkSourceIds((current) =>
      current.includes(sourceId)
        ? current.filter((item) => item !== sourceId)
        : [...current, sourceId],
    );
  }

  function selectAllBulkSources() {
    setSelectedBulkSourceIds((current) =>
      current.length === sources.length ? [] : sources.map((source) => source.id),
    );
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
    selectedBulkSourceIds,
    editingPostId,
    draftText,
    selectedPhotoUrls,
    selectedVideoUrls,
    selectedLinkUrls,
    publishingPostId: publishMutation.isPending
      ? (publishMutation.variables?.postId ?? null)
      : reviewDraftMutation.isPending
        ? (reviewDraftMutation.variables?.postId ?? null)
        : null,
    retryingPostId: retryMutation.isPending ? (retryMutation.variables ?? null) : null,
    isAddingSource: addSourceMutation.isPending,
    isRemovingSource: removeSourceMutation.isPending,
    isRefreshing: refreshMutation.isPending,
    refreshingSourceId: refreshSourceMutation.isPending
      ? (refreshSourceMutation.variables ?? null)
      : null,
    isSavingSettings: updateSettingsMutation.isPending,
    isSavingSource: updateSourceMutation.isPending || updateSourcesMutation.isPending,
    isApplyingPreset: sourcePresetMutation.isPending,
    schedulingPostId: scheduleMutation.isPending
      ? (scheduleMutation.variables?.postId ?? null)
      : null,
    cancelingPostId: cancelPostMutation.isPending ? (cancelPostMutation.variables ?? null) : null,
    publishingNowPostId: publishNowMutation.isPending
      ? (publishNowMutation.variables ?? null)
      : null,
    setSourceUrl,
    setDraftText,
    setPageOffset,
    submitSource,
    refreshSources: () => refreshMutation.mutate(),
    refreshSource: (sourceId: string) => refreshSourceMutation.mutate(sourceId),
    removeSource: (sourceId: string) => removeSourceMutation.mutate(sourceId),
    selectSource: setSelectedSourceId,
    selectStatusFilter: setStatusFilter,
    toggleHint,
    toggleSetting,
    updateSetting,
    updateSource,
    updateSources,
    toggleBulkSource,
    selectAllBulkSources,
    applySourcePreset: (preset: BulkUpdateVkParsingSourcesRequest['preset']) => {
      if (selectedBulkSourceIds.length > 0) {
        sourcePresetMutation.mutate({ sourceIds: selectedBulkSourceIds, preset });
      }
    },
    applyPresetToAllSources: (preset: BulkUpdateVkParsingSourcesRequest['preset']) => {
      const sourceIds = feedQuery.data?.sources.map((source) => source.id) ?? [];
      if (sourceIds.length > 0) {
        sourcePresetMutation.mutate({ sourceIds, preset });
      }
    },
    schedulePost: (postId: string, scheduledAt: string) =>
      scheduleMutation.mutate({ postId, scheduledAt }),
    cancelScheduledPost: (postId: string) => cancelPostMutation.mutate(postId),
    publishPostNow: (postId: string) => publishNowMutation.mutate(postId),
    startEditing,
    cancelEditing: () => setEditingPostId(null),
    publishEditingPost,
    retryPost: (postId: string) => retryMutation.mutate(postId),
    togglePhoto: (url: string) => {
      setSelectedVideoUrls([]);
      setSelectedPhotoUrls((current) => toggleValue(current, url));
    },
    toggleVideo: (url: string) => {
      setSelectedPhotoUrls([]);
      setSelectedVideoUrls((current) => (current.includes(url) ? [] : [url]));
    },
    toggleLink: (url: string) => setSelectedLinkUrls((current) => toggleValue(current, url)),
  };
}
