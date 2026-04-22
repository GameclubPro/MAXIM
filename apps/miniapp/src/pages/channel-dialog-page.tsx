import type {
  ChannelDialogAttachment,
  ChannelDialogMessage,
  ChannelDialogResponse,
  ChannelDialogType,
} from '@maxim/contracts';
import {
  MAX_CHANNEL_DIALOG_ATTACHMENTS,
  MAX_CHANNEL_DIALOG_ATTACHMENTS_TOTAL_BASE64,
  MAX_CHANNEL_DIALOG_COMMENT_FILES,
} from '@maxim/contracts';
import {
  Attachment as IconoirAttachment,
  BubbleStar as IconoirBubbleStar,
  Camera as IconoirCamera,
  ChatLines as IconoirChatLines,
  ClockRotateRight as IconoirClockRotateRight,
  EmojiSatisfied as IconoirEmojiSatisfied,
  Heart as IconoirHeart,
  MessageText as IconoirMessageText,
  Microphone as IconoirMicrophone,
  MultiBubble as IconoirMultiBubble,
  Pin as IconoirPin,
  SendDiagonal as IconoirSendDiagonal,
  Sparks as IconoirSparks,
  Star as IconoirStar,
} from 'iconoir-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ChangeEvent as ReactChangeEvent,
  type FormEvent as ReactFormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type UIEvent as ReactUIEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { StatusState } from '../components/ui/status-state';
import { useToast } from '../components/ui/toast';
import { isSessionExpiredApiMessage, isTerminalDialogApiMessage } from '../lib/api-error';
import {
  createChatDialogMessage,
  createChannelDialogMessage,
  deleteChatDialogMessage,
  deleteChannelDialogMessage,
  getChatDialog,
  getChannelDialog,
  getChannelSuggestionRedirect,
  updateChatDialogMessage,
  updateChannelDialogMessage,
  toggleChannelDialogReaction,
  toggleChatDialogReaction,
} from '../lib/api/channel-dialog-client';
import { createDialogBrowserHandoff } from '../lib/api/dialog-browser-handoff-client';
import type { ApiTransport } from '../lib/api/transport';
import { cn } from '../lib/cn';
import {
  PREVIEW_CHANNEL_ID,
  PREVIEW_CHANNEL_TITLE,
  PREVIEW_CHAT_ID,
  PREVIEW_CHAT_TITLE,
} from '../lib/design-preview';
import {
  formatDialogAttachmentSize,
  prepareCommentDialogFileAttachment,
  prepareCommentDialogImageAttachment,
  type PreparedCommentDialogAttachment,
} from '../lib/dialog-attachments';
import { readChatTitle } from '../lib/chat-titles';
import { openFileInputPicker, resolveFileInputActivationMode } from '../lib/file-input-picker';
import { getInitDataUserId } from '../lib/init-data';
import { buildManagedEntitiesRoute, saveLastEntityId, type LastEntityType } from '../lib/last-chat';
import {
  maxImpact,
  maxSelectionChanged,
  openMaxBotLink,
  openMaxBotLinkAndClose,
} from '../lib/max-bridge';

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

type CommentBackdropIconName =
  | 'conversation'
  | 'message'
  | 'typing'
  | 'reaction'
  | 'heart'
  | 'sparkles'
  | 'paperclip'
  | 'pin'
  | 'smile'
  | 'star'
  | 'camera'
  | 'clock'
  | 'microphone'
  | 'send';

type CommentBackdropTone = 'accent' | 'soft' | 'faint';
type AttachmentInputKind = 'image' | 'file';

type CommentBackdropWallpaperTile = {
  icon: CommentBackdropIconName;
  id: string;
  offsetY?: number;
  rotate: number;
  scale?: number;
  tone: CommentBackdropTone;
};

type CommentBackdropWallpaperRow = {
  id: string;
  shift: 'left' | 'right';
  tiles: CommentBackdropWallpaperTile[];
};

const COMMENT_BACKDROP_STROKE = 1.46;

const COMMENT_BACKDROP_WALLPAPER_ROWS = [
  {
    id: 'row-1',
    shift: 'left',
    tiles: [
      { id: 'spark-1', icon: 'sparkles', tone: 'soft', rotate: -8, scale: 0.98, offsetY: -3 },
      { id: 'msg-1', icon: 'message', tone: 'accent', rotate: 6, scale: 1.04, offsetY: 8 },
      { id: 'heart-1', icon: 'heart', tone: 'soft', rotate: -7, scale: 0.92, offsetY: -6 },
      { id: 'cam-1', icon: 'camera', tone: 'faint', rotate: 5, scale: 0.98, offsetY: 7 },
    ],
  },
  {
    id: 'row-2',
    shift: 'right',
    tiles: [
      { id: 'paper-1', icon: 'paperclip', tone: 'faint', rotate: -10, scale: 0.96, offsetY: 5 },
      { id: 'send-1', icon: 'send', tone: 'soft', rotate: 11, scale: 0.98, offsetY: -5 },
      { id: 'smile-1', icon: 'smile', tone: 'accent', rotate: -4, scale: 0.94, offsetY: 4 },
      { id: 'star-1', icon: 'star', tone: 'faint', rotate: 9, scale: 0.88, offsetY: -7 },
    ],
  },
  {
    id: 'row-3',
    shift: 'left',
    tiles: [
      {
        id: 'conversation-1',
        icon: 'conversation',
        tone: 'soft',
        rotate: -6,
        scale: 1.04,
        offsetY: -8,
      },
      { id: 'microphone-1', icon: 'microphone', tone: 'faint', rotate: 8, scale: 0.9, offsetY: 6 },
      { id: 'typing-1', icon: 'typing', tone: 'accent', rotate: -5, scale: 1, offsetY: -4 },
      { id: 'pin-1', icon: 'pin', tone: 'faint', rotate: 10, scale: 0.9, offsetY: 7 },
    ],
  },
  {
    id: 'row-4',
    shift: 'right',
    tiles: [
      { id: 'clock-1', icon: 'clock', tone: 'faint', rotate: -6, scale: 0.92, offsetY: 6 },
      { id: 'heart-2', icon: 'heart', tone: 'soft', rotate: 7, scale: 0.94, offsetY: -5 },
      { id: 'message-2', icon: 'message', tone: 'soft', rotate: -8, scale: 1, offsetY: 5 },
      { id: 'camera-2', icon: 'camera', tone: 'faint', rotate: 8, scale: 0.96, offsetY: -6 },
    ],
  },
  {
    id: 'row-5',
    shift: 'left',
    tiles: [
      { id: 'send-2', icon: 'send', tone: 'soft', rotate: -11, scale: 1.02, offsetY: -4 },
      { id: 'spark-2', icon: 'sparkles', tone: 'faint', rotate: 7, scale: 0.9, offsetY: 8 },
      { id: 'paper-2', icon: 'paperclip', tone: 'accent', rotate: -9, scale: 0.96, offsetY: -7 },
      { id: 'smile-2', icon: 'smile', tone: 'soft', rotate: 6, scale: 0.92, offsetY: 4 },
    ],
  },
  {
    id: 'row-6',
    shift: 'right',
    tiles: [
      { id: 'reaction-1', icon: 'reaction', tone: 'soft', rotate: 8, scale: 1.02, offsetY: 5 },
      {
        id: 'microphone-2',
        icon: 'microphone',
        tone: 'faint',
        rotate: -8,
        scale: 0.92,
        offsetY: -6,
      },
      { id: 'star-2', icon: 'star', tone: 'faint', rotate: 11, scale: 0.86, offsetY: 7 },
      {
        id: 'conversation-2',
        icon: 'conversation',
        tone: 'accent',
        rotate: -7,
        scale: 1.02,
        offsetY: -5,
      },
    ],
  },
  {
    id: 'row-7',
    shift: 'left',
    tiles: [
      { id: 'clock-2', icon: 'clock', tone: 'faint', rotate: 6, scale: 0.94, offsetY: -7 },
      { id: 'heart-3', icon: 'heart', tone: 'accent', rotate: -7, scale: 0.92, offsetY: 5 },
      { id: 'typing-2', icon: 'typing', tone: 'soft', rotate: 4, scale: 0.98, offsetY: -3 },
      { id: 'camera-3', icon: 'camera', tone: 'faint', rotate: -9, scale: 0.96, offsetY: 8 },
    ],
  },
  {
    id: 'row-8',
    shift: 'right',
    tiles: [
      { id: 'paper-3', icon: 'paperclip', tone: 'faint', rotate: 10, scale: 0.94, offsetY: 7 },
      { id: 'send-3', icon: 'send', tone: 'accent', rotate: -11, scale: 1, offsetY: -6 },
      { id: 'smile-3', icon: 'smile', tone: 'soft', rotate: 5, scale: 0.92, offsetY: 5 },
      { id: 'reaction-2', icon: 'reaction', tone: 'soft', rotate: -7, scale: 1.04, offsetY: -4 },
    ],
  },
  {
    id: 'row-9',
    shift: 'left',
    tiles: [
      { id: 'message-3', icon: 'message', tone: 'soft', rotate: -6, scale: 1.02, offsetY: 6 },
      { id: 'spark-3', icon: 'sparkles', tone: 'faint', rotate: 8, scale: 0.88, offsetY: -8 },
      { id: 'microphone-3', icon: 'microphone', tone: 'faint', rotate: -9, scale: 0.9, offsetY: 7 },
      { id: 'pin-2', icon: 'pin', tone: 'soft', rotate: 11, scale: 0.88, offsetY: -5 },
    ],
  },
] satisfies CommentBackdropWallpaperRow[];

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

