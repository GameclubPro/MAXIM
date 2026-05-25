import {
  Camera,
  CheckCircle,
  EditPencil,
  Filter,
  Flash,
  InfoCircleSolid,
  Link as IconoirLink,
  OpenNewWindow,
  PlusCircle,
  RefreshCircle,
  SendDiagonal,
  ShieldCheck,
  Trash,
  WarningCircle,
  Xmark,
} from 'iconoir-react';
import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UpdateVkParsingSettingsRequest, VkParsingPost } from '@maxim/contracts';
import {
  addVkParsingSource,
  getVkParsing,
  publishVkParsingPost,
  refreshVkParsing,
  removeVkParsingSource,
  updateVkParsingSettings,
  type VkParsingEntityType,
} from '../lib/api/vk-parsing-client';
import type { ApiTransport } from '../lib/api/transport';
import { cn } from '../lib/cn';
import { maxNotify } from '../lib/max-bridge';
import { queryKeys } from '../lib/query-keys';
import { MaxMarkdownPreview } from './max-markdown-preview';
import { SkeletonCard } from './ui/skeleton';
import { StatusState } from './ui/status-state';
import { useToast } from './ui/toast';
import '../styles/vk-parsing.css';

type VkParsingCardProps = {
  api: ApiTransport;
  chatId: string;
  active: boolean;
  entityType?: VkParsingEntityType;
};

type PublishPayload = {
  postId: string;
  text: string;
  photoUrls: string[];
  linkUrls: string[];
};

type VkParsingSettingKey = 'autoPublishEnabled' | 'stripLinksEnabled' | 'skipAdsEnabled';
type VkParsingHintKey = VkParsingSettingKey | 'source';

const VK_PARSING_SETTING_TOGGLES: Array<{
  key: VkParsingSettingKey;
  label: string;
  hint: string;
}> = [
  {
    key: 'autoPublishEnabled',
    label: 'Автопостинг',
    hint: 'Новые посты из подключенных источников выходят в чат или канал после очередного обновления.',
  },
  {
    key: 'stripLinksEnabled',
    label: 'Ссылки',
    hint: 'Перед публикацией ссылки удаляются из текста, а вложения-ссылки не прикладываются.',
  },
  {
    key: 'skipAdsEnabled',
    label: 'Реклама',
    hint: 'Посты с рекламной маркировкой или явными рекламными признаками остаются в ленте как пропущенные.',
  },
];

const SOURCE_HINT =
  'Подключайте публичные сообщества VK. Первичный импорт не автопубликует старые посты.';

function formatVkPostDate(value: string | null): string {
  if (!value) {
    return '';
  }

  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return '';
  }

  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function formatVkSourceRetry(value: string | null): string {
  if (!value) {
    return '';
  }

  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return '';
  }

  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function formatVkSourceSyncLabel(source: {
  syncStatus: string;
  nextSyncAt: string | null;
  lastError: string | null;
}): string | null {
  if (source.syncStatus === 'QUEUED') {
    return 'В очереди';
  }
  if (source.syncStatus === 'SYNCING') {
    return 'Обновляется';
  }
  if (source.syncStatus === 'BACKOFF') {
    const retryAt = formatVkSourceRetry(source.nextSyncAt);
    return retryAt ? `Повтор ${retryAt}` : 'Повтор позже';
  }
  if (source.syncStatus === 'ERROR' || source.lastError) {
    return 'Ошибка';
  }

  return null;
}

function normalizeApiError(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'Не удалось выполнить действие.';
  }

  const text = error.message.trim();
  if (text.startsWith('API request failed:')) {
    return text.replace(/^API request failed:\s*\d+\s*/u, '').trim() || 'Ошибка API.';
  }

  return text || 'Не удалось выполнить действие.';
}

function formatVkSkipReason(reason: VkParsingPost['skipReason']): string | null {
  if (reason === 'AD') {
    return 'Реклама';
  }
  if (reason === 'EMPTY_AFTER_LINK_FILTER') {
    return 'Только ссылки';
  }

  return null;
}

function formatVkPostStatus(post: VkParsingPost): string | null {
  if (post.status === 'PUBLISHED') {
    return post.autoPublishedAt ? 'Авто' : 'Опубликован';
  }
  if (post.status === 'CHANGED_AFTER_PUBLISH') {
    return 'Изменён';
  }
  if (post.status === 'UNAVAILABLE') {
    return 'Недоступен';
  }
  if (post.status === 'SKIPPED') {
    return formatVkSkipReason(post.skipReason) ?? 'Пропущен';
  }
  if (post.status === 'FAILED') {
    return 'Ошибка';
  }

  return null;
}

