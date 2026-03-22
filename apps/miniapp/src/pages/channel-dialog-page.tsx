import type {
  ChannelDialogMessage,
  ChannelDialogResponse,
  ChannelDialogType,
} from '@maxim/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type UIEvent as ReactUIEvent,
} from 'react';
import { createPortal } from 'react-dom';
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
import {
  PREVIEW_CHANNEL_ID,
  PREVIEW_CHANNEL_TITLE,
  PREVIEW_CHAT_ID,
  PREVIEW_CHAT_TITLE,
} from '../lib/design-preview';
import { readChatTitle } from '../lib/chat-titles';
import { buildManagedEntitiesRoute, saveLastEntityId, type LastEntityType } from '../lib/last-chat';
import { maxImpact, maxSelectionChanged } from '../lib/max-bridge';

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
const COMMENTS_NEAR_BOTTOM_THRESHOLD = 72;
const COMMENTS_STICK_TO_BOTTOM_THRESHOLD = 160;
const SOURCE_HIGHLIGHT_DURATION_MS = 1_500;
const SWIPE_REPLY_ACTIVATION_DISTANCE = 14;
const SWIPE_REPLY_TRIGGER_DISTANCE = 54;
const SWIPE_REPLY_MAX_OFFSET = 78;

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

function resolveMessageWidthTone(message: ChannelDialogMessage): 'is-wide' | 'is-medium' | 'is-compact' {
  if (message.replyTo) {
    return 'is-wide';
  }

  const normalizedText = message.text.replace(/\s+/gu, ' ').trim();
  if (normalizedText.length >= 108) {
    return 'is-wide';
  }

  if (normalizedText.length <= 56) {
    return 'is-compact';
  }

  return 'is-medium';
}

function buildSwipeReplyStyle(preview: SwipeReplyPreview | null, messageId: string): CSSProperties | undefined {
  if (!preview || preview.messageId !== messageId) {
    return undefined;
  }

  return {
    '--channel-dialog-swipe-offset': `${preview.offset}px`,
    '--channel-dialog-swipe-progress': `${preview.progress}`,
  } as CSSProperties;
}

function getViewportDistanceToBottom(viewport: HTMLElement): number {
  return viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
}