function hasCommentAttachments(
  attachments: ChannelDialogAttachment[] | PreparedCommentDialogAttachment[] | null | undefined,
): boolean {
  return Array.isArray(attachments) && attachments.length > 0;
}

function resolveCommentAttachmentSummary(
  attachments: Pick<ChannelDialogAttachment, 'kind' | 'fileName'>[] | null | undefined,
): string {
  if (!attachments?.length) {
    return '';
  }

  const imageCount = attachments.filter((attachment) => attachment.kind === 'image').length;
  const files = attachments.filter((attachment) => attachment.kind === 'file');

  if (imageCount > 0 && files.length === 0) {
    if (imageCount > 1) {
      return `Фото · ${imageCount}`;
    }
    const fileName = attachments.find((attachment) => attachment.kind === 'image')?.fileName?.trim();
    return fileName ? `Фото · ${fileName}` : 'Фото';
  }

  if (files.length > 0 && imageCount === 0) {
    if (files.length > 1) {
      return `Файлы · ${files.length}`;
    }
    const fileName = files[0]?.fileName?.trim();
    return fileName ? `Файл · ${fileName}` : 'Файл';
  }

  return `Вложения · ${attachments.length}`;
}

function getCommentAttachmentOpenUrl(attachment: ChannelDialogAttachment): string {
  const remoteUrl = attachment.url?.trim() ?? '';
  if (remoteUrl) {
    return remoteUrl;
  }

  return attachment.kind === 'image' ? attachment.previewUrl?.trim() ?? '' : '';
}

function getCommentAttachmentPreviewUrl(attachment: ChannelDialogAttachment): string {
  return attachment.previewUrl?.trim() || attachment.url?.trim() || '';
}

function getCommentAttachmentImageStyle(
  attachment: Pick<ChannelDialogAttachment, 'width' | 'height'>,
): CSSProperties | undefined {
  if (!attachment.width || !attachment.height) {
    return undefined;
  }

  return {
    aspectRatio: `${attachment.width} / ${attachment.height}`,
  };
}

function calculateDraftAttachmentsBase64Length(
  attachments: PreparedCommentDialogAttachment[],
): number {
  return attachments.reduce((total, attachment) => total + attachment.base64.length, 0);
}

function resolveMessageWidthTone(
  message: ChannelDialogMessage,
): 'is-wide' | 'is-medium' | 'is-compact' {
  if (message.attachments.length > 0) {
    return 'is-wide';
  }

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

function resolveSuggestionStatus(message: ChannelDialogMessage): SuggestionStatusPresentation {
  if (message.reviewStatus === 'published') {
    return {
      badge: 'Опубликовано',
      headline: 'Пост вышел в канале',
      note: 'Редактор взял предложку в публикацию.',
      tone: 'published',
    };
  }

  if (message.reviewStatus === 'cancelled') {
    return {
      badge: 'Отклонено',
      headline: 'Идея не ушла в публикацию',
      note: 'Можно доработать и отправить заново.',
      tone: 'cancelled',
    };
  }

  if (message.delivered === false) {
    return {
      badge: 'Не доставлено',
      headline: 'Редакторы пока не получили материал',
      note: 'Материал сохранён. Для правок или дополнений отправьте новую предложку.',
      tone: 'pending',
    };
  }

  return {
    badge: 'На проверке',
    headline: 'Материал ушёл редакторам',
    note: 'Бот уже отправил предложку админам. Дополнения после отправки идут новой предложкой.',
    tone: 'pending',
  };
}

function resolveSuggestionText(message: ChannelDialogMessage): string {
  const normalized = message.text.trim();
  if (normalized) {
    return normalized;
  }

  if (message.hasVideo && !message.hasImage) {
    return 'Предложение отправлено только с видео.';
  }

  const imageCount = Math.max(
    message.imageCount ?? 0,
    message.imageFileNames?.length ?? 0,
    message.imageFileName ? 1 : 0,
  );
  if (imageCount > 1) {
    return `Предложение отправлено с ${imageCount} фото.`;
  }

  if (message.hasImage && !message.hasVideo) {
    return 'Предложение отправлено только с фото.';
  }

  return 'Предложение отправлено только с медиа.';
}

function resolveSuggestionAttachmentLabel(message: ChannelDialogMessage): string {
  if (message.hasVideo) {
    const fileName = message.videoFileName?.trim();
    return fileName ? `Видео · ${fileName}` : 'Видео приложено';
  }

  const imageCount = Math.max(
    message.imageCount ?? 0,
    message.imageFileNames?.length ?? 0,
    message.imageFileName ? 1 : 0,
  );
  if (imageCount > 1) {
    return `Фото · ${imageCount} шт.`;
  }

  const fileName = message.imageFileName?.trim();
  return fileName ? `Фото · ${fileName}` : 'Фото приложено';
}

function renderPlainTextParagraphs(text: string) {
  const normalized = text.replace(/\r\n?/gu, '\n').trim();
  if (!normalized) {
    return null;
  }

  return normalized.split(/\n{2,}/u).map((paragraph, paragraphIndex) => (
    <p key={`paragraph-${paragraphIndex}`}>
      {paragraph.split('\n').map((line, lineIndex) => (
        <Fragment key={lineIndex}>
          {lineIndex > 0 ? <br /> : null}
          {line}
        </Fragment>
      ))}
    </p>
  ));
}

const SUGGEST_INTRO_STYLE: CSSProperties = {
  display: 'grid',
  gap: '8px',
  padding: '14px 14px 16px',
  borderRadius: '22px',
  borderColor: 'rgba(255, 233, 217, 0.96)',
  background: 'rgba(255, 249, 244, 0.96)',
  boxShadow: '0 16px 34px rgba(181, 99, 47, 0.08)',
};

const SUGGEST_INTRO_EYEBROW_STYLE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  width: 'fit-content',
  minHeight: '28px',
  padding: '0 11px',
  borderRadius: '999px',
  background: 'rgba(255, 122, 61, 0.12)',
  color: 'rgba(163, 74, 20, 0.9)',
  fontSize: '0.69rem',
  fontWeight: 900,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
};

const SUGGEST_INTRO_TITLE_STYLE: CSSProperties = {
  fontSize: '0.98rem',
  lineHeight: '1.16',
  letterSpacing: '-0.02em',
  color: 'rgba(41, 28, 18, 0.92)',
};

const SUGGEST_BADGES_ROW_STYLE: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '8px',
};

const SUGGEST_BADGE_STYLE: CSSProperties = {
  minHeight: '26px',
  padding: '0 10px',
  borderRadius: '999px',
  background: 'rgba(255, 255, 255, 0.78)',
  color: 'rgba(88, 57, 32, 0.78)',
  display: 'inline-flex',
  alignItems: 'center',
  fontSize: '0.7rem',
  fontWeight: 800,
};

const SUGGEST_CARD_STYLE: CSSProperties = {
  display: 'grid',
  gap: '10px',
  minWidth: 0,
  padding: '14px',
  borderRadius: '22px',
  border: '1px solid rgba(255, 236, 224, 0.98)',
  background: 'rgba(255, 250, 246, 0.98)',
  boxShadow: '0 14px 30px rgba(181, 99, 47, 0.08)',
};

const SUGGEST_CARD_HEAD_STYLE: CSSProperties = {
  display: 'grid',
  gap: '8px',
};

const SUGGEST_CARD_ROW_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '10px',
  flexWrap: 'wrap',
};

const SUGGEST_CARD_EYEBROW_STYLE: CSSProperties = {
  color: 'rgba(120, 74, 43, 0.72)',
  fontSize: '0.72rem',
  fontWeight: 800,
  letterSpacing: '0.02em',
  textTransform: 'uppercase',
};

const SUGGEST_CARD_TIME_STYLE: CSSProperties = {
  minHeight: '28px',
  padding: '0 10px',
  borderRadius: '999px',
  background: 'rgba(255, 255, 255, 0.84)',
  color: 'rgba(104, 77, 58, 0.66)',
  display: 'inline-flex',
  alignItems: 'center',
  fontSize: '0.72rem',
  fontWeight: 800,
};

const SUGGEST_CARD_TITLE_STYLE: CSSProperties = {
  fontSize: '0.96rem',
  lineHeight: '1.2',
  color: 'rgba(35, 28, 23, 0.92)',
};