function toggleValue(values: string[], value: string): string[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

export function VkParsingCard({ api, chatId, active, entityType = 'channel' }: VkParsingCardProps) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [sourceUrl, setSourceUrl] = useState('');
  const [editingPostId, setEditingPostId] = useState<string | null>(null);
  const [draftText, setDraftText] = useState('');
  const [selectedPhotoUrls, setSelectedPhotoUrls] = useState<string[]>([]);
  const [selectedLinkUrls, setSelectedLinkUrls] = useState<string[]>([]);
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [openHintKey, setOpenHintKey] = useState<VkParsingHintKey | null>(null);

  const feedQuery = useQuery({
    queryKey: queryKeys.vkParsing(entityType, chatId),
    queryFn: () => getVkParsing(api, entityType, chatId),
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
      pushToast({ tone: 'info', title: 'Источник удалён' });
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Источник не удалён',
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
      queryClient.setQueryData(queryKeys.vkParsing(entityType, chatId), nextFeed);
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

  const feed = feedQuery.data;
  const settings = feed?.settings ?? {
    chatId,
    autoPublishEnabled: false,
    stripLinksEnabled: false,
    skipAdsEnabled: false,
    updatedAt: null,
  };
  const posts = feed?.posts ?? [];
  const sources = feed?.sources ?? [];
  const visiblePosts = useMemo(
    () => (selectedSourceId ? posts.filter((post) => post.sourceId === selectedSourceId) : posts),
    [posts, selectedSourceId],
  );
  const editingPost = useMemo(
    () => posts.find((post) => post.id === editingPostId) ?? null,
    [editingPostId, posts],
  );

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

  function renderSettingIcon(key: VkParsingSettingKey) {
    if (key === 'autoPublishEnabled') {
      return <Flash aria-hidden />;
    }
    if (key === 'stripLinksEnabled') {
      return <Filter aria-hidden />;
    }

    return <ShieldCheck aria-hidden />;
  }

  return (
    <div className="vk-parsing-card">
      <div className="vk-parsing-command">
        <form className="vk-parsing-card__source-form" onSubmit={submitSource}>
          <label className="vk-parsing-source-input">
            <span className="vk-parsing-sr-only">Источник VK</span>
            <input
              type="url"
              value={sourceUrl}
              onChange={(event) => setSourceUrl(event.target.value)}
              placeholder="vk.com/..."
              disabled={addSourceMutation.isPending}
            />
          </label>
          <button
            type="submit"
            className="vk-parsing-icon-button vk-parsing-icon-button--accent"
            aria-label="Добавить источник"
            title="Добавить источник"
            disabled={addSourceMutation.isPending || !sourceUrl.trim()}
          >
            <PlusCircle aria-hidden />
          </button>
        </form>

        <button
          type="button"
          className={cn('vk-parsing-icon-button', openHintKey === 'source' && 'is-active')}
          aria-label="О VK-источниках"
          aria-expanded={openHintKey === 'source'}
          aria-controls="vk-parsing-source-hint"
          title="О VK-источниках"
          onClick={() => toggleHint('source')}
        >
          <InfoCircleSolid aria-hidden />
        </button>

        <button
          type="button"
          className="vk-parsing-icon-button"
          aria-label="Обновить посты"
          title="Обновить посты"
          disabled={refreshMutation.isPending || sources.length === 0}
          onClick={() => refreshMutation.mutate()}
        >
          <RefreshCircle aria-hidden />
        </button>
        {openHintKey === 'source' ? (
          <div id="vk-parsing-source-hint" className="vk-parsing-hint-popover" role="status">
            {SOURCE_HINT}
          </div>
        ) : null}
      </div>

      {feed ? (
        <div className="vk-parsing-settings" aria-label="Настройки VK-парсинга">
          {VK_PARSING_SETTING_TOGGLES.map((item) => (
            <div
              key={item.key}
              className={cn('vk-parsing-setting-toggle', settings[item.key] && 'is-on')}
            >
              <div className="vk-parsing-setting-toggle__copy">
                <span className="vk-parsing-setting-toggle__icon">
                  {renderSettingIcon(item.key)}
                </span>
                <span>{item.label}</span>
                <button
                  type="button"
                  className={cn('vk-parsing-info-button', openHintKey === item.key && 'is-active')}
                  aria-label={`Подробнее: ${item.label}`}
                  aria-expanded={openHintKey === item.key}
                  aria-controls={`vk-parsing-setting-hint-${item.key}`}
                  title={`Подробнее: ${item.label}`}
                  onClick={() => toggleHint(item.key)}
                >
                  <InfoCircleSolid aria-hidden />
                </button>
              </div>
              <label className="settings-native-switch" aria-label={item.label}>
                <input
                  type="checkbox"
                  checked={settings[item.key]}
                  disabled={updateSettingsMutation.isPending}
                  onChange={(event) => toggleSetting(item.key, event.target.checked)}
                />
                <span className="toggle-switch" aria-hidden>
                  <span className="toggle-switch__thumb" />
                </span>
              </label>
              {openHintKey === item.key ? (
                <div
                  id={`vk-parsing-setting-hint-${item.key}`}
                  className="vk-parsing-hint-popover vk-parsing-hint-popover--setting"
                  role="status"
                >
                  {item.hint}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {sources.length > 0 ? (
        <div className="vk-parsing-card__sources" aria-label="VK источники">
          {sources.length > 1 ? (
            <span className={cn('vk-parsing-source-chip', !selectedSourceId && 'is-selected')}>
              <button
                type="button"
                className="vk-parsing-source-chip__select vk-parsing-source-chip__select--all"
                aria-pressed={!selectedSourceId}
                onClick={() => setSelectedSourceId(null)}
              >
                Все
              </button>
            </span>
          ) : null}
          {sources.map((source) => {
            const syncLabel = formatVkSourceSyncLabel(source);
            return (
              <span
                key={source.id}
                className={cn(
                  'vk-parsing-source-chip',
                  selectedSourceId === source.id && 'is-selected',
                  source.syncStatus === 'SYNCING' && 'is-syncing',
                  source.syncStatus === 'ERROR' && 'has-error',
                  source.syncStatus === 'BACKOFF' && 'has-error',
                )}
              >
                <button
                  type="button"
                  className="vk-parsing-source-chip__select"
                  aria-pressed={selectedSourceId === source.id}
                  title={source.title}
                  onClick={() => setSelectedSourceId(source.id)}
                >
                  <span>{source.title}</span>
                </button>
                {syncLabel ? (
                  <small title={source.lastError ?? undefined}>{syncLabel}</small>
                ) : null}
                <button
                  type="button"
                  className="vk-parsing-source-chip__remove"
                  aria-label={`Удалить ${source.title}`}
                  title="Удалить источник"
                  disabled={removeSourceMutation.isPending}
                  onClick={() => removeSourceMutation.mutate(source.id)}
                >
                  <Trash aria-hidden />
                </button>
              </span>
            );
          })}
        </div>
      ) : null}

      {feedQuery.isLoading ? <SkeletonCard lines={5} /> : null}

      {feedQuery.error ? (
        <StatusState
          tone="danger"
          title="Не удалось загрузить VK-посты"
          description={normalizeApiError(feedQuery.error)}
          action={
            <button
              type="button"
              className="button button--danger"
              onClick={() => void feedQuery.refetch()}
            >
              Повторить
            </button>
          }
        />
      ) : null}

      {!feedQuery.isLoading && !feedQuery.error && visiblePosts.length === 0 ? (
        <div className="vk-parsing-card__empty">Постов пока нет</div>
      ) : null}

      {visiblePosts.length > 0 ? (
        <div className="vk-parsing-post-list">
          {visiblePosts.map((post) => {
            const isEditing = editingPostId === post.id;
            const isPublishing =
              publishMutation.isPending && publishMutation.variables?.postId === post.id;
            const dateLabel = formatVkPostDate(post.vkPublishedAt);
            const statusLabel = formatVkPostStatus(post);
            const photoCount = post.photoUrls.length;
            const linkCount = post.linkUrls.length;
            return (
              <article
                key={post.id}
                className={cn(
                  'vk-parsing-post-card',
                  `vk-parsing-post-card--${post.status.toLowerCase().replace(/_/gu, '-')}`,
                  isEditing && 'is-editing',
                )}
              >
                <div className="vk-parsing-post-card__head">
                  <div className="vk-parsing-post-card__source">
                    <strong>{post.sourceTitle}</strong>
                    <span>{dateLabel || 'VK'}</span>
                  </div>
                  <a
                    className="vk-parsing-post-card__vk-link"
                    href={post.url}
                    target="_blank"
                    rel="noreferrer"
                    aria-label="Открыть пост VK"
                    title="Открыть пост VK"
                  >
                    <OpenNewWindow aria-hidden />
                  </a>
                </div>

                {isEditing ? (
                  <div className="vk-parsing-editor">
                    <label className="field vk-parsing-editor__text">
                      <span>Текст</span>
                      <textarea
                        rows={7}
                        value={draftText}
                        onChange={(event) => setDraftText(event.target.value)}
                        disabled={isPublishing}
                        maxLength={2000}
                      />
                    </label>

                    {post.photoUrls.length > 0 ? (
                      <div className="vk-parsing-editor__media">
                        {post.photoUrls.map((url, index) => {
                          const checked = selectedPhotoUrls.includes(url);
                          return (
                            <button
                              type="button"
                              key={url}
                              className={cn('vk-parsing-photo-choice', checked && 'is-selected')}
                              aria-pressed={checked}
                              aria-label={`Фото ${index + 1}`}
                              disabled={isPublishing}
                              onClick={() =>
                                setSelectedPhotoUrls((current) => toggleValue(current, url))
                              }
                            >
                              <img src={url} alt="" loading="lazy" />
                              <Camera aria-hidden />
                            </button>
                          );
                        })}
                      </div>
                    ) : null}

                    {post.linkUrls.length > 0 && !settings.stripLinksEnabled ? (
                      <div className="vk-parsing-editor__links">
                        {post.linkUrls.map((url) => {
                          const checked = selectedLinkUrls.includes(url);
                          return (
                            <label key={url} className="vk-parsing-link-choice">
                              <input
                                type="checkbox"
                                checked={checked}
                                disabled={isPublishing}
                                onChange={() =>
                                  setSelectedLinkUrls((current) => toggleValue(current, url))
                                }
                              />
                              <IconoirLink aria-hidden />
                              <span>{url}</span>
                            </label>
                          );
                        })}
                      </div>
                    ) : null}

                    <div className="vk-parsing-post-card__actions">
                      <button
                        type="button"
                        className="button button--ghost"
                        disabled={isPublishing}
                        onClick={() => setEditingPostId(null)}
                      >
                        <Xmark aria-hidden />
                        Отмена
                      </button>
                      <button
                        type="button"
                        className="button button--accent"
                        disabled={isPublishing}
                        onClick={publishEditingPost}
                      >
                        <SendDiagonal aria-hidden />
                        {isPublishing ? 'Публикуем...' : 'Опубликовать'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <MaxMarkdownPreview
                      value={post.text}
                      className="vk-parsing-post-card__text max-markdown-preview--clamp-3"
                      normalizeWhitespace
                      fallback={post.photoUrls.length > 0 ? 'Фото без текста' : 'Без текста'}
                    />

                    {post.photoUrls.length > 0 ? (
                      <div className="vk-parsing-post-card__photos">
                        {post.photoUrls.slice(0, 4).map((url) => (
                          <img key={url} src={url} alt="" loading="lazy" />
                        ))}
                      </div>
                    ) : null}

                    <div className="vk-parsing-post-card__facts">
                      {photoCount > 0 ? (
                        <span>
                          <Camera aria-hidden />
                          {photoCount}
                        </span>
                      ) : null}
                      {linkCount > 0 ? (
                        <span>
                          <IconoirLink aria-hidden />
                          {linkCount}
                        </span>
                      ) : null}
                      {statusLabel ? (
                        <span
                          className={cn(
                            'vk-parsing-status-pill',
                            post.status === 'PUBLISHED' && 'is-success',
                            post.status === 'FAILED' && 'is-danger',
                            post.status === 'SKIPPED' && 'is-muted',
                            post.status === 'CHANGED_AFTER_PUBLISH' && 'is-warning',
                          )}
                          title={post.autoPublishError ?? post.lastError ?? undefined}
                        >
                          {post.status === 'FAILED' ? <WarningCircle aria-hidden /> : null}
                          {post.status === 'PUBLISHED' ? <CheckCircle aria-hidden /> : null}
                          {post.status === 'SKIPPED' ? <ShieldCheck aria-hidden /> : null}
                          {post.status === 'CHANGED_AFTER_PUBLISH' ? (
                            <RefreshCircle aria-hidden />
                          ) : null}
                          {statusLabel}
                        </span>
                      ) : null}
                    </div>

                    <div className="vk-parsing-post-card__actions">
                      {post.status === 'PUBLISHED' ? (
                        post.publishedUrl ? (
                          <a
                            className="button button--ghost vk-parsing-action-button"
                            href={post.publishedUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            <OpenNewWindow aria-hidden />
                            MAX
                          </a>
                        ) : null
                      ) : post.status === 'UNAVAILABLE' ? (
                        <button
                          type="button"
                          className="button button--ghost vk-parsing-action-button"
                          disabled
                        >
                          Недоступен
                        </button>
                      ) : post.status === 'SKIPPED' ? (
                        <button
                          type="button"
                          className="button button--ghost vk-parsing-action-button"
                          disabled
                        >
                          Пропущен
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="button button--accent vk-parsing-action-button"
                          onClick={() => startEditing(post)}
                        >
                          <EditPencil aria-hidden />
                          Редактировать
                        </button>
                      )}
                    </div>
                  </>
                )}
              </article>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