function resolveNextUnreadMessageId(
  messages: ChannelDialogMessage[],
  previousLastMessageId: string | null,
  currentLastMessageId: string | null,
): string | null {
  if (!messages.length) {
    return null;
  }

  if (!previousLastMessageId) {
    return currentLastMessageId ?? messages[messages.length - 1]?.id ?? null;
  }

  const previousMessageIndex = messages.findIndex((message) => message.id === previousLastMessageId);
  if (previousMessageIndex < 0) {
    return currentLastMessageId ?? messages[messages.length - 1]?.id ?? null;
  }

  return messages[previousMessageIndex + 1]?.id ?? currentLastMessageId ?? null;
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

      const reactedEmoji = message.reactionGroups.find((group) => group.reactedByMe)?.emoji ?? null;
      const nextGroups = message.reactionGroups
        .map((group) => {
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

          if (reactedEmoji === emoji || group.emoji !== emoji) {
            return group;
          }

          return {
            ...group,
            count: group.count + 1,
            reactedByMe: true,
          };
        })
        .filter((group): group is NonNullable<typeof group> => group !== null);

      if (reactedEmoji !== emoji && !nextGroups.some((group) => group.emoji === emoji)) {
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

function BackIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden focusable="false">
      <path
        d="M11.8 4.4L6.2 10L11.8 15.6"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
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

type ReactionPopoverLayout = {
  left: number;
  top: number;
  width: number;
  placement: 'above' | 'below';
};

type SwipeReplyPreview = {
  messageId: string;
  offset: number;
  progress: number;
  armed: boolean;
};

type SwipeReplyGesture = {
  messageId: string;
  startX: number;
  startY: number;
  isOwn: boolean;
  engaged: boolean;
  armed: boolean;
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

function resolveDialogTitle(
  chatId: string,
  entityType: LastEntityType,
  storedTitle: string,
): string {
  if (storedTitle.trim()) {
    return storedTitle.trim();
  }

  if (entityType === 'channel' && chatId === PREVIEW_CHANNEL_ID) {
    return PREVIEW_CHANNEL_TITLE;
  }

  if (entityType === 'chat' && chatId === PREVIEW_CHAT_ID) {
    return PREVIEW_CHAT_TITLE;
  }

  return chatId;
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
  const [isNearBottom, setIsNearBottom] = useState(true);
  const [firstUnreadMessageId, setFirstUnreadMessageId] = useState<string | null>(null);
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  const [swipeReplyPreview, setSwipeReplyPreview] = useState<SwipeReplyPreview | null>(null);
  const [reactionPopoverLayout, setReactionPopoverLayout] = useState<ReactionPopoverLayout | null>(
    null,
  );
  const composeFieldRef = useRef<HTMLTextAreaElement | null>(null);
  const screenRef = useRef<HTMLDivElement | null>(null);
  const scrollViewportRef = useRef<HTMLElement | null>(null);
  const reactionPopoverRef = useRef<HTMLDivElement | null>(null);
  const lastMessageIdRef = useRef<string | null>(null);
  const highlightTimerRef = useRef<number | null>(null);
  const pressTimerRef = useRef<number | null>(null);
  const pressPointRef = useRef<{ x: number; y: number } | null>(null);
  const swipeReplyGestureRef = useRef<SwipeReplyGesture | null>(null);
  const messageNodeRefs = useRef(new Map<string, HTMLElement>());
  const messageLayoutContextRef = useRef<string | null>(null);
  const messageRectsRef = useRef(new Map<string, DOMRect>());
  const ignoreNextBubbleClickRef = useRef(false);
  const queryClient = useQueryClient();
  const { pushToast } = useToast();

  const chatTitle = useMemo(() => readChatTitle(chatId), [chatId]);
  const chatLabel = useMemo(
    () => resolveDialogTitle(chatId, entityType, chatTitle),
    [chatId, chatTitle, entityType],
  );
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
  const messageIdSet = useMemo(() => new Set(messages.map((message) => message.id)), [messages]);
  const activeMessage = useMemo(
    () => messages.find((message) => message.id === activeMessageId) ?? null,
    [activeMessageId, messages],
  );
  const replyTarget = useMemo(
    () => messages.find((message) => message.id === replyToMessageId) ?? null,
    [messages, replyToMessageId],
  );
  const draftLength = draft.trim().length;
  const showComposeMeta = dialogType === 'suggest' || draftLength > 0 || Boolean(replyTarget);
  const activeMessageIsOwn = activeMessage
    ? meQuery.data?.userId === activeMessage.authorUserId
    : false;
  const unreadStartIndex = useMemo(
    () =>
      firstUnreadMessageId
        ? messages.findIndex((message) => message.id === firstUnreadMessageId)
        : -1,
    [firstUnreadMessageId, messages],
  );
  const unreadCount = unreadStartIndex >= 0 ? messages.length - unreadStartIndex : 0;
  const showJumpToLatest = dialogType === 'comments' && unreadCount > 0 && !isNearBottom;

  const clearMessagePress = () => {
    if (pressTimerRef.current !== null && typeof window !== 'undefined') {
      window.clearTimeout(pressTimerRef.current);
    }
    pressTimerRef.current = null;
    pressPointRef.current = null;
  };

  const clearSwipeReplyGesture = () => {
    swipeReplyGestureRef.current = null;
    setSwipeReplyPreview(null);
  };

  const clearSourceHighlight = () => {
    if (highlightTimerRef.current !== null && typeof window !== 'undefined') {
      window.clearTimeout(highlightTimerRef.current);
    }
    highlightTimerRef.current = null;
    setHighlightedMessageId(null);
  };

  const flashSourceHighlight = (messageId: string) => {
    if (typeof window === 'undefined') {
      setHighlightedMessageId(messageId);
      return;
    }

    if (highlightTimerRef.current !== null) {
      window.clearTimeout(highlightTimerRef.current);
    }

    setHighlightedMessageId(messageId);
    highlightTimerRef.current = window.setTimeout(() => {
      highlightTimerRef.current = null;
      setHighlightedMessageId((current) => (current === messageId ? null : current));
    }, SOURCE_HIGHLIGHT_DURATION_MS);
  };

  const dismissMessageActions = () => {
    setActiveMessageId(null);
    setIsReactionPickerExpanded(false);
    setReactionPopoverLayout(null);
    clearSwipeReplyGesture();
  };

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

  useEffect(
    () => () => {
      if (highlightTimerRef.current !== null && typeof window !== 'undefined') {
        window.clearTimeout(highlightTimerRef.current);
      }
      highlightTimerRef.current = null;
      if (pressTimerRef.current !== null && typeof window !== 'undefined') {
        window.clearTimeout(pressTimerRef.current);
      }
      pressTimerRef.current = null;
      pressPointRef.current = null;
      swipeReplyGestureRef.current = null;
    },
    [],
  );

  useLayoutEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const currentLayoutContext = `${location.pathname}${location.search}`;
    const nextRects = new Map<string, DOMRect>();
    for (const [messageId, node] of messageNodeRefs.current.entries()) {
      if (node.isConnected) {
        nextRects.set(messageId, node.getBoundingClientRect());
      }
    }

    const shouldAnimateLayout =
      messageLayoutContextRef.current === currentLayoutContext &&
      !window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (shouldAnimateLayout) {
      for (const [messageId, nextRect] of nextRects.entries()) {
        const node = messageNodeRefs.current.get(messageId);
        if (!node) {
          continue;
        }

        const previousRect = messageRectsRef.current.get(messageId);
        if (!previousRect) {
          node.animate(
            [
              { opacity: 0, transform: 'translateY(14px) scale(0.985)' },
              { opacity: 1, transform: 'translateY(0px) scale(1)' },
            ],
            {
              duration: 280,
              easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
            },
          );
          continue;
        }

        const deltaX = previousRect.left - nextRect.left;
        const deltaY = previousRect.top - nextRect.top;
        if (Math.abs(deltaX) < 0.5 && Math.abs(deltaY) < 0.5) {
          continue;
        }

        node.animate(
          [
            { transform: `translate(${deltaX}px, ${deltaY}px)` },
            { transform: 'translate(0px, 0px)' },
          ],
          {
            duration: 260,
            easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
          },
        );
      }
    }

    messageLayoutContextRef.current = currentLayoutContext;
    messageRectsRef.current = nextRects;
  }, [location.pathname, location.search, messages]);

  useEffect(() => {
    const viewport = scrollViewportRef.current;
    const lastMessageId = messages[messages.length - 1]?.id ?? null;
    if (!viewport || !lastMessageId) {
      lastMessageIdRef.current = lastMessageId;
      setIsNearBottom(true);
      return;
    }

    const previousMessageId = lastMessageIdRef.current;
    const distanceToBottom = getViewportDistanceToBottom(viewport);
    const nearBottom = distanceToBottom < COMMENTS_NEAR_BOTTOM_THRESHOLD;
    const shouldStickToBottom =
      previousMessageId === null || distanceToBottom < COMMENTS_STICK_TO_BOTTOM_THRESHOLD;
    setIsNearBottom(nearBottom);

    if (previousMessageId !== lastMessageId) {
      if (shouldStickToBottom) {
        setFirstUnreadMessageId(null);
        requestAnimationFrame(() => {
          viewport.scrollTo({
            top: viewport.scrollHeight,
            behavior: previousMessageId ? 'smooth' : 'auto',
          });
        });
      } else if (dialogType === 'comments') {
        const nextUnreadMessageId = resolveNextUnreadMessageId(
          messages,
          previousMessageId,
          lastMessageId,
        );
        if (nextUnreadMessageId) {
          setFirstUnreadMessageId((current) => current ?? nextUnreadMessageId);
        }
      }
    }

    lastMessageIdRef.current = lastMessageId;
  }, [dialogType, messages]);

  useEffect(() => {
    if (replyToMessageId && !messages.some((message) => message.id === replyToMessageId)) {
      setReplyToMessageId(null);
    }

    if (activeMessageId && !messages.some((message) => message.id === activeMessageId)) {
      setActiveMessageId(null);
      setIsReactionPickerExpanded(false);
      setReactionPopoverLayout(null);
    }

    if (swipeReplyPreview && !messages.some((message) => message.id === swipeReplyPreview.messageId)) {
      swipeReplyGestureRef.current = null;
      setSwipeReplyPreview(null);
    }

    if (firstUnreadMessageId && !messageIdSet.has(firstUnreadMessageId)) {
      setFirstUnreadMessageId(null);
    }

    if (highlightedMessageId && !messageIdSet.has(highlightedMessageId)) {
      clearSourceHighlight();
    }
  }, [
    activeMessageId,
    firstUnreadMessageId,
    highlightedMessageId,
    messageIdSet,
    messages,
    replyToMessageId,
    swipeReplyPreview,
  ]);

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
        target.closest('.channel-dialog-compose') ||
        target.closest('.channel-dialog-comments-header') ||
        target.closest('.channel-dialog-popover-layer')
      ) {
        return;
      }
      dismissMessageActions();
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('touchstart', handlePointerDown, { passive: true });

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('touchstart', handlePointerDown);
    };
  }, [activeMessageId]);

  useEffect(() => {
    if (!activeMessageId || typeof document === 'undefined') {
      return undefined;
    }

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }

      event.preventDefault();
      dismissMessageActions();
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [activeMessageId]);

  useLayoutEffect(() => {
    if (dialogType !== 'comments' || !activeMessageId) {
      setReactionPopoverLayout(null);
      return undefined;
    }

    const screen = screenRef.current;
    const viewport = scrollViewportRef.current;
    if (!screen || !viewport) {
      return undefined;
    }

    let frameId = 0;

    const updateLayout = () => {
      const bubble = screen.querySelector<HTMLElement>(
        `[data-message-bubble-id="${activeMessageId}"]`,
      );
      if (!bubble) {
        setReactionPopoverLayout(null);
        return;
      }

      const screenRect = screen.getBoundingClientRect();
      const viewportRect = viewport.getBoundingClientRect();
      const bubbleRect = bubble.getBoundingClientRect();
      const composeSurface = screen.querySelector<HTMLElement>('.channel-dialog-compose__surface');
      const composeTop = composeSurface?.getBoundingClientRect().top ?? screenRect.bottom;
      const popoverHeight =
        reactionPopoverRef.current?.getBoundingClientRect().height ??
        (isReactionPickerExpanded ? 168 : 108);
      const availableWidth = Math.max(220, Math.min(screenRect.width - 24, 304));
      const topBoundary = viewportRect.top + 6;
      const bottomBoundary = Math.min(viewportRect.bottom - 8, composeTop - 8);
      const topSpace = bubbleRect.top - topBoundary;
      const bottomSpace = bottomBoundary - bubbleRect.bottom;
      const placeBelow = topSpace < popoverHeight + 10 && bottomSpace > topSpace;
      const unclampedTop = placeBelow
        ? bubbleRect.bottom - screenRect.top + 8
        : bubbleRect.top - screenRect.top - popoverHeight - 8;
      const minTop = Math.max(8, topBoundary - screenRect.top);
      const maxTop = Math.max(minTop, bottomBoundary - screenRect.top - popoverHeight);
      const nextTop = Math.max(minTop, Math.min(unclampedTop, maxTop));
      const unclampedLeft = activeMessageIsOwn
        ? bubbleRect.right - screenRect.left - availableWidth
        : bubbleRect.left - screenRect.left;
      const nextLeft = Math.max(12, Math.min(unclampedLeft, screenRect.width - availableWidth - 12));

      setReactionPopoverLayout((current) => {
        if (
          current &&
          current.left === nextLeft &&
          current.top === nextTop &&
          current.width === availableWidth &&
          current.placement === (placeBelow ? 'below' : 'above')
        ) {
          return current;
        }

        return {
          left: nextLeft,
          top: nextTop,
          width: availableWidth,
          placement: placeBelow ? 'below' : 'above',
        };
      });
    };

    const requestLayout = () => {
      cancelAnimationFrame(frameId);
      frameId = requestAnimationFrame(updateLayout);
    };

    requestLayout();
    viewport.addEventListener('scroll', requestLayout, { passive: true });
    window.addEventListener('resize', requestLayout);
    window.visualViewport?.addEventListener('resize', requestLayout);

    return () => {
      cancelAnimationFrame(frameId);
      viewport.removeEventListener('scroll', requestLayout);
      window.removeEventListener('resize', requestLayout);
      window.visualViewport?.removeEventListener('resize', requestLayout);
    };
  }, [activeMessageId, activeMessageIsOwn, dialogType, isReactionPickerExpanded]);

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
      const activeBubble = viewport.querySelector<HTMLElement>(
        `[data-message-bubble-id="${activeMessageId}"]`,
      );
      if (!activeBubble) {
        return;
      }

      const viewportRect = viewport.getBoundingClientRect();
      const activeBubbleRect = activeBubble.getBoundingClientRect();
      const composeSurface = document.querySelector<HTMLElement>('.channel-dialog-compose__surface');
      const header = document.querySelector<HTMLElement>('.channel-dialog-comments-header');
      const composeHeight = composeSurface?.getBoundingClientRect().height ?? 0;
      const headerHeight = header?.getBoundingClientRect().height ?? 0;
      const popoverHeight = reactionPopoverRef.current?.getBoundingClientRect().height ?? 0;
      const desiredTopInset =
        14 +
        (reactionPopoverLayout?.placement === 'above' ? headerHeight + popoverHeight + 10 : headerHeight);
      const desiredBottomInset =
        composeHeight + 20 + (reactionPopoverLayout?.placement === 'below' ? popoverHeight + 10 : 0);

      const topOffset = activeBubbleRect.top - viewportRect.top;
      const bottomOffset = viewportRect.bottom - activeBubbleRect.bottom;

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
  }, [activeMessageId, reactionPopoverLayout]);

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
      dismissMessageActions();
      if (dialogType === 'comments') {
        requestAnimationFrame(() => {
          const viewport = scrollViewportRef.current;
          if (!viewport) {
            return;
          }
          setFirstUnreadMessageId(null);
          setIsNearBottom(true);
          viewport.scrollTo({
            top: viewport.scrollHeight,
            behavior: 'smooth',
          });
        });
      }
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

  const openMessageActions = (
    messageId: string,
    options?: {
      haptic?: 'light' | 'medium';
      toggle?: boolean;
    },
  ) => {
    if (dialogType !== 'comments') {
      return;
    }

    maxImpact(options?.haptic ?? 'light');
    clearSwipeReplyGesture();
    setIsReactionPickerExpanded(false);
    setActiveMessageId((current) => {
      const shouldToggle = options?.toggle !== false;
      return shouldToggle && current === messageId ? null : messageId;
    });
  };

  const handleBubblePointerDown =
    (message: ChannelDialogMessage, isOwnMessage: boolean) =>
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (dialogType !== 'comments' || event.pointerType === 'mouse') {
        return;
      }

      clearMessagePress();
      clearSwipeReplyGesture();
      ignoreNextBubbleClickRef.current = false;
      pressPointRef.current = {
        x: event.clientX,
        y: event.clientY,
      };
      swipeReplyGestureRef.current = {
        messageId: message.id,
        startX: event.clientX,
        startY: event.clientY,
        isOwn: isOwnMessage,
        engaged: false,
        armed: false,
      };
      event.currentTarget.setPointerCapture?.(event.pointerId);
      pressTimerRef.current = window.setTimeout(() => {
        if (swipeReplyGestureRef.current?.engaged) {
          return;
        }
        ignoreNextBubbleClickRef.current = true;
        openMessageActions(message.id, {
          haptic: 'medium',
          toggle: false,
        });
      }, 340);
    };

  const handleBubblePointerMove =
    (message: ChannelDialogMessage, isOwnMessage: boolean) =>
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.pointerType === 'mouse') {
        return;
      }

      const swipeGesture = swipeReplyGestureRef.current;
      if (!swipeGesture || swipeGesture.messageId !== message.id) {
        return;
      }

      const deltaX = event.clientX - swipeGesture.startX;
      const deltaY = event.clientY - swipeGesture.startY;
      const directionalDelta = deltaX * (isOwnMessage ? -1 : 1);

      if (!swipeGesture.engaged) {
        if (Math.abs(deltaY) > 10 && Math.abs(deltaY) > Math.abs(deltaX)) {
          clearMessagePress();
          clearSwipeReplyGesture();
          return;
        }

        if (
          directionalDelta > SWIPE_REPLY_ACTIVATION_DISTANCE &&
          Math.abs(deltaY) < SWIPE_REPLY_ACTIVATION_DISTANCE + 6
        ) {
          swipeGesture.engaged = true;
          clearMessagePress();
          ignoreNextBubbleClickRef.current = true;
        }
      }

      if (!swipeGesture.engaged) {
        if (!pressPointRef.current) {
          return;
        }

        const pressDeltaX = Math.abs(event.clientX - pressPointRef.current.x);
        const pressDeltaY = Math.abs(event.clientY - pressPointRef.current.y);
        if (pressDeltaX > 8 || pressDeltaY > 8) {
          clearMessagePress();
        }
        return;
      }

      event.preventDefault();
      const swipeDistance = Math.max(
        0,
        Math.min(directionalDelta - SWIPE_REPLY_ACTIVATION_DISTANCE, SWIPE_REPLY_MAX_OFFSET),
      );
      const isArmed = swipeDistance >= SWIPE_REPLY_TRIGGER_DISTANCE;
      if (swipeGesture.armed !== isArmed) {
        maxSelectionChanged();
      }
      swipeGesture.armed = isArmed;
      setSwipeReplyPreview({
        messageId: message.id,
        offset: swipeDistance * (isOwnMessage ? -1 : 1),
        progress: swipeDistance / SWIPE_REPLY_MAX_OFFSET,
        armed: isArmed,
      });
    };

  const handleBubblePointerUp =
    (message: ChannelDialogMessage) => (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.pointerType === 'mouse') {
        return;
      }

      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      clearMessagePress();
      const shouldReply =
        swipeReplyGestureRef.current?.messageId === message.id &&
        swipeReplyGestureRef.current.engaged &&
        swipeReplyGestureRef.current.armed;
      clearSwipeReplyGesture();
      if (!shouldReply) {
        return;
      }

      ignoreNextBubbleClickRef.current = true;
      handleReply(message);
    };

  const handleBubblePointerCancel = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse') {
      return;
    }

    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    clearMessagePress();
    clearSwipeReplyGesture();
  };

  const handleBubbleClick = (messageId: string) => (event: ReactMouseEvent<HTMLDivElement>) => {
    if (ignoreNextBubbleClickRef.current) {
      ignoreNextBubbleClickRef.current = false;
      return;
    }

    if (dialogType !== 'comments') {
      return;
    }

    const target = event.currentTarget.ownerDocument.defaultView;
    if (target?.matchMedia('(pointer: coarse)').matches) {
      return;
    }

    openMessageActions(messageId);
  };

  const handleBubbleKeyDown = (messageId: string) => (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') {
      return;
    }

    event.preventDefault();
    openMessageActions(messageId);
  };

  const handleBubbleContextMenu =
    (messageId: string) => (event: ReactMouseEvent<HTMLDivElement>) => {
      if (dialogType !== 'comments') {
        return;
      }

      event.preventDefault();
      ignoreNextBubbleClickRef.current = true;
      openMessageActions(messageId, {
        haptic: 'medium',
        toggle: false,
      });
    };

  const handleReply = (message: ChannelDialogMessage) => {
    maxImpact('soft');
    setReplyToMessageId(message.id);
    dismissMessageActions();
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
      dismissMessageActions();
    }
  };

  const scrollToMessage = (
    messageId: string,
    options?: {
      behavior?: ScrollBehavior;
      highlight?: boolean;
    },
  ): boolean => {
    const viewport = scrollViewportRef.current;
    const targetMessage = messageNodeRefs.current.get(messageId);
    if (!viewport || !targetMessage) {
      return false;
    }

    const viewportRect = viewport.getBoundingClientRect();
    const targetRect = targetMessage.getBoundingClientRect();
    const composeSurface = screenRef.current?.querySelector<HTMLElement>('.channel-dialog-compose__surface');
    const composeHeight = composeSurface?.getBoundingClientRect().height ?? 0;
    const topInset = introText ? 72 : 18;
    const bottomInset = composeHeight + 22;
    const availableHeight = Math.max(140, viewport.clientHeight - topInset - bottomInset);
    const desiredTop =
      viewport.scrollTop +
      (targetRect.top - viewportRect.top) -
      topInset -
      Math.max(0, (availableHeight - targetRect.height) / 2);
    const nextTop = Math.max(0, Math.min(desiredTop, viewport.scrollHeight - viewport.clientHeight));

    viewport.scrollTo({
      top: nextTop,
      behavior: options?.behavior ?? 'smooth',
    });

    if (options?.highlight !== false) {
      flashSourceHighlight(messageId);
    }

    return true;
  };

  const handleBodyScroll = (event: ReactUIEvent<HTMLElement>) => {
    const viewport = event.currentTarget;
    setIsBodyScrolled(viewport.scrollTop > 18);

    if (dialogType !== 'comments') {
      return;
    }

    const nearBottom = getViewportDistanceToBottom(viewport) < COMMENTS_NEAR_BOTTOM_THRESHOLD;
    setIsNearBottom(nearBottom);
    if (nearBottom && firstUnreadMessageId) {
      setFirstUnreadMessageId(null);
    }
  };

  const handleJumpToLatest = () => {
    const viewport = scrollViewportRef.current;
    if (!viewport) {
      return;
    }

    maxImpact('light');
    dismissMessageActions();
    setFirstUnreadMessageId(null);
    setIsNearBottom(true);
    viewport.scrollTo({
      top: viewport.scrollHeight,
      behavior: 'smooth',
    });
  };

  const handleJumpToSource =
    (messageId: string) => (event: ReactMouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      maxImpact('light');
      dismissMessageActions();
      scrollToMessage(messageId);
    };

  const handleComposeReplySourceJump = () => {
    if (!replyTarget) {
      return;
    }

    maxImpact('light');
    scrollToMessage(replyTarget.id);
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
      ref={screenRef}
      className={cn('channel-dialog-screen', `channel-dialog-screen--${dialogType}`, 'page-enter')}
    >
      <div className="channel-dialog-screen__backdrop" aria-hidden />

      <div className="channel-dialog-shell">
        {dialogType === 'comments' && introText ? (
          <div className="channel-dialog-thread-context channel-dialog-thread-context--floating">
            <p>{introText}</p>
          </div>
        ) : null}

        {dialogType === 'suggest' ? (
          <header className={cn('channel-dialog-topbar', isBodyScrolled && 'is-compact')}>
            <button
              type="button"
              className="channel-dialog-nav"
              onClick={handleDismiss}
              aria-label="Назад"
            >
              <BackIcon />
            </button>

            <div className="channel-dialog-topbar__title">
              <h1>{view.title}</h1>
              <span>{chatLabel}</span>
            </div>

            <button type="button" className="channel-dialog-close" onClick={handleDismiss}>
              Закрыть
            </button>
          </header>
        ) : null}

        <section
          ref={scrollViewportRef}
          className={cn(
            'channel-dialog-body',
            dialogType === 'comments' && introText && 'has-floating-thread-context',
          )}
          onScroll={handleBodyScroll}
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
              {introText && dialogType !== 'comments' ? (
                <div
                  className={cn(
                    'channel-dialog-intro',
                    isBodyScrolled && 'is-collapsed',
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
                  const messageWidthTone = resolveMessageWidthTone(message);
                  const replySourceMessageId =
                    message.replyTo?.messageId ?? message.replyToMessageId ?? null;
                  const canJumpToReplySource = Boolean(
                    replySourceMessageId && messageIdSet.has(replySourceMessageId),
                  );
                  const isReactionPending =
                    reactionMutation.isPending &&
                    reactionMutation.variables?.messageId === message.id;

                  return (
                    <Fragment key={message.id}>
                      {dialogType === 'comments' && unreadStartIndex === index ? (
                        <div className="channel-dialog-new-comments" aria-label="Новые комментарии">
                          <span>Новые комментарии</span>
                        </div>
                      ) : null}

                      <article
                        ref={(node) => {
                          if (node) {
                            messageNodeRefs.current.set(message.id, node);
                            return;
                          }
                          messageNodeRefs.current.delete(message.id);
                        }}
                        className={cn(
                          'channel-dialog-message',
                          isOwnMessage && 'is-own',
                          groupedWithPrevious && 'is-grouped',
                          highlightedMessageId === message.id && 'is-source-highlighted',
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
                            dialogType === 'comments' && messageWidthTone,
                            dialogType === 'comments' &&
                              swipeReplyPreview?.messageId === message.id &&
                              'is-swipe-active',
                            dialogType === 'comments' &&
                              swipeReplyPreview?.messageId === message.id &&
                              swipeReplyPreview.armed &&
                              'is-swipe-armed',
                            isActiveMessage && 'is-context-open',
                          )}
                          data-message-id={message.id}
                          style={buildSwipeReplyStyle(swipeReplyPreview, message.id)}
                        >
                          {dialogType === 'comments' ? (
                            <div className="channel-dialog-message__swipe-indicator" aria-hidden>
                              <span className="channel-dialog-message__swipe-indicator-icon">
                                <ReplyArrowIcon />
                              </span>
                            </div>
                          ) : null}

                          <div
                            className={cn(
                              'channel-dialog-message__stack',
                              dialogType === 'comments' &&
                                swipeReplyPreview?.messageId === message.id &&
                                'is-swipe-active',
                            )}
                          >
                            <div
                              className={cn(
                                'channel-dialog-message__bubble',
                                dialogType === 'comments' && 'is-selectable',
                                isActiveMessage && 'is-active',
                                groupedWithPrevious && 'is-grouped',
                              )}
                              data-message-bubble-id={message.id}
                              onClick={dialogType === 'comments' ? handleBubbleClick(message.id) : undefined}
                              onKeyDown={
                                dialogType === 'comments' ? handleBubbleKeyDown(message.id) : undefined
                              }
                              onPointerDown={
                                dialogType === 'comments'
                                  ? handleBubblePointerDown(message, isOwnMessage)
                                  : undefined
                              }
                              onPointerMove={
                                dialogType === 'comments'
                                  ? handleBubblePointerMove(message, isOwnMessage)
                                  : undefined
                              }
                              onPointerUp={
                                dialogType === 'comments' ? handleBubblePointerUp(message) : undefined
                              }
                              onPointerCancel={
                                dialogType === 'comments' ? handleBubblePointerCancel : undefined
                              }
                              onContextMenu={
                                dialogType === 'comments' ? handleBubbleContextMenu(message.id) : undefined
                              }
                              role={dialogType === 'comments' ? 'button' : undefined}
                              tabIndex={dialogType === 'comments' ? 0 : undefined}
                              aria-pressed={dialogType === 'comments' ? isActiveMessage : undefined}
                              aria-haspopup={dialogType === 'comments' ? 'dialog' : undefined}
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
                                canJumpToReplySource && replySourceMessageId ? (
                                  <button
                                    type="button"
                                    className={cn('channel-dialog-message__reply', 'is-link')}
                                    onPointerDown={(event) => event.stopPropagation()}
                                    onKeyDown={(event) => event.stopPropagation()}
                                    onClick={handleJumpToSource(replySourceMessageId)}
                                    aria-label="Перейти к исходному комментарию"
                                  >
                                    <span>{message.replyTo.authorDisplayName || 'Комментарий'}</span>
                                    <p>{summarizeReplyText(message.replyTo.text)}</p>
                                  </button>
                                ) : (
                                  <div className="channel-dialog-message__reply">
                                    <span>{message.replyTo.authorDisplayName || 'Комментарий'}</span>
                                    <p>{summarizeReplyText(message.replyTo.text)}</p>
                                  </div>
                                )
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
                        </div>
                      </article>
                    </Fragment>
                  );
                })
              ) : (
                <div className="channel-dialog-empty">Пока пусто</div>
              )}
            </div>
          ) : null}
        </section>

        <section className="channel-dialog-compose">
          {showJumpToLatest ? (
            <button
              type="button"
              className="channel-dialog-jump-latest"
              onClick={handleJumpToLatest}
              aria-label={`Перейти к ${unreadCount} новым комментариям`}
            >
              <span className="channel-dialog-jump-latest__icon" aria-hidden>
                <SendArrowIcon />
              </span>
              <span>К новым</span>
              <b>{unreadCount}</b>
            </button>
          ) : null}

          <div className="channel-dialog-compose__surface">
            {replyTarget ? (
              <div className="channel-dialog-compose__reply">
                <button
                  type="button"
                  className={cn('channel-dialog-compose__reply-copy', 'is-link')}
                  onClick={handleComposeReplySourceJump}
                >
                  <span>Ответ {replyTarget.authorDisplayName || 'участнику'}</span>
                  <p>{summarizeReplyText(replyTarget.text, 84)}</p>
                </button>
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

      {dialogType === 'comments' && activeMessage
        ? createPortal(
            <div className="channel-dialog-popover-layer" onClick={dismissMessageActions}>
              <div
                ref={reactionPopoverRef}
                className={cn(
                  'channel-dialog-reaction-popover',
                  'is-floating',
                  reactionPopoverLayout?.placement === 'below' && 'is-below',
                  !reactionPopoverLayout && 'is-measuring',
                )}
                role="dialog"
                aria-label="Действия с комментарием"
                style={
                  reactionPopoverLayout
                    ? {
                        left: `${reactionPopoverLayout.left}px`,
                        top: `${reactionPopoverLayout.top}px`,
                        width: `${reactionPopoverLayout.width}px`,
                      }
                    : undefined
                }
                onClick={(event) => event.stopPropagation()}
              >
                <div className="channel-dialog-reaction-popover__surface">
                  <div className="channel-dialog-reaction-popover__rail">
                    <div className="channel-dialog-reaction-popover__emoji-rail">
                      {COMMENT_REACTION_PRIMARY_OPTIONS.map((emoji) => {
                        const reactedByMe = activeMessage.reactionGroups.some(
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
                              handleReactionToggle(activeMessage.id, emoji, {
                                closePicker: true,
                              })
                            }
                            disabled={reactionMutation.isPending}
                            aria-label={`Поставить реакцию ${emoji}`}
                          >
                            {emoji}
                          </button>
                        );
                      })}
                    </div>

                    <div className="channel-dialog-reaction-popover__rail-actions">
                      <button
                        type="button"
                        className={cn(
                          'channel-dialog-reaction-popover__action',
                          'channel-dialog-reaction-popover__action--reply',
                        )}
                        onClick={() => handleReply(activeMessage)}
                      >
                        <ReplyArrowIcon />
                        Ответить
                      </button>

                      <button
                        type="button"
                        className={cn(
                          'channel-dialog-reaction-popover__toggle',
                          isReactionPickerExpanded && 'is-active',
                        )}
                        onClick={() => setIsReactionPickerExpanded((current) => !current)}
                        aria-label="Показать больше реакций"
                      >
                        <PlusIcon />
                      </button>
                    </div>
                  </div>

                  {isReactionPickerExpanded ? (
                    <div className="channel-dialog-reaction-popover__grid">
                      {COMMENT_REACTION_EXPANDED_OPTIONS.map((emoji) => {
                        const reactedByMe = activeMessage.reactionGroups.some(
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
                              handleReactionToggle(activeMessage.id, emoji, {
                                closePicker: true,
                              })
                            }
                            disabled={reactionMutation.isPending}
                            aria-label={`Поставить реакцию ${emoji}`}
                          >
                            {emoji}
                          </button>
                        );
                      })}
                    </div>
                  ) : null}

                </div>
              </div>
            </div>,
            screenRef.current ?? document.body,
          )
        : null}
    </div>
  );
}
