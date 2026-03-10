import type { ChannelDialogType } from '@maxim/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { StatusState } from '../components/ui/status-state';
import { useToast } from '../components/ui/toast';
import { cn } from '../lib/cn';
import type { ApiClient } from '../lib/api-client';
import { readChatTitle } from '../lib/chat-titles';
import { buildManagedEntitiesRoute } from '../lib/last-chat';

function normalizeApiError(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'Не удалось отправить сообщение.';
  }

  const normalized = error.message.trim();
  if (!normalized) {
    return 'Не удалось отправить сообщение.';
  }

  if (normalized.startsWith('API request failed:')) {
    const details = normalized.replace(/^API request failed:\s*\d+\s*/u, '').trim();
    return details || 'Не удалось отправить сообщение.';
  }

  return normalized;
}

function resolveDialogType(mode: string | undefined): ChannelDialogType {
  return mode === 'suggest' ? 'suggest' : 'comments';
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString('ru-RU', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function buildAuthorBadge(value: string | null | undefined): string {
  const normalized = value?.trim() ?? '';
  if (!normalized) {
    return 'MX';
  }

  const words = normalized
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/u)
    .filter(Boolean);

  if (words.length >= 2) {
    return `${words[0]?.[0] ?? ''}${words[1]?.[0] ?? ''}`.toUpperCase();
  }

  return normalized.slice(0, 2).toUpperCase();
}

type DialogViewModel = {
  title: string;
  placeholder: string;
};

function buildViewModel(dialogType: ChannelDialogType): DialogViewModel {
  if (dialogType === 'suggest') {
    return {
      title: 'Предложить новость',
      placeholder: 'Напишите идею поста',
    };
  }

  return {
    title: 'Комментарии',
    placeholder: 'Напишите комментарий',
  };
}

export function ChannelDialogPage({ api }: { api: ApiClient }) {
  const { chatId = '', mode } = useParams();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token')?.trim() ?? '';
  const dialogType = resolveDialogType(mode);
  const [draft, setDraft] = useState('');
  const scrollViewportRef = useRef<HTMLElement | null>(null);
  const lastMessageIdRef = useRef<string | null>(null);
  const queryClient = useQueryClient();
  const { pushToast } = useToast();

  const chatTitle = useMemo(() => readChatTitle(chatId), [chatId]);
  const view = useMemo(() => buildViewModel(dialogType), [dialogType]);
  const showTopbar = dialogType !== 'comments';
  const meQuery = useQuery({
    queryKey: ['me'],
    queryFn: () => api.getMe(),
  });

  const dialogQuery = useQuery({
    queryKey: ['channel-dialog', chatId, dialogType, token],
    queryFn: () => api.getChannelDialog(chatId, dialogType, token),
    enabled: Boolean(chatId && token),
    refetchInterval: dialogType === 'comments' ? 8_000 : false,
  });

  const messages = dialogQuery.data?.messages ?? [];

  useEffect(() => {
    const viewport = scrollViewportRef.current;
    const lastMessageId = messages[messages.length - 1]?.id ?? null;
    if (!viewport || !lastMessageId) {
      lastMessageIdRef.current = lastMessageId;
      return;
    }

    const previousMessageId = lastMessageIdRef.current;
    const distanceToBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    const shouldStickToBottom = previousMessageId === null || distanceToBottom < 160;

    if (previousMessageId !== lastMessageId && shouldStickToBottom) {
      requestAnimationFrame(() => {
        viewport.scrollTo({
          top: viewport.scrollHeight,
          behavior: previousMessageId ? 'smooth' : 'auto',
        });
      });
    }

    lastMessageIdRef.current = lastMessageId;
  }, [messages]);

  const sendMutation = useMutation({
    mutationFn: (text: string) =>
      api.createChannelDialogMessage(chatId, dialogType, {
        token,
        text,
      }),
    onSuccess: (result) => {
      pushToast({
        tone: result.message.delivered === false ? 'info' : 'success',
        title: 'Готово',
        description:
          dialogType === 'suggest'
            ? result.message.delivered
              ? 'Идея отправлена админу.'
              : 'Идея сохранена.'
            : 'Комментарий отправлен.',
      });
      setDraft('');
      void queryClient.invalidateQueries({
        queryKey: ['channel-dialog', chatId, dialogType, token],
      });
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Ошибка',
        description: normalizeApiError(error),
      });
    },
  });

  const onSubmit = () => {
    const text = draft.trim();
    if (!text || sendMutation.isPending || !chatId || !token) {
      return;
    }

    sendMutation.mutate(text);
  };

  if (!chatId) {
    return (
      <div className="page-stack page-enter">
        <div className="glass-card glass-card--md">
          <StatusState
            tone="warning"
            title="Канал не найден"
            description="Откройте диалог заново из сообщения канала."
            action={
              <Link to={buildManagedEntitiesRoute('channel')} className="button button--accent">
                К списку
              </Link>
            }
          />
        </div>
      </div>
    );
  }

  if (!token) {
    return (
      <div className="page-stack page-enter">
        <div className="glass-card glass-card--md">
          <StatusState
            tone="warning"
            title="Кнопка устарела"
            description="Откройте сообщение в канале и нажмите кнопку ещё раз."
            action={
              <Link to={buildManagedEntitiesRoute('channel')} className="button button--accent">
                К списку
              </Link>
            }
          />
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn('channel-dialog-screen', `channel-dialog-screen--${dialogType}`, 'page-enter')}
    >
      <div className="channel-dialog-screen__backdrop" aria-hidden />

      <div className={cn('channel-dialog-shell', !showTopbar && 'channel-dialog-shell--no-topbar')}>
        {showTopbar ? (
          <header className="channel-dialog-topbar">
            <div className="channel-dialog-topbar__title">
              <h1>{view.title}</h1>
              <span>{chatTitle || chatId}</span>
            </div>
            <Link to={buildManagedEntitiesRoute('channel')} className="channel-dialog-close">
              Закрыть
            </Link>
          </header>
        ) : null}

        <section ref={scrollViewportRef} className="channel-dialog-body">
          {dialogQuery.isLoading ? (
            <div className="channel-dialog-skeletons" aria-label="Загрузка">
              {Array.from({ length: 3 }, (_, index) => (
                <div key={index} className="channel-dialog-skeleton">
                  <span className="channel-dialog-skeleton__avatar" />
                  <div className="channel-dialog-skeleton__body">
                    <span className="channel-dialog-skeleton__line is-short" />
                    <span className="channel-dialog-skeleton__line" />
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          {dialogQuery.error ? (
            <div className="channel-dialog-error">
              <StatusState
                tone="danger"
                title="Не удалось загрузить"
                description={normalizeApiError(dialogQuery.error)}
                action={
                  <button
                    type="button"
                    className="button button--danger"
                    onClick={() => void dialogQuery.refetch()}
                  >
                    Повторить
                  </button>
                }
              />
            </div>
          ) : null}

          {!dialogQuery.isLoading && !dialogQuery.error ? (
            messages.length ? (
              <div className="channel-dialog-message-list">
                {messages.map((message) => {
                  const isOwnMessage = meQuery.data?.userId === message.authorUserId;
                  return (
                    <article
                      key={message.id}
                      className={cn('channel-dialog-message', isOwnMessage && 'is-own')}
                    >
                      <div className="channel-dialog-message__avatar">
                        {buildAuthorBadge(message.authorDisplayName || message.authorUserId)}
                      </div>
                      <div className="channel-dialog-message__bubble">
                        <div className="channel-dialog-message__meta">
                          <strong>
                            {message.authorDisplayName || `Участник ${message.authorUserId}`}
                          </strong>
                          <span>{formatDateTime(message.createdAt)}</span>
                        </div>
                        <p>{message.text}</p>
                        {dialogType === 'suggest' ? (
                          <div className="channel-dialog-message__footer">
                            <span
                              className={cn(
                                'channel-dialog-delivery',
                                message.delivered ? 'is-delivered' : 'is-pending',
                              )}
                            >
                              {message.delivered ? 'доставлено' : 'в очереди'}
                            </span>
                          </div>
                        ) : null}
                      </div>
                    </article>
                  );
                })}
              </div>
            ) : (
              <div className="channel-dialog-empty">Пока пусто</div>
            )
          ) : null}
        </section>

        <section className="channel-dialog-compose">
          <div className="channel-dialog-compose__surface">
            <label className="channel-dialog-compose__field">
              <textarea
                rows={1}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder={view.placeholder}
                maxLength={2_000}
              />
            </label>

            <div className="channel-dialog-compose__actions">
              <button
                type="button"
                className="channel-dialog-submit"
                onClick={onSubmit}
                disabled={!draft.trim() || sendMutation.isPending}
              >
                {sendMutation.isPending ? '...' : 'Отправить'}
              </button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