const SUGGEST_CARD_TEXT_STYLE: CSSProperties = {
  margin: 0,
  color: 'rgba(33, 27, 24, 0.88)',
  lineHeight: '1.46',
  whiteSpace: 'pre-wrap',
};

const SUGGEST_CARD_MUTED_TEXT_STYLE: CSSProperties = {
  color: 'rgba(94, 70, 54, 0.64)',
  fontStyle: 'italic',
};

const SUGGEST_CARD_ATTACHMENT_STYLE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '8px',
  width: 'fit-content',
  maxWidth: '100%',
  minHeight: '36px',
  padding: '0 12px',
  borderRadius: '16px',
  border: '1px solid rgba(236, 194, 162, 0.66)',
  background: 'rgba(255, 248, 242, 0.88)',
  color: 'rgba(96, 64, 43, 0.8)',
  fontSize: '0.78rem',
  fontWeight: 700,
};

const SUGGEST_CARD_ATTACHMENT_BADGE_STYLE: CSSProperties = {
  minHeight: '24px',
  padding: '0 8px',
  borderRadius: '999px',
  background: 'rgba(255, 122, 61, 0.12)',
  color: 'rgba(163, 74, 20, 0.9)',
  display: 'inline-flex',
  alignItems: 'center',
  fontSize: '0.68rem',
  fontWeight: 900,
  letterSpacing: '0.03em',
  textTransform: 'uppercase',
};

const SUGGEST_CARD_NOTE_STYLE: CSSProperties = {
  color: 'rgba(94, 70, 54, 0.7)',
  fontSize: '0.74rem',
  lineHeight: '1.34',
};

const SUGGEST_CARD_LINK_STYLE: CSSProperties = {
  minHeight: '34px',
  padding: '0 14px',
  borderRadius: '999px',
  background: 'color-mix(in srgb, var(--dialog-accent) 16%, white)',
  color: 'color-mix(in srgb, var(--dialog-accent) 76%, black)',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  textDecoration: 'none',
  fontSize: '0.76rem',
  fontWeight: 900,
  letterSpacing: '0.01em',
};

const SUGGEST_EMPTY_STYLE: CSSProperties = {
  display: 'grid',
  gap: '6px',
  textAlign: 'left',
  padding: '18px',
};

const SUGGEST_EMPTY_TITLE_STYLE: CSSProperties = {
  color: 'rgba(35, 28, 23, 0.9)',
  fontSize: '0.96rem',
};

const SUGGEST_EMPTY_COPY_STYLE: CSSProperties = {
  margin: 0,
  color: 'rgba(94, 70, 54, 0.72)',
  fontSize: '0.84rem',
  lineHeight: '1.45',
  fontWeight: 500,
};

function buildSuggestionStatusStyle(tone: SuggestionStatusPresentation['tone']): CSSProperties {
  const baseStyle: CSSProperties = {
    minHeight: '30px',
    padding: '0 11px',
    borderRadius: '999px',
    display: 'inline-flex',
    alignItems: 'center',
    fontSize: '0.74rem',
    fontWeight: 900,
    letterSpacing: '0.01em',
  };

  if (tone === 'published') {
    return {
      ...baseStyle,
      color: '#127456',
      background: 'rgba(31, 169, 126, 0.14)',
    };
  }

  if (tone === 'cancelled') {
    return {
      ...baseStyle,
      color: '#9a3448',
      background: 'rgba(214, 91, 120, 0.14)',
    };
  }

  return {
    ...baseStyle,
    color: '#9a5a14',
    background: 'rgba(240, 164, 43, 0.15)',
  };
}

function buildSwipeReplyStyle(
  preview: SwipeReplyPreview | null,
  messageId: string,
): CSSProperties | undefined {
  if (!preview || preview.messageId !== messageId) {
    return undefined;
  }

  return {
    '--channel-dialog-swipe-offset': `${preview.offset}px`,
    '--channel-dialog-swipe-progress': `${preview.progress}`,
  } as CSSProperties;
}

function buildAdminBubbleStyle(isAdmin: boolean, isOwnMessage: boolean): CSSProperties | undefined {
  if (!isAdmin) {
    return undefined;
  }

  if (isOwnMessage) {
    return {
      background: 'linear-gradient(160deg, rgba(255, 238, 198, 0.92), rgba(255, 247, 228, 0.88))',
      borderColor: 'rgba(225, 178, 89, 0.3)',
    };
  }

  return {
    background: 'linear-gradient(180deg, rgba(255, 249, 234, 0.88), rgba(255, 244, 218, 0.8))',
    borderColor: 'rgba(224, 180, 96, 0.28)',
  };
}

