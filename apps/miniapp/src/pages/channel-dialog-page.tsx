import type {
  ChannelDialogMessage,
  ChannelDialogResponse,
  ChannelDialogType,
} from '@maxim/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { StatusState } from '../components/ui/status-state';
import { useToast } from '../components/ui/toast';
import {
  createChatDialogMessage,
  createChannelDialogMessage,
  getChatDialog,
  getChannelDialog,
  toggleChannelDialogReaction,
  toggleChatDialogReaction,
} from '../lib/api/channel-dialog-client';
import { getMe } from '../lib/api/root-client';
import type { ApiTransport } from '../lib/api/transport';
import { cn } from '../lib/cn';
import { readChatTitle } from '../lib/chat-titles';
import { buildManagedEntitiesRoute, saveLastEntityId, type LastEntityType } from '../lib/last-chat';
import { maxImpact } from '../lib/max-bridge';

const COMMENT_REACTION_OPTIONS = [
  '👍',
  '❤️',
  '😂',
  '😮',
  '😢',
  '😡',
  '🔥',
  '👏',
  '😍',
  '🎉',
  '💯',
  '👀',
  '🤝',
  '🤔',
  '👌',
  '✅',
] as const;

const COMMENT_REACTION_PRIMARY_OPTIONS = COMMENT_REACTION_OPTIONS.slice(0, 6);
const COMMENT_REACTION_EXPANDED_OPTIONS = COMMENT_REACTION_OPTIONS.slice(6);

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

function getAuthorLabel(message: ChannelDialogMessage): string {
  return message.authorDisplayName || `Участник ${message.authorUserId}`;
}

