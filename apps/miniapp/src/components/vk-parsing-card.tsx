import {
  Camera,
  EditPencil,
  Link as IconoirLink,
  PlusCircle,
  RefreshCircle,
  SendDiagonal,
  Xmark,
} from 'iconoir-react';
import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { VkParsingPost } from '@maxim/contracts';
import {
  addChannelVkParsingSource,
  getChannelVkParsing,
  publishChannelVkParsingPost,
  refreshChannelVkParsing,
  removeChannelVkParsingSource,
} from '../lib/api/channel-settings-client';
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
};

type PublishPayload = {
  postId: string;
  text: string;
  photoUrls: string[];
  linkUrls: string[];
};

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

function toggleValue(values: string[], value: string): string[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

export function VkParsingCard({ api, chatId, active }: VkParsingCardProps) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [sourceUrl, setSourceUrl] = useState('');
  const [editingPostId, setEditingPostId] = useState<string | null>(null);
  const [draftText, setDraftText] = useState('');
  const [selectedPhotoUrls, setSelectedPhotoUrls] = useState<string[]>([]);
  const [selectedLinkUrls, setSelectedLinkUrls] = useState<string[]>([]);

  const feedQuery = useQuery({
    queryKey: queryKeys.channelVkParsing(chatId),
    queryFn: () => getChannelVkParsing(api, chatId),
    enabled: Boolean(chatId) && active,
    staleTime: 30_000,
    refetchInterval: active ? 600_000 : false,
    refetchOnWindowFocus: false,
  });

  const addSourceMutation = useMutation({
    mutationFn: (url: string) => addChannelVkParsingSource(api, chatId, url),
    onSuccess: () => {
      setSourceUrl('');
      void queryClient.invalidateQueries({ queryKey: queryKeys.channelVkParsing(chatId) });
      pushToast({ tone: 'success', title: 'Источник добавлен' });
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
    mutationFn: (sourceId: string) => removeChannelVkParsingSource(api, chatId, sourceId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.channelVkParsing(chatId) });
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
    mutationFn: () => refreshChannelVkParsing(api, chatId),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.channelVkParsing(chatId) });
      pushToast({
        tone: result.imported > 0 ? 'success' : 'info',
        title: result.imported > 0 ? 'Посты обновлены' : 'Новых постов нет',
      });
      maxNotify(result.imported > 0 ? 'success' : 'warning');
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

  const publishMutation = useMutation({
    mutationFn: (payload: PublishPayload) =>
      publishChannelVkParsingPost(api, chatId, payload.postId, {
        text: payload.text,
        photoUrls: payload.photoUrls,
        linkUrls: payload.linkUrls,
      }),
    onSuccess: () => {
      setEditingPostId(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.channelVkParsing(chatId) });
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
  const posts = feed?.posts ?? [];
  const sources = feed?.sources ?? [];
  const editingPost = useMemo(
    () => posts.find((post) => post.id === editingPostId) ?? null,
    [editingPostId, posts],
  );

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
    setSelectedLinkUrls(post.linkUrls);
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

  return (
    <div className="vk-parsing-card">
      <div className="vk-parsing-card__toolbar">
        <form className="vk-parsing-card__source-form" onSubmit={submitSource}>
          <label className="field vk-parsing-card__source-field">
            <span>Источник</span>
            <input
              type="url"
              value={sourceUrl}
              onChange={(event) => setSourceUrl(event.target.value)}
              placeholder="https://vk.ru/..."
              disabled={addSourceMutation.isPending}
            />
          </label>
          <button
            type="submit"
            className="button button--accent vk-parsing-card__icon-button"
            aria-label="Добавить источник"
            title="Добавить источник"
            disabled={addSourceMutation.isPending || !sourceUrl.trim()}
          >
            <PlusCircle aria-hidden />
          </button>
        </form>

        <button
          type="button"
          className="button button--ghost vk-parsing-card__icon-button"
          aria-label="Обновить посты"
          title="Обновить посты"
          disabled={refreshMutation.isPending || sources.length === 0}
          onClick={() => refreshMutation.mutate()}
        >
          <RefreshCircle aria-hidden />
        </button>
      </div>

      {sources.length > 0 ? (
        <div className="vk-parsing-card__sources" aria-label="VK источники">
          {sources.map((source) => (
            <span key={source.id} className="vk-parsing-source-chip">
              <a href={source.url} target="_blank" rel="noreferrer">
                {source.title}
              </a>
              {source.lastError ? <small title={source.lastError}>Ошибка</small> : null}
              <button
                type="button"
                aria-label={`Удалить ${source.title}`}
                title="Удалить источник"
                disabled={removeSourceMutation.isPending}
                onClick={() => removeSourceMutation.mutate(source.id)}
              >
                <Xmark aria-hidden />
              </button>
            </span>
          ))}
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

      {!feedQuery.isLoading && !feedQuery.error && posts.length === 0 ? (
        <div className="vk-parsing-card__empty">Постов пока нет</div>
      ) : null}

      {posts.length > 0 ? (
        <div className="vk-parsing-post-list">
          {posts.map((post) => {
            const isEditing = editingPostId === post.id;
            const isPublishing =
              publishMutation.isPending && publishMutation.variables?.postId === post.id;
            const dateLabel = formatVkPostDate(post.vkPublishedAt);
            return (
              <article
                key={post.id}
                className={cn('vk-parsing-post-card', isEditing && 'is-editing')}
              >
                <div className="vk-parsing-post-card__head">
                  <div>
                    <strong>{post.sourceTitle}</strong>
                    <span>{dateLabel || 'VK'}</span>
                  </div>
                  <a href={post.url} target="_blank" rel="noreferrer">
                    VK
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

                    {post.linkUrls.length > 0 ? (
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
                      {post.photoUrls.length > 0 ? <span>{post.photoUrls.length} фото</span> : null}
                      {post.linkUrls.length > 0 ? <span>{post.linkUrls.length} ссыл.</span> : null}
                      {post.status === 'PUBLISHED' ? <span>Опубликован</span> : null}
                      {post.status === 'FAILED' ? <span>Ошибка</span> : null}
                    </div>

                    <div className="vk-parsing-post-card__actions">
                      {post.status === 'PUBLISHED' ? (
                        post.publishedUrl ? (
                          <a
                            className="button button--ghost"
                            href={post.publishedUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Открыть
                          </a>
                        ) : null
                      ) : (
                        <button
                          type="button"
                          className="button button--accent"
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
