import type { ChannelDialogMessage, ChannelDialogType } from '@maxim/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { StatusState } from '../components/ui/status-state';
import { useToast } from '../components/ui/toast';
import { BackChevronIcon } from '../components/ui/entity-header-icons';
import {
  createChatDialogMessage,
  createChannelDialogMessage,
  getChatDialog,
  getChannelDialog,
} from '../lib/api/channel-dialog-client';
import { getMe } from '../lib/api/root-client';
import { maxImpact } from '../lib/max-bridge';
import type { ApiTransport } from '../lib/api/transport';
import { cn } from '../lib/cn';
import { readChatTitle } from '../lib/chat-titles';
import { buildManagedEntitiesRoute, saveLastEntityId, type LastEntityType } from '../lib/last-chat';

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

function formatMessageTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleTimeString('ru-RU', {
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

function DialogAvatar({
  avatarUrl,
  label,
}: {
  avatarUrl: string | null | undefined;
  label: string | null | undefined;
}) {
  const [imageBroken, setImageBroken] = useState(false);
  const resolvedAvatarUrl = avatarUrl?.trim() ?? '';
  const showImage = resolvedAvatarUrl.length > 0 && !imageBroken;

  return (
    <div className={cn('channel-dialog-message__avatar', showImage && 'has-image')}>
      {showImage ? (
        <img src={resolvedAvatarUrl} alt="" loading="lazy" onError={() => setImageBroken(true)} />
      ) : (
        buildAuthorBadge(label)
      )}
    </div>
  );
}

function SendArrowIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden focusable="false">
      <path
        d="M4.5 10H15.5"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M10.8 5.3L15.5 10L10.8 14.7"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

type DialogViewModel = {
  title: string;
  placeholder: string;
};

function buildViewModel(dialogType: ChannelDialogType): DialogViewModel {
  if (dialogType === 'suggest') {
    return {
      title: 'Предложить новость',
      placeholder: 'Идея поста',
    };
  }

  return {
    title: 'Комментарии',
    placeholder: 'Комментарий',
  };
}

function resolveDialogEntityType(pathname: string): LastEntityType {
  return pathname.includes('/channel/') ? 'channel' : 'chat';
}

function formatDialogDayKey(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function formatDialogDayLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  const today = new Date();
  const currentDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const targetDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.round((currentDay.getTime() - targetDay.getTime()) / 86_400_000);

  if (diffDays === 0) {
    return 'Сегодня';
  }

  if (diffDays === 1) {
    return 'Вчера';
  }

  return date.toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'long',
  });
}

type DialogTimelineEntry =
  | {
      kind: 'day';
      key: string;
      label: string;
    }
  | {
      kind: 'message';
      key: string;
      message: ChannelDialogMessage;
      isOwnMessage: boolean;
      isAdminMessage: boolean;
    };

function buildDialogTimeline(
  messages: ChannelDialogMessage[],
  currentUserId: string | null | undefined,
): DialogTimelineEntry[] {
  const entries: DialogTimelineEntry[] = [];
  let previousDayKey: string | null = null;

  for (const message of messages) {
    const dayKey = formatDialogDayKey(message.createdAt);
    if (dayKey !== previousDayKey) {
      entries.push({
        kind: 'day',
        key: `day-${dayKey}`,
        label: formatDialogDayLabel(message.createdAt),
      });
      previousDayKey = dayKey;
    }

    entries.push({
      kind: 'message',
      key: message.id,
      message,
      isOwnMessage: currentUserId === message.authorUserId,
      isAdminMessage: message.authorRole === 'admin',
    });
  }

  return entries;
}

function resolveDialogAuthorName(message: ChannelDialogMessage, isOwnMessage: boolean): string {
  if (isOwnMessage) {
    return 'Вы';
  }

  return message.authorDisplayName || `Участник ${message.authorUserId}`;
}