function summarizeReplyText(value: string, maxLength = 96): string {
  const normalized = value.replace(/\s+/gu, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function isGroupedWithPrevious(messages: ChannelDialogMessage[], index: number): boolean {
  const current = messages[index];
  const previous = messages[index - 1];
  if (!current || !previous) {
    return false;
  }

  if (current.authorUserId !== previous.authorUserId) {
    return false;
  }

  const currentTime = new Date(current.createdAt).getTime();
  const previousTime = new Date(previous.createdAt).getTime();
  if (!Number.isFinite(currentTime) || !Number.isFinite(previousTime)) {
    return true;
  }

  return currentTime - previousTime < 12 * 60 * 1_000;
}

function mergeDialogMessage(
  current: ChannelDialogMessage,
  next: ChannelDialogMessage,
): ChannelDialogMessage {
  return {
    ...current,
    ...next,
    avatarUrl: next.avatarUrl ?? current.avatarUrl ?? null,
  };
}

function updateDialogMessage(
  dialog: ChannelDialogResponse | undefined,
  message: ChannelDialogMessage,
): ChannelDialogResponse | undefined {
  if (!dialog) {
    return dialog;
  }

  const existingIndex = dialog.messages.findIndex((item) => item.id === message.id);
  if (existingIndex < 0) {
    return {
      ...dialog,
      messages: [...dialog.messages, message],
    };
  }

  return {
    ...dialog,
    messages: dialog.messages.map((item) =>
      item.id === message.id ? mergeDialogMessage(item, message) : item,
    ),
  };
}

function toggleDialogReactionLocally(
  dialog: ChannelDialogResponse | undefined,
  messageId: string,
  emoji: string,
): ChannelDialogResponse | undefined {
  if (!dialog) {
    return dialog;
  }

  return {
    ...dialog,
    messages: dialog.messages.map((message) => {
      if (message.id !== messageId) {
        return message;
      }

      const existingGroup = message.reactionGroups.find((group) => group.emoji === emoji) ?? null;
      const nextGroups = message.reactionGroups
        .map((group) => {
          if (group.emoji !== emoji) {
            return group;
          }

          if (group.reactedByMe) {
            const nextCount = group.count - 1;
            return nextCount > 0
              ? {
                  ...group,
                  count: nextCount,
                  reactedByMe: false,
                }
              : null;
          }

          return {
            ...group,
            count: group.count + 1,
            reactedByMe: true,
          };
        })
        .filter((group): group is NonNullable<typeof group> => group !== null);

      if (!existingGroup) {
        nextGroups.push({
          emoji,
          count: 1,
          reactedByMe: true,
        });
      }

      return {
        ...message,
        reactionGroups: nextGroups.sort(
          (left, right) => right.count - left.count || left.emoji.localeCompare(right.emoji),
        ),
      };
    }),
  };
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

function CloseIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden focusable="false">
      <path
        d="M5.5 5.5L14.5 14.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path
        d="M14.5 5.5L5.5 14.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden focusable="false">
      <path
        d="M10 4.5V15.5"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
      />
      <path
        d="M4.5 10H15.5"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ReplyArrowIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden focusable="false">
      <path
        d="M7.6 6.1L4.3 9.4L7.6 12.7"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M5 9.4H11.2C13.6 9.4 15.5 11.3 15.5 13.7V14.3"
        stroke="currentColor"
        strokeWidth="1.8"
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

export function ChannelDialogPage({ api }: { api: ApiTransport }) {
  const { chatId = '', mode } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token')?.trim() ?? '';
  const dialogType = resolveDialogType(mode);
  const entityType = resolveDialogEntityType(location.pathname);
  const [draft, setDraft] = useState('');
  const [activeMessageId, setActiveMessageId] = useState<string | null>(null);
  const [replyToMessageId, setReplyToMessageId] = useState<string | null>(null);
  const [isReactionPickerExpanded, setIsReactionPickerExpanded] = useState(false);
  const [isBodyScrolled, setIsBodyScrolled] = useState(false);
  const composeFieldRef = useRef<HTMLTextAreaElement | null>(null);
  const scrollViewportRef = useRef<HTMLElement | null>(null);
  const lastMessageIdRef = useRef<string | null>(null);
  const queryClient = useQueryClient();
  const { pushToast } = useToast();

  const chatTitle = useMemo(() => readChatTitle(chatId), [chatId]);
  const view = useMemo(() => buildViewModel(dialogType), [dialogType]);
  const dialogQueryKey = ['entity-dialog', entityType, chatId, dialogType, token] as const;
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
    queryKey: dialogQueryKey,
    queryFn: () =>
      entityType === 'channel'
        ? getChannelDialog(api, chatId, dialogType, token)
        : getChatDialog(api, chatId, dialogType, token),
    enabled: Boolean(chatId && token),
    refetchInterval: dialogType === 'comments' ? 8_000 : false,
  });

  const messages = dialogQuery.data?.messages ?? [];
  const introText = dialogQuery.data?.introText?.trim() ?? '';
  const replyTarget = useMemo(
    () => messages.find((message) => message.id === replyToMessageId) ?? null,
    [messages, replyToMessageId],
  );
  const draftLength = draft.trim().length;
  const showComposeMeta = dialogType === 'suggest' || draftLength > 0 || Boolean(replyTarget);

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
  }, [draft, replyTarget]);

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

  useEffect(() => {
    if (replyToMessageId && !messages.some((message) => message.id === replyToMessageId)) {
      setReplyToMessageId(null);
    }

    if (activeMessageId && !messages.some((message) => message.id === activeMessageId)) {
      setActiveMessageId(null);
      setIsReactionPickerExpanded(false);
    }
  }, [activeMessageId, messages, replyToMessageId]);

  useEffect(() => {
    if (!activeMessageId || typeof document === 'undefined') {
      return undefined;
    }

    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      if (
        target.closest('.channel-dialog-message') ||
        target.closest('.channel-dialog-compose')
      ) {
        return;
      }
      setActiveMessageId(null);
      setIsReactionPickerExpanded(false);
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('touchstart', handlePointerDown, { passive: true });

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('touchstart', handlePointerDown);
    };
  }, [activeMessageId]);

  useEffect(() => {
    if (!activeMessageId) {
      return undefined;
    }

    const viewport = scrollViewportRef.current;
    if (!viewport) {
      return undefined;
    }

    let frameId = 0;

    const keepActiveMessageInView = () => {
      const activeMessage = viewport.querySelector<HTMLElement>(`[data-message-id="${activeMessageId}"]`);
      if (!activeMessage) {
        return;
      }

      const viewportRect = viewport.getBoundingClientRect();
      const activeMessageRect = activeMessage.getBoundingClientRect();
      const composeSurface = document.querySelector<HTMLElement>('.channel-dialog-compose__surface');
      const composeHeight = composeSurface?.getBoundingClientRect().height ?? 0;
      const desiredTopInset = 14;
      const desiredBottomInset = composeHeight + 20;

      const topOffset = activeMessageRect.top - viewportRect.top;
      const bottomOffset = viewportRect.bottom - activeMessageRect.bottom;

      if (topOffset < desiredTopInset) {
        viewport.scrollBy({
          top: topOffset - desiredTopInset,
          behavior: 'smooth',
        });
        return;
      }

      if (bottomOffset < desiredBottomInset) {
        viewport.scrollBy({
          top: desiredBottomInset - bottomOffset,
          behavior: 'smooth',
        });
      }
    };

    frameId = requestAnimationFrame(() => {
      keepActiveMessageInView();
    });

    return () => {
      cancelAnimationFrame(frameId);
    };
  }, [activeMessageId, isReactionPickerExpanded]);

  const sendMutation = useMutation({
    mutationFn: (text: string) =>
      entityType === 'channel'
        ? createChannelDialogMessage(api, chatId, dialogType, {
            token,
            text,
            replyToMessageId,
          })
        : createChatDialogMessage(api, chatId, dialogType, {
            token,
            text,
            replyToMessageId,
          }),
    onSuccess: (result) => {
      queryClient.setQueryData<ChannelDialogResponse | undefined>(dialogQueryKey, (current) =>
        updateDialogMessage(current, result.message),
      );
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
      setReplyToMessageId(null);
      setActiveMessageId(null);
      void queryClient.invalidateQueries({
        queryKey: dialogQueryKey,
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

  const reactionMutation = useMutation({
    mutationFn: ({ messageId, emoji }: { messageId: string; emoji: string }) =>
      entityType === 'channel'
        ? toggleChannelDialogReaction(api, chatId, dialogType, messageId, {
            token,
            emoji,
          })
        : toggleChatDialogReaction(api, chatId, dialogType, messageId, {
            token,
            emoji,
          }),
    onMutate: async ({ messageId, emoji }) => {
      await queryClient.cancelQueries({ queryKey: dialogQueryKey });
      const previousDialog = queryClient.getQueryData<ChannelDialogResponse | undefined>(dialogQueryKey);
      queryClient.setQueryData<ChannelDialogResponse | undefined>(dialogQueryKey, (current) =>
        toggleDialogReactionLocally(current, messageId, emoji),
      );
      return { previousDialog };
    },
    onSuccess: (result) => {
      queryClient.setQueryData<ChannelDialogResponse | undefined>(dialogQueryKey, (current) =>
        updateDialogMessage(current, result.message),
      );
    },
    onError: (error, _variables, context) => {
      if (context?.previousDialog) {
        queryClient.setQueryData(dialogQueryKey, context.previousDialog);
      }
      pushToast({
        tone: 'danger',
        title: 'Ошибка',
        description: normalizeApiError(error),
      });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: dialogQueryKey,
      });
    },
  });

  const handleSelectMessage = (messageId: string) => {
    if (dialogType !== 'comments') {
      return;
    }

    maxImpact('light');
    setActiveMessageId((current) => {
      const nextMessageId = current === messageId ? null : messageId;
      setIsReactionPickerExpanded(false);
      return nextMessageId;
    });
  };

  const handleReply = (message: ChannelDialogMessage) => {
    maxImpact('soft');
    setReplyToMessageId(message.id);
    setActiveMessageId(null);
    setIsReactionPickerExpanded(false);
    requestAnimationFrame(() => composeFieldRef.current?.focus());
  };

  const handleReactionToggle = (
    messageId: string,
    emoji: string,
    options?: {
      closePicker?: boolean;
    },
  ) => {
    if (reactionMutation.isPending) {
      return;
    }

    maxImpact('soft');
    reactionMutation.mutate({ messageId, emoji });
    if (options?.closePicker) {
      setActiveMessageId(null);
      setIsReactionPickerExpanded(false);
    }
  };

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
        className={cn('channel-dialog-shell', dialogType === 'comments' && 'channel-dialog-shell--flat')}
      >
        {dialogType === 'suggest' ? (
          <header
            className={cn('channel-dialog-topbar', isBodyScrolled && 'is-compact')}
          >
            <button
              type="button"
              className="channel-dialog-nav"
              onClick={handleDismiss}
              aria-label="Назад"
            >
              <svg viewBox="0 0 20 20" fill="none" aria-hidden focusable="false">
                <path
                  d="M11.8 4.4L6.2 10L11.8 15.6"
                  stroke="currentColor"
                  strokeWidth="1.9"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
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

        <section
          ref={scrollViewportRef}
          className="channel-dialog-body"
          onScroll={(event) => setIsBodyScrolled(event.currentTarget.scrollTop > 18)}
        >
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
              {introText ? (
                <div
                  className={cn(
                    'channel-dialog-intro',
                    dialogType === 'comments' && isBodyScrolled && 'is-collapsed',
                  )}
                >
                  <p>{introText}</p>
                </div>
              ) : null}

              {messages.length ? (
                messages.map((message, index) => {
                  const isOwnMessage = meQuery.data?.userId === message.authorUserId;
                  const groupedWithPrevious = isGroupedWithPrevious(messages, index);
                  const isActiveMessage = activeMessageId === message.id;
                  const isReactionPending =
                    reactionMutation.isPending &&
                    reactionMutation.variables?.messageId === message.id;

                  return (
                    <article
                      key={message.id}
                      className={cn(
                        'channel-dialog-message',
                        isOwnMessage && 'is-own',
                        groupedWithPrevious && 'is-grouped',
                      )}
                    >
                      {groupedWithPrevious ? (
                        <span className="channel-dialog-message__avatar-spacer" aria-hidden />
                      ) : (
                        <DialogAvatar
                          avatarUrl={message.avatarUrl}
                          label={message.authorDisplayName || message.authorUserId}
                        />
                      )}

                      <div
                        className={cn(
                          'channel-dialog-message__content',
                          isActiveMessage && 'has-reaction-popover',
                          isActiveMessage && isReactionPickerExpanded && 'has-expanded-reaction-popover',
                        )}
                        data-message-id={message.id}
                      >
                        {dialogType === 'comments' && isActiveMessage ? (
                          <div
                            className="channel-dialog-reaction-popover"
                            onClick={(event) => event.stopPropagation()}
                          >
                            <div className="channel-dialog-reaction-popover__surface">
                              <div className="channel-dialog-reaction-popover__row">
                                {COMMENT_REACTION_PRIMARY_OPTIONS.map((emoji) => {
                                  const reactedByMe = message.reactionGroups.some(
                                    (group) => group.emoji === emoji && group.reactedByMe,
                                  );

                                  return (
                                    <button
                                      key={emoji}
                                      type="button"
                                      className={cn(
                                        'channel-dialog-reaction-popover__emoji',
                                        reactedByMe && 'is-active',
                                      )}
                                      onClick={() =>
                                        handleReactionToggle(message.id, emoji, {
                                          closePicker: true,
                                        })
                                      }
                                      disabled={isReactionPending}
                                      aria-label={`Поставить реакцию ${emoji}`}
                                    >
                                      {emoji}
                                    </button>
                                  );
                                })}

                                <button
                                  type="button"
                                  className={cn(
                                    'channel-dialog-reaction-popover__toggle',
                                    isReactionPickerExpanded && 'is-active',
                                  )}
                                  onClick={() =>
                                    setIsReactionPickerExpanded((current) => !current)
                                  }
                                  aria-label="Показать больше реакций"
                                >
                                  <PlusIcon />
                                </button>
                              </div>

                              {isReactionPickerExpanded ? (
                                <div className="channel-dialog-reaction-popover__grid">
                                  {COMMENT_REACTION_EXPANDED_OPTIONS.map((emoji) => {
                                    const reactedByMe = message.reactionGroups.some(
                                      (group) => group.emoji === emoji && group.reactedByMe,
                                    );

                                    return (
                                      <button
                                        key={emoji}
                                        type="button"
                                        className={cn(
                                          'channel-dialog-reaction-popover__emoji',
                                          'is-secondary',
                                          reactedByMe && 'is-active',
                                        )}
                                        onClick={() =>
                                          handleReactionToggle(message.id, emoji, {
                                            closePicker: true,
                                          })
                                        }
                                        disabled={isReactionPending}
                                        aria-label={`Поставить реакцию ${emoji}`}
                                      >
                                        {emoji}
                                      </button>
                                    );
                                  })}
                                </div>
                              ) : null}

                              <div className="channel-dialog-reaction-popover__actions">
                                <button
                                  type="button"
                                  className="channel-dialog-reaction-popover__action"
                                  onClick={() => handleReply(message)}
                                >
                                  <ReplyArrowIcon />
                                  Ответить
                                </button>
                              </div>
                            </div>
                          </div>
                        ) : null}

                        <div
                          className={cn(
                            'channel-dialog-message__bubble',
                            dialogType === 'comments' && 'is-selectable',
                            isActiveMessage && 'is-active',
                            groupedWithPrevious && 'is-grouped',
                          )}
                          onClick={
                            dialogType === 'comments'
                              ? () => handleSelectMessage(message.id)
                              : undefined
                          }
                          onKeyDown={
                            dialogType === 'comments'
                              ? (event) => {
                                  if (event.key === 'Enter' || event.key === ' ') {
                                    event.preventDefault();
                                    handleSelectMessage(message.id);
                                  }
                                }
                              : undefined
                          }
                          role={dialogType === 'comments' ? 'button' : undefined}
                          tabIndex={dialogType === 'comments' ? 0 : undefined}
                          aria-pressed={dialogType === 'comments' ? isActiveMessage : undefined}
                        >
                          {!groupedWithPrevious ? (
                            <div className="channel-dialog-message__meta">
                              <strong>{getAuthorLabel(message)}</strong>
                              <time dateTime={message.createdAt}>
                                {formatMessageTime(message.createdAt)}
                              </time>
                            </div>
                          ) : null}

                          {message.replyTo ? (
                            <div className="channel-dialog-message__reply">
                              <span>{message.replyTo.authorDisplayName || 'Комментарий'}</span>
                              <p>{summarizeReplyText(message.replyTo.text)}</p>
                            </div>
                          ) : null}

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

                        {dialogType === 'comments' && message.reactionGroups.length > 0 ? (
                          <div className="channel-dialog-message__footer channel-dialog-message__footer--comments">
                            <div className="channel-dialog-message__reactions">
                              {message.reactionGroups.map((group) => (
                                <button
                                  key={group.emoji}
                                  type="button"
                                  className={cn(
                                    'channel-dialog-reaction-pill',
                                    group.reactedByMe && 'is-active',
                                  )}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    handleReactionToggle(message.id, group.emoji);
                                  }}
                                  disabled={isReactionPending}
                                >
                                  <b>{group.emoji}</b>
                                  <span>{group.count}</span>
                                </button>
                              ))}
                            </div>
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
            {replyTarget ? (
              <div className="channel-dialog-compose__reply">
                <div className="channel-dialog-compose__reply-copy">
                  <span>Ответ {replyTarget.authorDisplayName || 'участнику'}</span>
                  <p>{summarizeReplyText(replyTarget.text, 84)}</p>
                </div>
                <button
                  type="button"
                  className="channel-dialog-compose__reply-dismiss"
                  onClick={() => setReplyToMessageId(null)}
                  aria-label="Отменить ответ"
                >
                  <CloseIcon />
                </button>
              </div>
            ) : null}

            {showComposeMeta ? (
              <div
                className={cn(
                  'channel-dialog-compose__meta',
                  dialogType !== 'suggest' && 'channel-dialog-compose__meta--solo',
                )}
              >
                {dialogType === 'suggest' ? <span>Только для админов</span> : null}
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
                  placeholder={replyTarget ? 'Ответить на комментарий' : view.placeholder}
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