function buildAdminAuthorStyle(isAdmin: boolean): CSSProperties | undefined {
  if (!isAdmin) {
    return undefined;
  }

  return {
    color: '#8d661f',
  };
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

  const previousMessageIndex = messages.findIndex(
    (message) => message.id === previousLastMessageId,
  );
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

function removeDialogMessage(
  dialog: ChannelDialogResponse | undefined,
  messageId: string,
): ChannelDialogResponse | undefined {
  if (!dialog) {
    return dialog;
  }

  return {
    ...dialog,
    messages: dialog.messages.filter((item) => item.id !== messageId),
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

function CommentAttachmentGlyph({ kind }: { kind: 'image' | 'file' }) {
  return kind === 'image' ? (
    <IconoirCamera aria-hidden focusable="false" />
  ) : (
    <IconoirAttachment aria-hidden focusable="false" />
  );
}

function CommentMessageAttachments({
  attachments,
}: {
  attachments: ChannelDialogAttachment[];
}) {
  if (!attachments.length) {
    return null;
  }

  const imageAttachments = attachments.filter((attachment) => attachment.kind === 'image');
  const fileAttachments = attachments.filter((attachment) => attachment.kind === 'file');

  return (
    <div className="channel-dialog-message__attachments">
      {imageAttachments.length > 0 ? (
        <div className="channel-dialog-message__image-grid">
          {imageAttachments.map((attachment, attachmentIndex) => {
            const url = getCommentAttachmentOpenUrl(attachment);
            const previewUrl = getCommentAttachmentPreviewUrl(attachment);
            const fileName = attachment.fileName?.trim() || `Фото ${attachmentIndex + 1}`;

            return (
              <button
                key={`${fileName}-${attachmentIndex}`}
                type="button"
                className="channel-dialog-message__image-tile"
                style={getCommentAttachmentImageStyle(attachment)}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  if (url) {
                    openMaxBotLink(url);
                  }
                }}
                disabled={!url}
                aria-label={fileName}
              >
                {previewUrl ? (
                  <img src={previewUrl} alt="" loading="lazy" />
                ) : (
                  <CommentAttachmentGlyph kind="image" />
                )}
              </button>
            );
          })}
        </div>
      ) : null}

      {fileAttachments.length > 0 ? (
        <div className="channel-dialog-message__file-list">
          {fileAttachments.map((attachment, attachmentIndex) => {
            const url = getCommentAttachmentOpenUrl(attachment);
            const fileName = attachment.fileName?.trim() || `Файл ${attachmentIndex + 1}`;
            const meta = attachment.size ? formatDialogAttachmentSize(attachment.size) : 'Открыть';

            return (
              <button
                key={`${fileName}-${attachmentIndex}`}
                type="button"
                className="channel-dialog-message__file-pill"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  if (url) {
                    openMaxBotLink(url);
                  }
                }}
                disabled={!url}
                aria-label={fileName}
              >
                <span className="channel-dialog-message__file-pill-icon" aria-hidden>
                  <CommentAttachmentGlyph kind="file" />
                </span>
                <span className="channel-dialog-message__file-pill-copy">
                  <strong>{fileName}</strong>
                  <span>{meta}</span>
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
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
      <path d="M5.5 5.5L14.5 14.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M14.5 5.5L5.5 14.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
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
      <path d="M10 4.5V15.5" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
      <path d="M4.5 10H15.5" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
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

function EditIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden focusable="false">
      <path
        d="M4.7 15.3L7.2 14.7L14.6 7.3C15 6.9 15 6.2 14.6 5.8L13.9 5.1C13.5 4.7 12.8 4.7 12.4 5.1L5 12.5L4.7 15.3Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M11.6 5.9L13.8 8.1"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden focusable="false">
      <path
        d="M5.8 6.4L6.4 14.2C6.5 15.1 7.2 15.8 8.1 15.8H11.9C12.8 15.8 13.5 15.1 13.6 14.2L14.2 6.4"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M4.8 5.2H15.2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path
        d="M8.1 5.2V4.6C8.1 4.2 8.4 3.9 8.8 3.9H11.2C11.6 3.9 11.9 4.2 11.9 4.6V5.2"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M8.7 8.3V13" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M11.3 8.3V13" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

function ConversationStackOutlineIcon() {
  return <IconoirMultiBubble strokeWidth={COMMENT_BACKDROP_STROKE} aria-hidden focusable="false" />;
}

function MessageBubbleOutlineIcon() {
  return <IconoirMessageText strokeWidth={COMMENT_BACKDROP_STROKE} aria-hidden focusable="false" />;
}

function SoftHeartOutlineIcon() {
  return <IconoirHeart strokeWidth={COMMENT_BACKDROP_STROKE} aria-hidden focusable="false" />;
}

function SparklesOutlineIcon() {
  return <IconoirSparks strokeWidth={COMMENT_BACKDROP_STROKE} aria-hidden focusable="false" />;
}

function TypingBubbleOutlineIcon() {
  return <IconoirChatLines strokeWidth={COMMENT_BACKDROP_STROKE} aria-hidden focusable="false" />;
}

function ReactionPillOutlineIcon() {
  return <IconoirBubbleStar strokeWidth={COMMENT_BACKDROP_STROKE} aria-hidden focusable="false" />;
}

function PaperclipOutlineIcon() {
  return <IconoirAttachment strokeWidth={COMMENT_BACKDROP_STROKE} aria-hidden focusable="false" />;
}

function PinOutlineIcon() {
  return <IconoirPin strokeWidth={COMMENT_BACKDROP_STROKE} aria-hidden focusable="false" />;
}

function SmileOutlineIcon() {
  return (
    <IconoirEmojiSatisfied strokeWidth={COMMENT_BACKDROP_STROKE} aria-hidden focusable="false" />
  );
}

function StarOutlineIcon() {
  return <IconoirStar strokeWidth={COMMENT_BACKDROP_STROKE} aria-hidden focusable="false" />;
}

function CameraOutlineIcon() {
  return <IconoirCamera strokeWidth={COMMENT_BACKDROP_STROKE} aria-hidden focusable="false" />;
}

function ClockOutlineIcon() {
  return (
    <IconoirClockRotateRight strokeWidth={COMMENT_BACKDROP_STROKE} aria-hidden focusable="false" />
  );
}

function MicrophoneOutlineIcon() {
  return <IconoirMicrophone strokeWidth={COMMENT_BACKDROP_STROKE} aria-hidden focusable="false" />;
}

function SendOutlineIcon() {
  return (
    <IconoirSendDiagonal strokeWidth={COMMENT_BACKDROP_STROKE} aria-hidden focusable="false" />
  );
}

function CommentBackdropIcon({ name }: { name: CommentBackdropIconName }) {
  switch (name) {
    case 'conversation':
      return <ConversationStackOutlineIcon />;
    case 'message':
      return <MessageBubbleOutlineIcon />;
    case 'typing':
      return <TypingBubbleOutlineIcon />;
    case 'reaction':
      return <ReactionPillOutlineIcon />;
    case 'heart':
      return <SoftHeartOutlineIcon />;
    case 'sparkles':
      return <SparklesOutlineIcon />;
    case 'paperclip':
      return <PaperclipOutlineIcon />;
    case 'pin':
      return <PinOutlineIcon />;
    case 'smile':
      return <SmileOutlineIcon />;
    case 'star':
      return <StarOutlineIcon />;
    case 'camera':
      return <CameraOutlineIcon />;
    case 'clock':
      return <ClockOutlineIcon />;
    case 'microphone':
      return <MicrophoneOutlineIcon />;
    case 'send':
      return <SendOutlineIcon />;
    default:
      return null;
  }
}

function CommentBackdropOrnaments() {
  return (
    <div className="channel-dialog-screen__wallpaper" aria-hidden>
      {COMMENT_BACKDROP_WALLPAPER_ROWS.map((row) => (
        <div
          key={row.id}
          className={cn(
            'channel-dialog-screen__wallpaper-row',
            row.shift === 'left' && 'is-shift-left',
            row.shift === 'right' && 'is-shift-right',
          )}
        >
          {row.tiles.map((tile) => (
            <span
              key={tile.id}
              className={cn(
                'channel-dialog-screen__wallpaper-tile',
                tile.tone === 'accent' && 'is-accent',
                tile.tone === 'soft' && 'is-soft',
                tile.tone === 'faint' && 'is-faint',
              )}
              style={
                {
                  '--channel-dialog-wallpaper-offset-y': `${tile.offsetY ?? 0}px`,
                  '--channel-dialog-wallpaper-rotation': `${tile.rotate}deg`,
                  '--channel-dialog-wallpaper-scale': `${tile.scale ?? 1}`,
                } as CSSProperties
              }
            >
              <CommentBackdropIcon name={tile.icon} />
            </span>
          ))}
        </div>
      ))}
    </div>
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

type EditRestoreState = {
  draft: string;
  replyToMessageId: string | null;
  draftAttachments: PreparedCommentDialogAttachment[];
};

type SwipeReplyGesture = {
  messageId: string;
  startX: number;
  startY: number;
  isOwn: boolean;
  engaged: boolean;
  armed: boolean;
};

type CommentDraftAttachment = PreparedCommentDialogAttachment;

type SuggestionStatusPresentation = {
  badge: string;
  headline: string;
  note: string;
  tone: 'pending' | 'published' | 'cancelled';
};

function buildViewModel(dialogType: ChannelDialogType): DialogViewModel {
  if (dialogType === 'suggest') {
    return {
      title: 'Предложить пост',
      placeholder: 'Текст идеи или подпись к фото',
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
  const { chatId = '' } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token')?.trim() ?? '';
  const dialogType: ChannelDialogType = 'comments';
  const entityType = resolveDialogEntityType(location.pathname);
  const [draft, setDraft] = useState('');
  const [draftAttachments, setDraftAttachments] = useState<CommentDraftAttachment[]>([]);
  const [activeMessageId, setActiveMessageId] = useState<string | null>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editRestoreState, setEditRestoreState] = useState<EditRestoreState | null>(null);
  const [replyToMessageId, setReplyToMessageId] = useState<string | null>(null);
  const [isReactionPickerExpanded, setIsReactionPickerExpanded] = useState(false);
  const [isNearBottom, setIsNearBottom] = useState(true);
  const [firstUnreadMessageId, setFirstUnreadMessageId] = useState<string | null>(null);
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  const [terminalDialogError, setTerminalDialogError] = useState<string | null>(null);
  const [swipeReplyPreview, setSwipeReplyPreview] = useState<SwipeReplyPreview | null>(null);
  const [isPreparingAttachment, setIsPreparingAttachment] = useState(false);
  const [floatingThreadContextHeight, setFloatingThreadContextHeight] = useState(0);
  const [reactionPopoverLayout, setReactionPopoverLayout] = useState<ReactionPopoverLayout | null>(
    null,
  );
  const composeFieldRef = useRef<HTMLTextAreaElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const screenRef = useRef<HTMLDivElement | null>(null);
  const scrollViewportRef = useRef<HTMLElement | null>(null);
  const floatingThreadContextRef = useRef<HTMLDivElement | null>(null);
  const reactionPopoverRef = useRef<HTMLDivElement | null>(null);
  const lastMessageIdRef = useRef<string | null>(null);
  const highlightTimerRef = useRef<number | null>(null);
  const pressTimerRef = useRef<number | null>(null);
  const pressPointRef = useRef<{ x: number; y: number } | null>(null);
  const swipeReplyGestureRef = useRef<SwipeReplyGesture | null>(null);
  const attachmentInputWatchCleanupRef = useRef<
    Record<AttachmentInputKind, (() => void) | null>
  >({
    image: null,
    file: null,
  });
  const lastHandledAttachmentSelectionRef = useRef<Record<AttachmentInputKind, string | null>>({
    image: null,
    file: null,
  });
  const messageNodeRefs = useRef(new Map<string, HTMLElement>());
  const messageLayoutContextRef = useRef<string | null>(null);
  const messageRectsRef = useRef(new Map<string, DOMRect>());
  const ignoreNextBubbleClickRef = useRef(false);
  const launchErrorRedirectedRef = useRef(false);
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const fileInputActivationMode = resolveFileInputActivationMode(
    typeof document === 'undefined' ? undefined : document.documentElement.dataset.maxPlatform,
  );
  const useNativeTapFileInputs = fileInputActivationMode === 'native-tap';

  const currentUserId = useMemo(() => getInitDataUserId(), []);
  const dialogQueryKey = ['entity-dialog', entityType, chatId, dialogType, token] as const;

  useEffect(() => {
    if (chatId) {
      saveLastEntityId(entityType, chatId);
    }
  }, [chatId, entityType]);

  const dialogQuery = useQuery({
    queryKey: dialogQueryKey,
    queryFn: ({ signal }) =>
      entityType === 'channel'
        ? getChannelDialog(api, chatId, dialogType, token, { signal })
        : getChatDialog(api, chatId, dialogType, token, { signal }),
    enabled: Boolean(chatId && token) && terminalDialogError === null,
    retry: (failureCount, error) =>
      !isTerminalDialogApiMessage(normalizeApiError(error)) && failureCount < 1,
    refetchOnWindowFocus: terminalDialogError === null,
    retryOnMount: terminalDialogError === null,
    refetchInterval: (query) => {
      const message = query.state.error ? normalizeApiError(query.state.error) : '';
      if (message && isTerminalDialogApiMessage(message)) {
        return false;
      }

      return 8_000;
    },
  });

  useEffect(() => {
    if (launchErrorRedirectedRef.current) {
      return;
    }

    const message = dialogQuery.error ? normalizeApiError(dialogQuery.error) : '';
    if (!message || !isTerminalDialogApiMessage(message)) {
      return;
    }

    launchErrorRedirectedRef.current = true;
    setTerminalDialogError(message);
    void queryClient.cancelQueries({ queryKey: dialogQueryKey });
    pushToast({
      tone: 'info',
      title: isSessionExpiredApiMessage(message)
        ? 'Откройте мини-приложение заново'
        : 'Диалог недоступен',
      description: message,
      durationMs: 4_000,
    });
    navigate(buildManagedEntitiesRoute(entityType), { replace: true });
  }, [
    dialogQuery.error,
    dialogQueryKey,
    entityType,
    navigate,
    pushToast,
    queryClient,
  ]);

  const messages = dialogQuery.data?.messages ?? [];
  const introText = dialogQuery.data?.introText?.trim() ?? '';
  const floatingThreadContextOffset = introText
    ? Math.max(96, (floatingThreadContextHeight > 0 ? floatingThreadContextHeight : 0) + 18)
    : 0;
  const dialogBodyStyle = introText
    ? ({
        '--channel-dialog-thread-context-offset': `${floatingThreadContextOffset}px`,
      } as CSSProperties)
    : undefined;
  const messageIdSet = useMemo(() => new Set(messages.map((message) => message.id)), [messages]);
  const activeMessage = useMemo(
    () => messages.find((message) => message.id === activeMessageId) ?? null,
    [activeMessageId, messages],
  );
  const editingMessage = useMemo(
    () => messages.find((message) => message.id === editingMessageId) ?? null,
    [editingMessageId, messages],
  );
  const replyTarget = useMemo(
    () => messages.find((message) => message.id === replyToMessageId) ?? null,
    [messages, replyToMessageId],
  );
  const draftLength = draft.trim().length;
  const draftAttachmentCount = draftAttachments.length;
  const editingAttachmentCount = editingMessage?.attachments.length ?? 0;
  const showComposeMeta =
    draftLength > 0 ||
    draftAttachmentCount > 0 ||
    editingAttachmentCount > 0 ||
    Boolean(replyTarget) ||
    Boolean(editingMessage);
  const canSubmitMessage =
    !isPreparingAttachment && (draftLength > 0 || draftAttachmentCount > 0 || editingAttachmentCount > 0);
  const activeMessageIsOwn = activeMessage ? currentUserId === activeMessage.authorUserId : false;
  const unreadStartIndex = useMemo(
    () =>
      firstUnreadMessageId
        ? messages.findIndex((message) => message.id === firstUnreadMessageId)
        : -1,
    [firstUnreadMessageId, messages],
  );
  const unreadCount = unreadStartIndex >= 0 ? messages.length - unreadStartIndex : 0;
  const showJumpToLatest = unreadCount > 0 && !isNearBottom;
  const draftAttachmentSummary = useMemo(
    () =>
      resolveCommentAttachmentSummary(
        draftAttachments.map((attachment) => ({
          kind: attachment.type,
          fileName: attachment.fileName,
        })),
      ),
    [draftAttachments],
  );
  const editingAttachmentSummary = useMemo(
    () => resolveCommentAttachmentSummary(editingMessage?.attachments),
    [editingMessage?.attachments],
  );
  const composeMetaLabel = isPreparingAttachment
    ? 'Готовим вложения'
    : editingMessage
      ? editingAttachmentSummary || 'Изменение сохранится для всех участников треда'
      : draftAttachmentSummary;
  const useAndroidBrowserUploadFlow =
    dialogType === 'comments' && useNativeTapFileInputs && !editingMessage;

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

  const resetAttachmentPickers = () => {
    attachmentInputWatchCleanupRef.current.image?.();
    attachmentInputWatchCleanupRef.current.file?.();
    attachmentInputWatchCleanupRef.current.image = null;
    attachmentInputWatchCleanupRef.current.file = null;
    lastHandledAttachmentSelectionRef.current.image = null;
    lastHandledAttachmentSelectionRef.current.file = null;
    if (imageInputRef.current) {
      imageInputRef.current.value = '';
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
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

  const cancelEditing = (options?: { restoreDraft?: boolean }) => {
    if (options?.restoreDraft && editRestoreState) {
      setDraft(editRestoreState.draft);
      setReplyToMessageId(editRestoreState.replyToMessageId);
      setDraftAttachments(editRestoreState.draftAttachments);
    } else {
      setDraft('');
      setReplyToMessageId(null);
      setDraftAttachments([]);
    }

    setEditingMessageId(null);
    setEditRestoreState(null);
    resetAttachmentPickers();
  };

  useEffect(() => {
    clearMessagePress();
    clearSwipeReplyGesture();
    clearSourceHighlight();
    setActiveMessageId(null);
    setEditingMessageId(null);
    setEditRestoreState(null);
    setReplyToMessageId(null);
    setIsReactionPickerExpanded(false);
    setIsNearBottom(true);
    setFirstUnreadMessageId(null);
    setTerminalDialogError(null);
    setReactionPopoverLayout(null);
    setDraft('');
    setDraftAttachments([]);
    setIsPreparingAttachment(false);
    lastMessageIdRef.current = null;
    messageNodeRefs.current.clear();
    messageLayoutContextRef.current = null;
    messageRectsRef.current.clear();
    ignoreNextBubbleClickRef.current = false;
    resetAttachmentPickers();
  }, [chatId, dialogType, entityType, token]);

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
  }, [draft, editingMessage, replyTarget, draftAttachments.length]);

  useLayoutEffect(() => {
    if (typeof window === 'undefined' || !introText) {
      setFloatingThreadContextHeight(0);
      return;
    }

    const node = floatingThreadContextRef.current;
    if (!node) {
      setFloatingThreadContextHeight(0);
      return;
    }

    const measure = () => {
      setFloatingThreadContextHeight(Math.ceil(node.getBoundingClientRect().height));
    };

    measure();
    const observer =
      typeof ResizeObserver === 'function' ? new ResizeObserver(() => measure()) : null;
    observer?.observe(node);
    window.addEventListener('resize', measure);

    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [introText]);

  useEffect(
    () => () => {
      attachmentInputWatchCleanupRef.current.image?.();
      attachmentInputWatchCleanupRef.current.file?.();
      attachmentInputWatchCleanupRef.current.image = null;
      attachmentInputWatchCleanupRef.current.file = null;
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
      } else {
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
  }, [messages]);

  useEffect(() => {
    if (replyToMessageId && !messages.some((message) => message.id === replyToMessageId)) {
      setReplyToMessageId(null);
    }

    if (editingMessageId && !messages.some((message) => message.id === editingMessageId)) {
      setEditingMessageId(null);
      setEditRestoreState(null);
      setDraft('');
      setDraftAttachments([]);
      resetAttachmentPickers();
    }

    if (activeMessageId && !messages.some((message) => message.id === activeMessageId)) {
      setActiveMessageId(null);
      setIsReactionPickerExpanded(false);
      setReactionPopoverLayout(null);
    }

    if (
      swipeReplyPreview &&
      !messages.some((message) => message.id === swipeReplyPreview.messageId)
    ) {
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
    editingMessageId,
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
    if (!activeMessageId) {
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
      const nextLeft = Math.max(
        12,
        Math.min(unclampedLeft, screenRect.width - availableWidth - 12),
      );

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
  }, [activeMessageId, activeMessageIsOwn, isReactionPickerExpanded]);

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
      const composeSurface = document.querySelector<HTMLElement>(
        '.channel-dialog-compose__surface',
      );
      const header = document.querySelector<HTMLElement>('.channel-dialog-comments-header');
      const composeHeight = composeSurface?.getBoundingClientRect().height ?? 0;
      const headerHeight = header?.getBoundingClientRect().height ?? 0;
      const popoverHeight = reactionPopoverRef.current?.getBoundingClientRect().height ?? 0;
      const desiredTopInset =
        14 +
        (reactionPopoverLayout?.placement === 'above'
          ? headerHeight + popoverHeight + 10
          : headerHeight);
      const desiredBottomInset =
        composeHeight +
        20 +
        (reactionPopoverLayout?.placement === 'below' ? popoverHeight + 10 : 0);

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

  const appendDraftAttachments = (nextAttachments: CommentDraftAttachment[]) => {
    if (nextAttachments.length === 0) {
      return;
    }

    setDraftAttachments((current) => {
      const merged = [...current, ...nextAttachments];
      if (merged.length > MAX_CHANNEL_DIALOG_ATTACHMENTS) {
        pushToast({
          tone: 'danger',
          title: 'Слишком много вложений',
          description: `Можно добавить до ${MAX_CHANNEL_DIALOG_ATTACHMENTS} вложений.`,
        });
        return current;
      }

      const fileCount = merged.filter((attachment) => attachment.type === 'file').length;
      if (fileCount > MAX_CHANNEL_DIALOG_COMMENT_FILES) {
        pushToast({
          tone: 'danger',
          title: 'Слишком много файлов',
          description: `Можно прикрепить до ${MAX_CHANNEL_DIALOG_COMMENT_FILES} файлов.`,
        });
        return current;
      }

      const totalBase64Length = calculateDraftAttachmentsBase64Length(merged);
      if (totalBase64Length > MAX_CHANNEL_DIALOG_ATTACHMENTS_TOTAL_BASE64) {
        pushToast({
          tone: 'danger',
          title: 'Вложения слишком тяжёлые',
          description: 'Уберите часть файлов или фото и попробуйте снова.',
        });
        return current;
      }

      maxSelectionChanged();
      return merged;
    });
  };

  const buildAttachmentSelectionSignature = (files: File[]): string =>
    files
      .map((file) => [file.name, file.size, file.type, file.lastModified].join(':'))
      .join('|');

  const prepareDraftAttachmentsFromFiles = async (kind: AttachmentInputKind, files: File[]) => {
    if (files.length === 0 || editingMessage) {
      resetAttachmentPickers();
      return;
    }

    setIsPreparingAttachment(true);
    try {
      const prepared: CommentDraftAttachment[] = [];
      let firstError: string | null = null;

      for (const file of files) {
        try {
          prepared.push(
            kind === 'image'
              ? await prepareCommentDialogImageAttachment(file)
              : await prepareCommentDialogFileAttachment(file),
          );
        } catch (error: unknown) {
          if (!firstError && error instanceof Error && error.message.trim()) {
            firstError = error.message;
          } else if (!firstError) {
            firstError =
              kind === 'image' ? 'Не удалось подготовить фото.' : 'Не удалось подготовить файл.';
          }
        }
      }

      if (prepared.length > 0) {
        appendDraftAttachments(prepared);
      }

      if (firstError) {
        pushToast({
          tone: 'danger',
          title: kind === 'image' ? 'Фото не добавлено' : 'Файл не добавлен',
          description: firstError,
        });
      }
    } catch (error: unknown) {
      pushToast({
        tone: 'danger',
        title: kind === 'image' ? 'Фото не добавлено' : 'Файл не добавлен',
        description:
          error instanceof Error && error.message.trim()
            ? error.message
            : kind === 'image'
              ? 'Не удалось подготовить фото.'
              : 'Не удалось подготовить файл.',
      });
    } finally {
      resetAttachmentPickers();
      setIsPreparingAttachment(false);
    }
  };

  const handleDraftAttachmentInputSelection = (
    kind: AttachmentInputKind,
    input: HTMLInputElement | null,
  ): boolean => {
    const files = Array.from(input?.files ?? []);
    if (files.length === 0) {
      return false;
    }

    const signature = buildAttachmentSelectionSignature(files);
    if (lastHandledAttachmentSelectionRef.current[kind] === signature) {
      attachmentInputWatchCleanupRef.current[kind]?.();
      attachmentInputWatchCleanupRef.current[kind] = null;
      return true;
    }

    lastHandledAttachmentSelectionRef.current[kind] = signature;
    attachmentInputWatchCleanupRef.current[kind]?.();
    attachmentInputWatchCleanupRef.current[kind] = null;
    void prepareDraftAttachmentsFromFiles(kind, files);
    return true;
  };

  const armAttachmentInputWatcher = (
    kind: AttachmentInputKind,
    input: HTMLInputElement | null,
  ) => {
    attachmentInputWatchCleanupRef.current[kind]?.();
    attachmentInputWatchCleanupRef.current[kind] = null;

    if (typeof window === 'undefined' || typeof document === 'undefined' || !input || input.disabled) {
      return;
    }

    const timeoutIds = new Set<number>();
    const scheduleDrain = (delays: number[]) => {
      for (const delay of delays) {
        const timeoutId = window.setTimeout(() => {
          timeoutIds.delete(timeoutId);
          handleDraftAttachmentInputSelection(kind, input);
        }, delay);
        timeoutIds.add(timeoutId);
      }
    };

    const handleFocus = () => {
      scheduleDrain([80, 320, 900]);
    };
    const handleVisibilityChange = () => {
      if (!document.hidden) {
        scheduleDrain([80, 320, 900]);
      }
    };

    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    scheduleDrain([1600, 4200, 8200]);

    attachmentInputWatchCleanupRef.current[kind] = () => {
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      for (const timeoutId of timeoutIds) {
        window.clearTimeout(timeoutId);
      }
      timeoutIds.clear();
    };
  };

  const handleDraftImagesChange = (event: ReactChangeEvent<HTMLInputElement>) => {
    handleDraftAttachmentInputSelection('image', event.currentTarget);
  };

  const handleDraftFilesChange = (event: ReactChangeEvent<HTMLInputElement>) => {
    handleDraftAttachmentInputSelection('file', event.currentTarget);
  };

  const handleDraftImagesInput = (event: ReactFormEvent<HTMLInputElement>) => {
    handleDraftAttachmentInputSelection('image', event.currentTarget);
  };

  const handleDraftFilesInput = (event: ReactFormEvent<HTMLInputElement>) => {
    handleDraftAttachmentInputSelection('file', event.currentTarget);
  };

  const handleDraftAttachmentRemove = (index: number) => {
    setDraftAttachments((current) => current.filter((_, attachmentIndex) => attachmentIndex !== index));
    maxSelectionChanged();
    resetAttachmentPickers();
  };

  const sendMutation = useMutation({
    mutationFn: (payload: { text: string; attachments: CommentDraftAttachment[] }) =>
      entityType === 'channel'
        ? createChannelDialogMessage(api, chatId, dialogType, {
            token,
            text: payload.text,
            replyToMessageId,
            attachments: payload.attachments.map((attachment) => ({
              type: attachment.type,
              base64: attachment.base64,
              mimeType: attachment.mimeType,
              fileName: attachment.fileName,
              ...(attachment.width ? { width: attachment.width } : {}),
              ...(attachment.height ? { height: attachment.height } : {}),
            })),
          })
        : createChatDialogMessage(api, chatId, dialogType, {
            token,
            text: payload.text,
            replyToMessageId,
            attachments: payload.attachments.map((attachment) => ({
              type: attachment.type,
              base64: attachment.base64,
              mimeType: attachment.mimeType,
              fileName: attachment.fileName,
              ...(attachment.width ? { width: attachment.width } : {}),
              ...(attachment.height ? { height: attachment.height } : {}),
            })),
          }),
    onSuccess: (result) => {
      queryClient.setQueryData<ChannelDialogResponse | undefined>(dialogQueryKey, (current) =>
        updateDialogMessage(current, result.message),
      );
      pushToast({
        tone: 'success',
        title: 'Готово',
        description: 'Комментарий отправлен.',
      });
      setDraft('');
      setReplyToMessageId(null);
      setDraftAttachments([]);
      resetAttachmentPickers();
      dismissMessageActions();
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

  const browserHandoffMutation = useMutation({
    mutationFn: () =>
      createDialogBrowserHandoff(api, entityType, chatId, dialogType, {
        token,
        text: draft,
        replyToMessageId,
      }),
    onSuccess: (result) => {
      if (!result.browserUrl.trim()) {
        pushToast({
          tone: 'danger',
          title: 'Не удалось открыть браузер',
          description: 'Ссылка на браузерную загрузку вернулась пустой.',
        });
        return;
      }

      openMaxBotLinkAndClose(result.browserUrl);
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось открыть браузер',
        description: normalizeApiError(error),
      });
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ messageId, text }: { messageId: string; text: string }) =>
      entityType === 'channel'
        ? updateChannelDialogMessage(api, chatId, dialogType, messageId, {
            token,
            text,
          })
        : updateChatDialogMessage(api, chatId, dialogType, messageId, {
            token,
            text,
          }),
    onSuccess: (result) => {
      queryClient.setQueryData<ChannelDialogResponse | undefined>(dialogQueryKey, (current) =>
        updateDialogMessage(current, result.message),
      );
      pushToast({
        tone: 'success',
        title: 'Готово',
        description: 'Комментарий обновлён.',
      });
      cancelEditing();
      dismissMessageActions();
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

  const deleteMutation = useMutation({
    mutationFn: ({ messageId }: { messageId: string; deletedByAdmin: boolean }) =>
      entityType === 'channel'
        ? deleteChannelDialogMessage(api, chatId, dialogType, messageId, {
            token,
          })
        : deleteChatDialogMessage(api, chatId, dialogType, messageId, {
            token,
          }),
    onSuccess: (result, variables) => {
      queryClient.setQueryData<ChannelDialogResponse | undefined>(dialogQueryKey, (current) =>
        removeDialogMessage(current, result.deletedMessageId),
      );
      pushToast({
        tone: 'success',
        title: 'Готово',
        description: variables.deletedByAdmin
          ? 'Комментарий удалён администратором.'
          : 'Комментарий удалён.',
      });
      if (editingMessageId === variables.messageId) {
        cancelEditing();
      }
      dismissMessageActions();
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
      const previousDialog = queryClient.getQueryData<ChannelDialogResponse | undefined>(
        dialogQueryKey,
      );
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

  const isComposePending = sendMutation.isPending || updateMutation.isPending;
  const isAttachmentActionPending =
    isComposePending || isPreparingAttachment || browserHandoffMutation.isPending;
  const isCommentActionPending =
    reactionMutation.isPending || updateMutation.isPending || deleteMutation.isPending;

  const openMessageActions = (
    messageId: string,
    options?: {
      haptic?: 'light' | 'medium';
      toggle?: boolean;
    },
  ) => {
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
      if (event.pointerType === 'mouse') {
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

    const target = event.currentTarget.ownerDocument.defaultView;
    if (target?.matchMedia('(pointer: coarse)').matches) {
      return;
    }

    openMessageActions(messageId);
  };

  const handleBubbleKeyDown =
    (messageId: string) => (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'Enter' && event.key !== ' ') {
        return;
      }

      event.preventDefault();
      openMessageActions(messageId);
    };

  const handleBubbleContextMenu =
    (messageId: string) => (event: ReactMouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      ignoreNextBubbleClickRef.current = true;
      openMessageActions(messageId, {
        haptic: 'medium',
        toggle: false,
      });
    };

  const handleReply = (message: ChannelDialogMessage) => {
    maxImpact('soft');
    setEditingMessageId(null);
    setEditRestoreState(null);
    setDraft('');
    setDraftAttachments([]);
    setReplyToMessageId(message.id);
    dismissMessageActions();
    resetAttachmentPickers();
    requestAnimationFrame(() => composeFieldRef.current?.focus());
  };

  const handleStartEditing = (message: ChannelDialogMessage) => {
    if (!message.canEdit) {
      return;
    }

    maxImpact('soft');
    setEditRestoreState(
      (current) =>
        current ?? {
          draft,
          replyToMessageId,
          draftAttachments,
        },
    );
    setReplyToMessageId(null);
    setEditingMessageId(message.id);
    setDraft(message.text);
    setDraftAttachments([]);
    dismissMessageActions();
    resetAttachmentPickers();
    requestAnimationFrame(() => composeFieldRef.current?.focus());
  };

  const handleDelete = (message: ChannelDialogMessage) => {
    if (deleteMutation.isPending || (!message.canDelete && !message.canDeleteAsAdmin)) {
      return;
    }

    const confirmationText =
      message.canDeleteAsAdmin && !message.canDelete
        ? 'Удалить чужой комментарий как администратор?'
        : 'Удалить комментарий?';
    if (typeof window !== 'undefined' && !window.confirm(confirmationText)) {
      return;
    }

    maxImpact('medium');
    deleteMutation.mutate({
      messageId: message.id,
      deletedByAdmin: message.canDeleteAsAdmin && !message.canDelete,
    });
  };

  const handleReactionToggle = (
    messageId: string,
    emoji: string,
    options?: {
      closePicker?: boolean;
    },
  ) => {
    if (isCommentActionPending) {
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
    const composeSurface = screenRef.current?.querySelector<HTMLElement>(
      '.channel-dialog-compose__surface',
    );
    const composeHeight = composeSurface?.getBoundingClientRect().height ?? 0;
    const topInset = introText ? Math.max(18, floatingThreadContextOffset + 4) : 18;
    const bottomInset = composeHeight + 22;
    const availableHeight = Math.max(140, viewport.clientHeight - topInset - bottomInset);
    const desiredTop =
      viewport.scrollTop +
      (targetRect.top - viewportRect.top) -
      topInset -
      Math.max(0, (availableHeight - targetRect.height) / 2);
    const nextTop = Math.max(
      0,
      Math.min(desiredTop, viewport.scrollHeight - viewport.clientHeight),
    );

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

  const handleJumpToSource = (messageId: string) => (event: ReactMouseEvent<HTMLButtonElement>) => {
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
    if (isComposePending || !chatId || !token) {
      return;
    }

    if (editingMessage) {
      if (!text && editingMessage.attachments.length === 0) {
        return;
      }

      if (text === editingMessage.text.trim()) {
        cancelEditing({ restoreDraft: true });
        return;
      }

      updateMutation.mutate({
        messageId: editingMessage.id,
        text,
      });
      return;
    }

    if (!text && draftAttachments.length === 0) {
      return;
    }

    sendMutation.mutate({
      text,
      attachments: draftAttachments,
    });
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
      <div className="channel-dialog-screen__backdrop" aria-hidden>
        {dialogType === 'comments' ? <CommentBackdropOrnaments /> : null}
      </div>

      <div className="channel-dialog-shell">
        {introText ? (
          <div
            ref={floatingThreadContextRef}
            className="channel-dialog-thread-context channel-dialog-thread-context--floating"
          >
            <p>{introText}</p>
          </div>
        ) : null}

        <section
          ref={scrollViewportRef}
          className={cn('channel-dialog-body', introText && 'has-floating-thread-context')}
          style={dialogBodyStyle}
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
              {messages.length ? (
                messages.map((message, index) => {
                  const isOwnMessage = currentUserId === message.authorUserId;
                  const isAdminMessage = message.isAdmin === true;
                  const groupedWithPrevious = isGroupedWithPrevious(messages, index);
                  const isActiveMessage = activeMessageId === message.id;
                  const messageWidthTone = resolveMessageWidthTone(message);
                  const replySourceMessageId =
                    message.replyTo?.messageId ?? message.replyToMessageId ?? null;
                  const canJumpToReplySource = Boolean(
                    replySourceMessageId && messageIdSet.has(replySourceMessageId),
                  );
                  const isReactionPending = isCommentActionPending;

                  return (
                    <Fragment key={message.id}>
                      {unreadStartIndex === index ? (
                        <div className="channel-dialog-new-comments" aria-label="Новые комментарии">
                          <span className="channel-dialog-new-comments__pill">
                            Новые комментарии
                          </span>
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
                            messageWidthTone,
                            swipeReplyPreview?.messageId === message.id && 'is-swipe-active',
                            swipeReplyPreview?.messageId === message.id &&
                              swipeReplyPreview.armed &&
                              'is-swipe-armed',
                            isActiveMessage && 'is-context-open',
                          )}
                          data-message-id={message.id}
                          style={buildSwipeReplyStyle(swipeReplyPreview, message.id)}
                        >
                          <div className="channel-dialog-message__swipe-indicator" aria-hidden>
                            <span className="channel-dialog-message__swipe-indicator-icon">
                              <ReplyArrowIcon />
                            </span>
                          </div>

                          <div
                            className={cn(
                              'channel-dialog-message__stack',
                              swipeReplyPreview?.messageId === message.id && 'is-swipe-active',
                            )}
                          >
                            <div
                              className={cn(
                                'channel-dialog-message__bubble',
                                'is-selectable',
                                isActiveMessage && 'is-active',
                                groupedWithPrevious && 'is-grouped',
                              )}
                              data-message-bubble-id={message.id}
                              style={buildAdminBubbleStyle(isAdminMessage, isOwnMessage)}
                              onClick={handleBubbleClick(message.id)}
                              onKeyDown={handleBubbleKeyDown(message.id)}
                              onPointerDown={handleBubblePointerDown(message, isOwnMessage)}
                              onPointerMove={handleBubblePointerMove(message, isOwnMessage)}
                              onPointerUp={handleBubblePointerUp(message)}
                              onPointerCancel={handleBubblePointerCancel}
                              onContextMenu={handleBubbleContextMenu(message.id)}
                              role="button"
                              tabIndex={0}
                              aria-pressed={isActiveMessage}
                              aria-haspopup="dialog"
                            >
                              {!groupedWithPrevious ? (
                                <div className="channel-dialog-message__meta">
                                  <strong style={buildAdminAuthorStyle(isAdminMessage)}>
                                    {getAuthorLabel(message)}
                                  </strong>
                                  <time dateTime={message.createdAt}>
                                    {formatMessageTime(message.createdAt)}
                                    {message.editedAt ? ' · ред.' : ''}
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
                                    <span>
                                      {message.replyTo.authorDisplayName || 'Комментарий'}
                                    </span>
                                    <p>{summarizeReplyText(message.replyTo.text)}</p>
                                  </button>
                                ) : (
                                  <div className="channel-dialog-message__reply">
                                    <span>
                                      {message.replyTo.authorDisplayName || 'Комментарий'}
                                    </span>
                                    <p>{summarizeReplyText(message.replyTo.text)}</p>
                                  </div>
                                )
                              ) : null}

                              <CommentMessageAttachments attachments={message.attachments} />
                              {renderPlainTextParagraphs(message.text)}
                            </div>

                            {message.reactionGroups.length > 0 ? (
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
            {editingMessage ? (
              <div className={cn('channel-dialog-compose__reply', 'is-editing')}>
                <button
                  type="button"
                  className={cn('channel-dialog-compose__reply-copy', 'is-link')}
                  onClick={() => scrollToMessage(editingMessage.id)}
                >
                  <span>Редактирование комментария</span>
                  <p>
                    {summarizeReplyText(
                      editingMessage.text || editingAttachmentSummary || 'Комментарий',
                      84,
                    )}
                  </p>
                </button>
                <button
                  type="button"
                  className="channel-dialog-compose__reply-dismiss"
                  onClick={() => cancelEditing({ restoreDraft: true })}
                  aria-label="Отменить редактирование"
                >
                  <CloseIcon />
                </button>
              </div>
            ) : replyTarget ? (
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

            {editingMessage?.attachments.length ? (
              editingMessage.attachments.map((attachment, attachmentIndex) => (
                <div
                  key={`editing-attachment-${attachmentIndex}`}
                  className="channel-dialog-compose__attachment"
                >
                  <div className="channel-dialog-compose__attachment-preview" aria-hidden>
                    {attachment.kind === 'image' && getCommentAttachmentPreviewUrl(attachment) ? (
                      <img src={getCommentAttachmentPreviewUrl(attachment)} alt="" loading="lazy" />
                    ) : (
                      <CommentAttachmentGlyph kind={attachment.kind} />
                    )}
                  </div>
                  <div className="channel-dialog-compose__attachment-copy">
                    <strong>{attachment.kind === 'image' ? 'Фото' : 'Файл'}</strong>
                    <span>
                      {attachment.fileName?.trim() ||
                        resolveCommentAttachmentSummary([attachment]) ||
                        'Вложение'}
                    </span>
                  </div>
                </div>
              ))
            ) : !editingMessage && draftAttachments.length > 0 ? (
              draftAttachments.map((attachment, attachmentIndex) => (
                <div
                  key={`draft-attachment-${attachmentIndex}`}
                  className="channel-dialog-compose__attachment"
                >
                  <div className="channel-dialog-compose__attachment-preview" aria-hidden>
                    {attachment.type === 'image' && attachment.previewUrl ? (
                      <img src={attachment.previewUrl} alt="" loading="lazy" />
                    ) : (
                      <CommentAttachmentGlyph kind={attachment.type} />
                    )}
                  </div>
                  <div className="channel-dialog-compose__attachment-copy">
                    <strong>{attachment.type === 'image' ? 'Фото' : 'Файл'}</strong>
                    <span>
                      {[attachment.fileName, formatDialogAttachmentSize(attachment.size)]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="channel-dialog-compose__attachment-dismiss"
                    onClick={() => handleDraftAttachmentRemove(attachmentIndex)}
                    aria-label={`Убрать ${attachment.fileName || 'вложение'}`}
                  >
                    <CloseIcon />
                  </button>
                </div>
              ))
            ) : null}

            {showComposeMeta ? (
              <div
                className={cn(
                  'channel-dialog-compose__meta',
                  !composeMetaLabel && 'channel-dialog-compose__meta--solo',
                )}
              >
                {composeMetaLabel ? <span>{composeMetaLabel}</span> : null}
                <span>{draftLength}/2000</span>
              </div>
            ) : null}

            <div className="channel-dialog-compose__row">
              {!editingMessage ? (
                <div className="channel-dialog-compose__quick-actions">
                  {useAndroidBrowserUploadFlow ? (
                    <>
                      <button
                        type="button"
                        className={cn(
                          'channel-dialog-compose__attach',
                          'channel-dialog-compose__attach--icon',
                          isAttachmentActionPending && 'channel-dialog-compose__attach--disabled',
                        )}
                        aria-label="Добавить фото"
                        aria-disabled={isAttachmentActionPending}
                        disabled={isAttachmentActionPending}
                        onClick={() => browserHandoffMutation.mutate()}
                      >
                        <IconoirCamera aria-hidden focusable="false" />
                      </button>
                      <button
                        type="button"
                        className={cn(
                          'channel-dialog-compose__attach',
                          'channel-dialog-compose__attach--icon',
                          isAttachmentActionPending && 'channel-dialog-compose__attach--disabled',
                        )}
                        aria-label="Прикрепить файл"
                        aria-disabled={isAttachmentActionPending}
                        disabled={isAttachmentActionPending}
                        onClick={() => browserHandoffMutation.mutate()}
                      >
                        <IconoirAttachment aria-hidden focusable="false" />
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        className={cn(
                          'channel-dialog-compose__attach',
                          'channel-dialog-compose__attach--icon',
                          (isComposePending || isPreparingAttachment) &&
                            'channel-dialog-compose__attach--disabled',
                          draftAttachments.some((attachment) => attachment.type === 'image') &&
                            'is-active',
                        )}
                        aria-label="Добавить фото"
                        aria-disabled={isComposePending || isPreparingAttachment}
                        disabled={isComposePending || isPreparingAttachment}
                        onClick={() => {
                          armAttachmentInputWatcher('image', imageInputRef.current);
                          openFileInputPicker(imageInputRef.current);
                        }}
                      >
                        <IconoirCamera aria-hidden focusable="false" />
                      </button>
                      <input
                        ref={imageInputRef}
                        className="channel-dialog-compose__picker-input"
                        type="file"
                        accept="image/*"
                        disabled={isComposePending || isPreparingAttachment}
                        onChange={handleDraftImagesChange}
                        onInput={handleDraftImagesInput}
                        tabIndex={-1}
                      />
                      <button
                        type="button"
                        className={cn(
                          'channel-dialog-compose__attach',
                          'channel-dialog-compose__attach--icon',
                          (isComposePending || isPreparingAttachment) &&
                            'channel-dialog-compose__attach--disabled',
                          draftAttachments.some((attachment) => attachment.type === 'file') &&
                            'is-active',
                        )}
                        aria-label="Прикрепить файл"
                        aria-disabled={isComposePending || isPreparingAttachment}
                        disabled={isComposePending || isPreparingAttachment}
                        onClick={() => {
                          armAttachmentInputWatcher('file', fileInputRef.current);
                          openFileInputPicker(fileInputRef.current);
                        }}
                      >
                        <IconoirAttachment aria-hidden focusable="false" />
                      </button>
                      <input
                        ref={fileInputRef}
                        className="channel-dialog-compose__picker-input"
                        type="file"
                        disabled={isComposePending || isPreparingAttachment}
                        onChange={handleDraftFilesChange}
                        onInput={handleDraftFilesInput}
                        tabIndex={-1}
                      />
                    </>
                  )}
                </div>
              ) : null}

              <label className="channel-dialog-compose__field">
                <textarea
                  ref={composeFieldRef}
                  rows={1}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder={
                    editingMessage
                      ? editingMessage.attachments.length > 0 && !editingMessage.text.trim()
                        ? 'Добавить подпись'
                        : 'Изменить комментарий'
                      : replyTarget
                        ? 'Ответить на комментарий'
                        : 'Комментарий'
                  }
                  maxLength={2_000}
                />
              </label>

              <div className="channel-dialog-compose__actions">
                <button
                  type="button"
                  className="channel-dialog-submit"
                  onClick={onSubmit}
                  disabled={!canSubmitMessage || isComposePending}
                  aria-label={
                    editingMessage
                      ? updateMutation.isPending
                        ? 'Сохранение'
                        : 'Сохранить'
                      : sendMutation.isPending
                        ? 'Отправка'
                        : 'Отправить'
                  }
                >
                  {isComposePending ? (
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
                            disabled={isCommentActionPending}
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
                        disabled={isCommentActionPending}
                      >
                        <ReplyArrowIcon />
                        Ответить
                      </button>

                      {activeMessage.canEdit ? (
                        <button
                          type="button"
                          className="channel-dialog-reaction-popover__action"
                          onClick={() => handleStartEditing(activeMessage)}
                          disabled={isCommentActionPending}
                        >
                          <EditIcon />
                          Изменить
                        </button>
                      ) : null}

                      {activeMessage.canDelete || activeMessage.canDeleteAsAdmin ? (
                        <button
                          type="button"
                          className={cn(
                            'channel-dialog-reaction-popover__action',
                            'channel-dialog-reaction-popover__action--danger',
                          )}
                          onClick={() => handleDelete(activeMessage)}
                          disabled={isCommentActionPending}
                        >
                          <TrashIcon />
                          Удалить
                        </button>
                      ) : null}

                      <button
                        type="button"
                        className={cn(
                          'channel-dialog-reaction-popover__toggle',
                          isReactionPickerExpanded && 'is-active',
                        )}
                        onClick={() => setIsReactionPickerExpanded((current) => !current)}
                        disabled={isCommentActionPending}
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
                            disabled={isCommentActionPending}
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