export function ChannelDialogPage({ api }: { api: ApiTransport }) {
  const { chatId = '', mode } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token')?.trim() ?? '';
  const dialogType = resolveDialogType(mode);
  const entityType = resolveDialogEntityType(location.pathname);
  const showClassicTopbar = dialogType !== 'comments';
  const showCommentsHeader = dialogType === 'comments';
  const [draft, setDraft] = useState('');
  const composeFieldRef = useRef<HTMLTextAreaElement | null>(null);
  const scrollViewportRef = useRef<HTMLElement | null>(null);
  const lastMessageIdRef = useRef<string | null>(null);
  const queryClient = useQueryClient();
  const { pushToast } = useToast();

  const chatTitle = useMemo(() => readChatTitle(chatId), [chatId]);
  const view = useMemo(() => buildViewModel(dialogType), [dialogType]);
  const meQuery = useQuery({
    queryKey: ['me'],
    queryFn: () => getMe(api),
  });

  useEffect(() => {
    if (chatId) {
      saveLastEntityId(entityType, chatId);
    }
  }, [chatId, entityType]);

  const dialogQuery = useQuery({
    queryKey: ['entity-dialog', entityType, chatId, dialogType, token],
    queryFn: () =>
      entityType === 'channel'
        ? getChannelDialog(api, chatId, dialogType, token)
        : getChatDialog(api, chatId, dialogType, token),
    enabled: Boolean(chatId && token),
    refetchInterval: dialogType === 'comments' ? 8_000 : false,
  });

  const messages = dialogQuery.data?.messages ?? [];
  const introText = dialogQuery.data?.introText?.trim() ?? '';
  const draftLength = draft.trim().length;
  const showComposeMeta = dialogType === 'suggest';
  const timelineEntries = useMemo(
    () => buildDialogTimeline(messages, meQuery.data?.userId),
    [messages, meQuery.data?.userId],
  );

  const handleDismiss = () => {
    maxImpact('light');
    navigate(buildManagedEntitiesRoute(entityType), { replace: true });
  };

  useEffect(() => {
    const field = composeFieldRef.current;
    if (!field) {
      return;
    }

    field.style.height = '0px';
    const nextHeight = Math.max(46, Math.min(field.scrollHeight, 132));
    field.style.height = `${nextHeight}px`;
  }, [draft]);

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
      entityType === 'channel'
        ? createChannelDialogMessage(api, chatId, dialogType, {
            token,
            text,
          })
        : createChatDialogMessage(api, chatId, dialogType, {
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
        queryKey: ['entity-dialog', entityType, chatId, dialogType, token],
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
            title={entityType === 'channel' ? 'Канал не найден' : 'Чат не найден'}
            description="Откройте диалог заново из сообщения."
            action={
              <Link to={buildManagedEntitiesRoute(entityType)} className="button button--accent">
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
            description="Откройте сообщение и нажмите кнопку ещё раз."
            action={
              <Link to={buildManagedEntitiesRoute(entityType)} className="button button--accent">
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

      <div
        className={cn(
          'channel-dialog-shell',
          !showClassicTopbar && !showCommentsHeader && 'channel-dialog-shell--flat',
        )}
      >
        {showClassicTopbar ? (
          <header className="channel-dialog-topbar">
            <button
              type="button"
              className="channel-dialog-nav"
              onClick={handleDismiss}
              aria-label="Назад"
            >
              <BackChevronIcon />
            </button>

            <div className="channel-dialog-topbar__title">
              <h1>{view.title}</h1>
              <span>{chatTitle || chatId}</span>
            </div>

            <button type="button" className="channel-dialog-close" onClick={handleDismiss}>
              Закрыть
            </button>
          </header>
        ) : null}

        {showCommentsHeader ? (
          <header className="channel-dialog-comments-head">
            <div className="channel-dialog-comments-head__bar">
              <button
                type="button"
                className="channel-dialog-nav"
                onClick={handleDismiss}
                aria-label="Назад"
              >
                <BackChevronIcon />
              </button>

              <div className="channel-dialog-comments-head__title">
                <h1>{view.title}</h1>
              </div>

              <span className="channel-dialog-comments-head__spacer" aria-hidden />
            </div>
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
            <div className="channel-dialog-message-list">
              {dialogType === 'suggest' && introText ? (
                <div className="channel-dialog-intro">
                  <p>{introText}</p>
                </div>
              ) : null}

              {timelineEntries.length ? (
                timelineEntries.map((entry) => {
                  if (entry.kind === 'day') {
                    return (
                      <div key={entry.key} className="channel-dialog-day-divider">
                        <span>{entry.label}</span>
                      </div>
                    );
                  }

                  const { message, isOwnMessage, isAdminMessage } = entry;
                  const reactions = message.reactions ?? [];

                  return (
                    <article
                      key={entry.key}
                      className={cn(
                        'channel-dialog-message',
                        isOwnMessage && 'is-own',
                        isAdminMessage && 'is-admin',
                      )}
                    >
                      <DialogAvatar
                        avatarUrl={message.avatarUrl}
                        label={message.authorDisplayName || message.authorUserId}
                      />

                      <div className="channel-dialog-message__stack">
                        <div className="channel-dialog-message__bubble">
                          <div className="channel-dialog-message__meta">
                            <div className="channel-dialog-message__author">
                              <strong>{resolveDialogAuthorName(message, isOwnMessage)}</strong>
                              {isAdminMessage ? (
                                <span className="channel-dialog-message__role">админ</span>
                              ) : null}
                            </div>
                            <time dateTime={message.createdAt}>
                              {formatMessageTime(message.createdAt)}
                            </time>
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

                        {reactions.length > 0 ? (
                          <div className="channel-dialog-message__reactions">
                            {reactions.map((reaction) => (
                              <span
                                key={`${message.id}-${reaction.emoji}`}
                                className={cn(
                                  'channel-dialog-message__reaction',
                                  reaction.active && 'is-active',
                                )}
                              >
                                <b>{reaction.emoji}</b>
                                <small>{reaction.count}</small>
                              </span>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    </article>
                  );
                })
              ) : (
                <div className="channel-dialog-empty">Пока пусто</div>
              )}
            </div>
          ) : null}
        </section>

        <section className="channel-dialog-compose">
          <div className="channel-dialog-compose__surface">
            {showComposeMeta ? (
              <div className="channel-dialog-compose__meta">
                <span>Только для админов</span>
                <span>{draftLength}/2000</span>
              </div>
            ) : null}

            <div className="channel-dialog-compose__row">
              <label className="channel-dialog-compose__field">
                <textarea
                  ref={composeFieldRef}
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
                  aria-label={sendMutation.isPending ? 'Отправка' : 'Отправить'}
                >
                  {sendMutation.isPending ? (
                    <span className="channel-dialog-submit__loader" aria-hidden />
                  ) : (
                    <SendArrowIcon />
                  )}
                </button>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
