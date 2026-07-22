import type {
  ChannelDialogMessage,
  ChannelDialogResponse,
  CreateChannelDialogMessageResponse,
} from '@maxim/contracts/channel-dialog';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Attachment as IconoirAttachment,
  Bold as IconoirBold,
  Camera as IconoirCamera,
  Code as IconoirCode,
  Italic as IconoirItalic,
  Link as IconoirLink,
  SendDiagonalSolid as IconoirSend,
  Strikethrough as IconoirStrikethrough,
  Type as IconoirType,
  Underline as IconoirUnderline,
  Xmark as IconoirXmark,
} from 'iconoir-react';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent as ReactChangeEvent,
  type FormEvent as ReactFormEvent,
} from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  MAX_MARKDOWN_TOOL_DEFINITIONS,
  type MaxMarkdownTool,
} from '../components/max-markdown-editor';
import { MaxMarkdownPreview } from '../components/max-markdown-preview';
import {
  MaxRichTextEditor,
  type MaxRichTextEditorHandle,
} from '../components/max-rich-text-editor';
import { StatusState } from '../components/ui/status-state';
import { useToast } from '../components/ui/toast';
import { isSessionExpiredApiMessage, isTerminalDialogApiMessage } from '../lib/api-error';
import type { ApiTransport } from '../lib/api/transport';
import { cn } from '../lib/cn';
import type { PreparedCommentDialogAttachment } from '../lib/dialog-attachments';
import { openFileInputPicker, resolveFileInputActivationMode } from '../lib/file-input-picker';
import { buildManagedEntitiesRoute, saveLastEntityId } from '../lib/last-chat';
import { maxSelectionChanged } from '../lib/max-bridge';
import { queryKeys } from '../lib/query-keys';
import '../styles/channel-dialog-suggest.css';

const SUGGEST_DRAFT_MAX_LENGTH = 2_000;
const ATTACHMENT_SELECTION_DEDUPE_MS = 2_500;
const MAX_SUGGEST_IMAGES = 10;
const MAX_SUGGEST_IMAGE_BASE64_LENGTH = 8_000_000;
const MAX_SUGGEST_ATTACHMENTS_TOTAL_BASE64 = 24_000_000;

type SuggestDraftAttachment = PreparedCommentDialogAttachment;

type PreparingImageState = {
  total: number;
  done: number;
};

type SuggestionStatusPresentation = {
  badge: string;
  headline: string;
  note: string;
  tone: 'pending' | 'published' | 'cancelled';
};

type CreateChannelSuggestMessagePayload = {
  token: string;
  text: string;
  textFormat: 'markdown';
  images: Array<{
    base64: string;
    mimeType: string;
    fileName: string;
  }>;
};

async function getChannelSuggestDialog(
  api: ApiTransport,
  chatId: string,
  token: string,
  request: Pick<RequestInit, 'signal'> = {},
): Promise<ChannelDialogResponse> {
  const response = await api.request(
    `/channels/${chatId}/dialog/suggest?token=${encodeURIComponent(token)}`,
    request,
  );
  return response as ChannelDialogResponse;
}

async function createChannelSuggestDialogMessage(
  api: ApiTransport,
  chatId: string,
  payload: CreateChannelSuggestMessagePayload,
): Promise<CreateChannelDialogMessageResponse> {
  const response = await api.request(`/channels/${chatId}/dialog/suggest/messages`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return response as CreateChannelDialogMessageResponse;
}

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

function calculateDraftAttachmentsBase64Length(attachments: SuggestDraftAttachment[]): number {
  return attachments.reduce((total, attachment) => total + attachment.base64.length, 0);
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
      badge: 'Отправлено',
      headline: 'Предложка отправлена',
      note: 'Материал сохранён и ожидает обработки. Для правок или дополнений отправьте новую предложку.',
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

function getDraftImagePreviewUrl(attachment: SuggestDraftAttachment): string {
  return attachment.previewUrl?.trim() || '';
}

function buildAttachmentSelectionSignature(files: File[]): string {
  return files
    .map((file) => [file.name, file.size, file.type, file.lastModified].join(':'))
    .join('|');
}

function SuggestMarkdownToolIcon({ tool }: { tool: MaxMarkdownTool }) {
  switch (tool) {
    case 'heading':
      return <IconoirType aria-hidden focusable="false" />;
    case 'bold':
      return <IconoirBold aria-hidden focusable="false" />;
    case 'italic':
      return <IconoirItalic aria-hidden focusable="false" />;
    case 'underline':
      return <IconoirUnderline aria-hidden focusable="false" />;
    case 'strike':
      return <IconoirStrikethrough aria-hidden focusable="false" />;
    case 'code':
      return <IconoirCode aria-hidden focusable="false" />;
    case 'link':
      return <IconoirLink aria-hidden focusable="false" />;
  }
}

function SuggestComposeImageGrid({
  attachments,
  preparingCount = 0,
  busy = false,
  onRemove,
}: {
  attachments: SuggestDraftAttachment[];
  preparingCount?: number;
  busy?: boolean;
  onRemove: (index: number) => void;
}) {
  const cappedPreparingCount = Math.max(
    0,
    Math.min(preparingCount, MAX_SUGGEST_IMAGES - attachments.length),
  );

  if (!attachments.length && cappedPreparingCount <= 0) {
    return null;
  }

  const visibleCount = Math.min(attachments.length + cappedPreparingCount, MAX_SUGGEST_IMAGES);

  return (
    <div
      className={cn(
        'channel-suggest-composer__image-grid',
        `is-count-${visibleCount}`,
        busy && 'is-busy',
      )}
      role="list"
      aria-label={`Фото: ${visibleCount}`}
    >
      {attachments.map((attachment, attachmentIndex) => {
        const previewUrl = getDraftImagePreviewUrl(attachment);
        const fileName = attachment.fileName?.trim() || `Фото ${attachmentIndex + 1}`;

        return (
          <div
            key={`${fileName}-${attachmentIndex}`}
            className={cn('channel-suggest-composer__image-tile', busy && 'is-uploading')}
            role="listitem"
            aria-label={fileName}
          >
            {previewUrl ? (
              <img src={previewUrl} alt={fileName} loading="lazy" />
            ) : (
              <IconoirCamera aria-hidden focusable="false" />
            )}

            <button
              type="button"
              className="channel-suggest-composer__image-remove"
              onClick={() => onRemove(attachmentIndex)}
              aria-label={`Убрать ${fileName}`}
            >
              <IconoirXmark aria-hidden focusable="false" />
            </button>
          </div>
        );
      })}
      {Array.from({ length: cappedPreparingCount }, (_, index) => (
        <div
          key={`preparing-${index}`}
          className="channel-suggest-composer__image-tile is-loading"
          role="listitem"
          aria-label="Готовим фото"
        >
          <span className="channel-suggest-composer__image-loader" aria-hidden>
            <IconoirCamera aria-hidden focusable="false" />
          </span>
        </div>
      ))}
    </div>
  );
}

function SuggestionRequirements({ text }: { text: string }) {
  const paragraphs = text
    .split(/\n{2,}/u)
    .map((line) => line.trim())
    .filter(Boolean);

  if (paragraphs.length === 0) {
    return null;
  }

  return (
    <section className="channel-suggest-requirements" aria-label="Требования">
      <span className="channel-suggest-requirements__label">Требования</span>
      <div className="channel-suggest-requirements__text">
        {paragraphs.map((paragraph, index) => (
          <p key={`${paragraph}-${index}`}>{paragraph}</p>
        ))}
      </div>
    </section>
  );
}

export function ChannelSuggestDialogPage({ api }: { api: ApiTransport }) {
  const { chatId = '' } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token')?.trim() ?? '';
  const [draft, setDraft] = useState('');
  const [draftAttachments, setDraftAttachments] = useState<SuggestDraftAttachment[]>([]);
  const [preparingImageState, setPreparingImageState] = useState<PreparingImageState | null>(null);
  const [terminalDialogError, setTerminalDialogError] = useState<string | null>(null);
  const screenRef = useRef<HTMLDivElement | null>(null);
  const scrollViewportRef = useRef<HTMLElement | null>(null);
  const suggestComposerRef = useRef<HTMLElement | null>(null);
  const suggestBarRef = useRef<HTMLDivElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const richTextEditorRef = useRef<MaxRichTextEditorHandle | null>(null);
  const attachmentInputWatchCleanupRef = useRef<(() => void) | null>(null);
  const lastHandledAttachmentSelectionRef = useRef<string | null>(null);
  const recentAttachmentSelectionRef = useRef<{ signature: string; handledAt: number } | null>(
    null,
  );
  const launchErrorRedirectedRef = useRef(false);
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const fileInputActivationMode = resolveFileInputActivationMode(
    typeof document === 'undefined' ? undefined : document.documentElement.dataset.maxPlatform,
  );
  const useNativeTapFileInputs = fileInputActivationMode === 'native-tap';
  const dialogQueryKey = queryKeys.entityDialog('channel', chatId, 'suggest', token);
  const shouldLoadDialog = Boolean(chatId && token) && terminalDialogError === null;

  useEffect(() => {
    if (chatId) {
      saveLastEntityId('channel', chatId);
    }
  }, [chatId]);

  const dialogQuery = useQuery({
    queryKey: dialogQueryKey,
    queryFn: ({ signal }) => getChannelSuggestDialog(api, chatId, token, { signal }),
    enabled: shouldLoadDialog,
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
    navigate(buildManagedEntitiesRoute('channel'), { replace: true });
  }, [dialogQuery.error, dialogQueryKey, navigate, pushToast, queryClient]);

  const messages = dialogQuery.data?.messages ?? [];
  const introText = dialogQuery.data?.introText?.trim() ?? '';
  const draftLength = draft.trim().length;
  const isPreparingImage = preparingImageState !== null;
  const canSubmitMessage =
    !isPreparingImage &&
    draftLength <= SUGGEST_DRAFT_MAX_LENGTH &&
    (draftLength > 0 || draftAttachments.length > 0);
  const suggestPreparingImageSlots = preparingImageState?.total ?? 0;
  const suggestPreparingImageLabel = preparingImageState
    ? `Готовим ${Math.min(preparingImageState.done + 1, preparingImageState.total)}/${preparingImageState.total}`
    : null;

  const resetAttachmentPicker = () => {
    attachmentInputWatchCleanupRef.current?.();
    attachmentInputWatchCleanupRef.current = null;
    lastHandledAttachmentSelectionRef.current = null;
    if (imageInputRef.current) {
      imageInputRef.current.value = '';
    }
  };

  useEffect(
    () => () => {
      resetAttachmentPicker();
    },
    [],
  );

  useLayoutEffect(() => {
    const screen = screenRef.current;
    const bar = suggestBarRef.current;
    if (!screen || !bar) {
      return undefined;
    }

    const updateBarHeight = () => {
      screen.style.setProperty(
        '--suggest-bar-height',
        `${Math.ceil(bar.getBoundingClientRect().height)}px`,
      );
    };

    updateBarHeight();
    const observer = new ResizeObserver(updateBarHeight);
    observer.observe(bar);
    window.addEventListener('resize', updateBarHeight, { passive: true });

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updateBarHeight);
      screen.style.removeProperty('--suggest-bar-height');
    };
  }, [dialogQuery.data, dialogQuery.error, dialogQuery.isLoading]);

  const blurSuggestComposerFocus = () => {
    if (typeof document === 'undefined') {
      return;
    }

    const activeElement = document.activeElement;
    if (!(activeElement instanceof HTMLElement)) {
      return;
    }

    const composer = suggestComposerRef.current;
    const bar = suggestBarRef.current;
    if ((composer && composer.contains(activeElement)) || (bar && bar.contains(activeElement))) {
      activeElement.blur();
    }
    screenRef.current?.classList.remove('is-suggest-editor-focused');
  };

  useLayoutEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return undefined;
    }

    const viewport = scrollViewportRef.current;
    const composer = suggestComposerRef.current;
    if (!viewport || !composer) {
      return undefined;
    }

    let frameId = 0;
    let isEditorFocused = false;
    const timers = new Set<number>();

    const isSuggestEditorTarget = (target: EventTarget | null): target is Element =>
      target instanceof Element &&
      Boolean(target.closest('.channel-suggest-composer__field textarea'));

    const readKeyboardOverlap = () => {
      const rawValue = window
        .getComputedStyle(document.documentElement)
        .getPropertyValue('--app-keyboard-overlap');
      const value = Number.parseFloat(rawValue);
      return Number.isFinite(value) ? Math.max(0, value) : 0;
    };

    const setFocusedClass = (focused: boolean) => {
      screenRef.current?.classList.toggle('is-suggest-editor-focused', focused);
    };

    const getFocusedAnchor = (): HTMLElement => {
      const activeElement = document.activeElement;
      if (activeElement instanceof HTMLElement && composer.contains(activeElement)) {
        return activeElement;
      }

      return composer;
    };

    const keepFocusedEditorVisible = (behavior: ScrollBehavior) => {
      if (!isEditorFocused) {
        return;
      }

      const visualViewport = window.visualViewport;
      const viewportRect = viewport.getBoundingClientRect();
      const visualTop = visualViewport?.offsetTop ?? 0;
      const visualHeight = visualViewport?.height ?? window.innerHeight;
      const keyboardOverlap = readKeyboardOverlap();
      const isMobileViewport =
        Math.min(window.innerWidth, visualViewport?.width ?? window.innerWidth) <= 640;
      const isNativeClient = document.documentElement.dataset.maxClient === 'native';
      const fallbackKeyboardReserve =
        keyboardOverlap < 120 && (isNativeClient || isMobileViewport)
          ? Math.min(320, Math.max(180, Math.round(visualHeight * 0.42)))
          : 0;
      const keyboardBottom =
        keyboardOverlap >= 120 ? window.innerHeight - keyboardOverlap : Infinity;
      const visibleTop = Math.max(viewportRect.top, visualTop);
      const visibleBottom = Math.min(
        viewportRect.bottom,
        visualTop + visualHeight - fallbackKeyboardReserve,
        keyboardBottom,
      );
      const barTop = suggestBarRef.current?.getBoundingClientRect().top;
      const protectedBottom =
        typeof barTop === 'number' ? Math.min(visibleBottom, barTop - 12) : visibleBottom;
      const targetRect = getFocusedAnchor().getBoundingClientRect();
      const bottomGap = targetRect.bottom + 18 - protectedBottom;

      if (bottomGap > 1) {
        viewport.scrollBy({ top: Math.ceil(bottomGap), behavior });
        return;
      }

      const topGap = visibleTop + 10 - targetRect.top;
      if (topGap > 1) {
        viewport.scrollBy({ top: -Math.ceil(topGap), behavior });
      }
    };

    const scheduleKeepVisible = (behavior: ScrollBehavior = 'auto') => {
      window.cancelAnimationFrame(frameId);
      frameId = window.requestAnimationFrame(() => keepFocusedEditorVisible(behavior));
    };

    const scheduleSettlingPasses = () => {
      scheduleKeepVisible('smooth');
      for (const delay of [80, 180, 320]) {
        const timerId = window.setTimeout(() => {
          timers.delete(timerId);
          scheduleKeepVisible('auto');
        }, delay);
        timers.add(timerId);
      }
    };

    const handleFocusIn = (event: FocusEvent) => {
      if (!isSuggestEditorTarget(event.target)) {
        return;
      }

      isEditorFocused = true;
      setFocusedClass(true);
      scheduleSettlingPasses();
    };

    const handleFocusOut = (event: FocusEvent) => {
      if (isSuggestEditorTarget(event.relatedTarget)) {
        return;
      }

      isEditorFocused = false;
      setFocusedClass(false);
    };

    const handleViewportChange = () => {
      scheduleKeepVisible('auto');
    };

    composer.addEventListener('focusin', handleFocusIn);
    composer.addEventListener('focusout', handleFocusOut);
    composer.addEventListener('input', handleViewportChange);
    window.addEventListener('resize', handleViewportChange, { passive: true });
    window.visualViewport?.addEventListener('resize', handleViewportChange);
    window.visualViewport?.addEventListener('scroll', handleViewportChange);

    return () => {
      window.cancelAnimationFrame(frameId);
      setFocusedClass(false);
      for (const timerId of timers) {
        window.clearTimeout(timerId);
      }
      composer.removeEventListener('focusin', handleFocusIn);
      composer.removeEventListener('focusout', handleFocusOut);
      composer.removeEventListener('input', handleViewportChange);
      window.removeEventListener('resize', handleViewportChange);
      window.visualViewport?.removeEventListener('resize', handleViewportChange);
      window.visualViewport?.removeEventListener('scroll', handleViewportChange);
    };
  }, [dialogQuery.data, dialogQuery.error, dialogQuery.isLoading]);

  const appendDraftAttachments = (nextAttachments: SuggestDraftAttachment[]) => {
    if (nextAttachments.length === 0) {
      return;
    }

    setDraftAttachments((current) => {
      const accepted = [...current];
      let totalBase64Length = calculateDraftAttachmentsBase64Length(current);
      let rejectedByCount = 0;
      let rejectedBySize = 0;

      for (const attachment of nextAttachments) {
        if (accepted.length >= MAX_SUGGEST_IMAGES) {
          rejectedByCount += 1;
          continue;
        }

        if (attachment.base64.length > MAX_SUGGEST_IMAGE_BASE64_LENGTH) {
          rejectedBySize += 1;
          continue;
        }

        const nextTotalBase64Length = totalBase64Length + attachment.base64.length;
        if (nextTotalBase64Length > MAX_SUGGEST_ATTACHMENTS_TOTAL_BASE64) {
          rejectedBySize += 1;
          continue;
        }

        accepted.push(attachment);
        totalBase64Length = nextTotalBase64Length;
      }

      const addedCount = accepted.length - current.length;
      if (addedCount === 0) {
        pushToast({
          tone: 'danger',
          title: rejectedBySize > 0 ? 'Фото слишком тяжёлые' : 'Слишком много фото',
          description:
            rejectedByCount > 0
              ? `Можно добавить до ${MAX_SUGGEST_IMAGES} фото.`
              : 'Уберите часть фото и попробуйте снова.',
        });
        return current;
      }

      if (rejectedByCount > 0 || rejectedBySize > 0) {
        pushToast({
          tone: 'info',
          title: `Добавили ${addedCount} из ${nextAttachments.length}`,
          description:
            rejectedByCount > 0
              ? `Лимит предложки — ${MAX_SUGGEST_IMAGES} фото. Остальные не добавили.`
              : 'Часть фото не добавили, потому что суммарный размер получился слишком большим.',
        });
      }

      maxSelectionChanged();
      return accepted;
    });
  };

  const prepareDraftImagesFromFiles = async (files: File[]) => {
    if (files.length === 0) {
      resetAttachmentPicker();
      return;
    }

    const remainingSlots = Math.max(0, MAX_SUGGEST_IMAGES - draftAttachments.length);
    if (remainingSlots <= 0) {
      pushToast({
        tone: 'info',
        title: 'Больше фото не поместится',
        description: `В одной предложке может быть до ${MAX_SUGGEST_IMAGES} фото.`,
      });
      resetAttachmentPicker();
      return;
    }

    if (files.length > remainingSlots) {
      pushToast({
        tone: 'info',
        title: `Добавим ${remainingSlots} фото`,
        description:
          remainingSlots === MAX_SUGGEST_IMAGES
            ? `За один раз можно выбрать до ${MAX_SUGGEST_IMAGES} фото.`
            : `Сейчас осталось места только для ${remainingSlots} фото.`,
      });
    }

    const selectableFiles = files.slice(0, remainingSlots);
    setPreparingImageState({ total: selectableFiles.length, done: 0 });

    try {
      const { prepareSuggestionDialogImageAttachment, resolveSuggestionDialogImageMaxBytes } =
        await import('../lib/dialog-attachments');
      const prepared: SuggestDraftAttachment[] = [];
      let firstError: string | null = null;
      const suggestionImageMaxBytes = resolveSuggestionDialogImageMaxBytes(
        selectableFiles.length,
        calculateDraftAttachmentsBase64Length(draftAttachments),
      );

      for (const file of selectableFiles) {
        try {
          prepared.push(
            await prepareSuggestionDialogImageAttachment(file, {
              maxBytes: suggestionImageMaxBytes,
            }),
          );
        } catch (error: unknown) {
          if (!firstError && error instanceof Error && error.message.trim()) {
            firstError = error.message;
          } else if (!firstError) {
            firstError = 'Не удалось подготовить фото.';
          }
        } finally {
          setPreparingImageState((current) =>
            current ? { ...current, done: Math.min(current.total, current.done + 1) } : current,
          );
        }
      }

      if (prepared.length > 0) {
        appendDraftAttachments(prepared);
      }

      if (firstError) {
        pushToast({
          tone: 'danger',
          title: 'Фото не добавлено',
          description: firstError,
        });
      }
    } catch (error: unknown) {
      pushToast({
        tone: 'danger',
        title: 'Фото не добавлено',
        description:
          error instanceof Error && error.message.trim()
            ? error.message
            : 'Не удалось подготовить фото.',
      });
    } finally {
      resetAttachmentPicker();
      setPreparingImageState(null);
    }
  };

  const handleDraftImageInputSelection = (input: HTMLInputElement | null): boolean => {
    const files = Array.from(input?.files ?? []);
    if (files.length === 0) {
      return false;
    }

    const signature = buildAttachmentSelectionSignature(files);
    const recentSelection = recentAttachmentSelectionRef.current;
    if (
      recentSelection?.signature === signature &&
      Date.now() - recentSelection.handledAt < ATTACHMENT_SELECTION_DEDUPE_MS
    ) {
      attachmentInputWatchCleanupRef.current?.();
      attachmentInputWatchCleanupRef.current = null;
      return true;
    }

    if (lastHandledAttachmentSelectionRef.current === signature) {
      attachmentInputWatchCleanupRef.current?.();
      attachmentInputWatchCleanupRef.current = null;
      return true;
    }

    lastHandledAttachmentSelectionRef.current = signature;
    recentAttachmentSelectionRef.current = {
      signature,
      handledAt: Date.now(),
    };
    attachmentInputWatchCleanupRef.current?.();
    attachmentInputWatchCleanupRef.current = null;
    void prepareDraftImagesFromFiles(files);
    return true;
  };

  const armImageInputWatcher = () => {
    attachmentInputWatchCleanupRef.current?.();
    attachmentInputWatchCleanupRef.current = null;

    if (
      typeof window === 'undefined' ||
      typeof document === 'undefined' ||
      !imageInputRef.current ||
      imageInputRef.current.disabled
    ) {
      return;
    }

    const input = imageInputRef.current;
    const timeoutIds = new Set<number>();
    const scheduleDrain = (delays: number[]) => {
      for (const delay of delays) {
        const timeoutId = window.setTimeout(() => {
          timeoutIds.delete(timeoutId);
          handleDraftImageInputSelection(input);
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
    scheduleDrain([240, 900, 1600, 4200, 8200]);

    attachmentInputWatchCleanupRef.current = () => {
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      for (const timeoutId of timeoutIds) {
        window.clearTimeout(timeoutId);
      }
      timeoutIds.clear();
    };
  };

  const handleDraftImagesChange = (event: ReactChangeEvent<HTMLInputElement>) => {
    handleDraftImageInputSelection(event.currentTarget);
  };

  const handleDraftImagesInput = (event: ReactFormEvent<HTMLInputElement>) => {
    handleDraftImageInputSelection(event.currentTarget);
  };

  const handleDraftAttachmentRemove = (index: number) => {
    setDraftAttachments((current) =>
      current.filter((_, attachmentIndex) => attachmentIndex !== index),
    );
    maxSelectionChanged();
    resetAttachmentPicker();
  };

  const sendMutation = useMutation({
    mutationFn: (payload: { text: string; attachments: SuggestDraftAttachment[] }) =>
      createChannelSuggestDialogMessage(api, chatId, {
        token,
        text: payload.text,
        textFormat: 'markdown',
        images: payload.attachments.map((attachment) => ({
          base64: attachment.base64,
          mimeType: attachment.mimeType,
          fileName: attachment.fileName,
        })),
      }),
    onSuccess: (result) => {
      queryClient.setQueryData<ChannelDialogResponse | undefined>(dialogQueryKey, (current) =>
        updateDialogMessage(current, result.message),
      );
      pushToast({
        tone: 'success',
        title: 'Готово',
        description: 'Предложка отправлена.',
      });
      setDraft('');
      setDraftAttachments([]);
      resetAttachmentPicker();
      requestAnimationFrame(() => {
        const viewport = scrollViewportRef.current;
        viewport?.scrollTo({
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

  const isSubmitPending = sendMutation.isPending;
  const isComposerBusy = isSubmitPending || isPreparingImage;
  const submitDisabled = !canSubmitMessage || isSubmitPending;

  const applySuggestTextModifier = (tool: MaxMarkdownTool) => {
    if (isComposerBusy) {
      return;
    }

    richTextEditorRef.current?.applyTool(tool);
    maxSelectionChanged();
  };

  const onSubmit = () => {
    const text = draft.trim();
    if (
      isSubmitPending ||
      !chatId ||
      !token ||
      draftLength > SUGGEST_DRAFT_MAX_LENGTH ||
      (!text && draftAttachments.length === 0)
    ) {
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
            title="Канал не найден"
            description="Откройте диалог заново из сообщения."
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
            description="Откройте сообщение и нажмите кнопку ещё раз."
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

  const suggestImageControl = (
    <div className="channel-suggest-composer__tools">
      {useNativeTapFileInputs ? (
        <label
          className={cn(
            'channel-suggest-composer__tool',
            isComposerBusy && 'is-disabled',
            draftAttachments.length > 0 && 'is-active',
          )}
          aria-label={`Добавить до ${MAX_SUGGEST_IMAGES} фото`}
          aria-disabled={isComposerBusy}
          role="button"
          tabIndex={isComposerBusy ? -1 : 0}
          onClick={() => {
            blurSuggestComposerFocus();
            armImageInputWatcher();
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' && event.key !== ' ') {
              return;
            }
            event.preventDefault();
            blurSuggestComposerFocus();
            armImageInputWatcher();
            imageInputRef.current?.click();
          }}
        >
          <input
            ref={imageInputRef}
            className="channel-dialog-compose__attach-input"
            type="file"
            accept="image/*"
            multiple
            disabled={isComposerBusy}
            onChange={handleDraftImagesChange}
            onInput={handleDraftImagesInput}
            onClickCapture={armImageInputWatcher}
            onPointerDownCapture={armImageInputWatcher}
            tabIndex={-1}
          />
          <IconoirCamera aria-hidden focusable="false" />
        </label>
      ) : (
        <>
          <button
            type="button"
            className={cn(
              'channel-suggest-composer__tool',
              draftAttachments.length > 0 && 'is-active',
            )}
            aria-label={`Добавить до ${MAX_SUGGEST_IMAGES} фото`}
            disabled={isComposerBusy}
            onClick={() => {
              blurSuggestComposerFocus();
              armImageInputWatcher();
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
            multiple
            disabled={isComposerBusy}
            onChange={handleDraftImagesChange}
            onInput={handleDraftImagesInput}
            onClickCapture={armImageInputWatcher}
            onPointerDownCapture={armImageInputWatcher}
            tabIndex={-1}
          />
        </>
      )}

      {suggestPreparingImageLabel || draftAttachments.length > 0 ? (
        <span className="channel-suggest-composer__asset">
          {suggestPreparingImageLabel ?? `${draftAttachments.length}/${MAX_SUGGEST_IMAGES}`}
        </span>
      ) : null}
    </div>
  );

  const suggestBar =
    !dialogQuery.isLoading && !dialogQuery.error ? (
      <div
        ref={suggestBarRef}
        className="channel-suggest-composer__bar channel-suggest-composer__bar--anchored"
      >
        {suggestImageControl}

        <div
          className="channel-suggest-composer__modifier-row"
          role="toolbar"
          aria-label="Форматирование"
        >
          {MAX_MARKDOWN_TOOL_DEFINITIONS.map((tool) => (
            <button
              key={tool.id}
              type="button"
              className={cn(
                'channel-suggest-composer__modifier',
                tool.id === 'italic' && 'is-italic',
                tool.id === 'code' && 'is-code',
              )}
              onMouseDown={(event) => {
                event.preventDefault();
              }}
              onClick={() => applySuggestTextModifier(tool.id)}
              disabled={isComposerBusy}
              title={tool.title}
              aria-label={tool.title}
            >
              <SuggestMarkdownToolIcon tool={tool.id} />
            </button>
          ))}
        </div>

        <button
          type="button"
          className="channel-suggest-composer__submit"
          onClick={onSubmit}
          disabled={submitDisabled}
        >
          {isSubmitPending ? (
            <span className="channel-dialog-submit__loader" aria-hidden />
          ) : (
            <IconoirSend aria-hidden focusable="false" />
          )}
          <span>{isSubmitPending ? 'Отправка' : 'Отправить'}</span>
        </button>
      </div>
    ) : null;

  return (
    <div
      ref={screenRef}
      className="channel-dialog-screen channel-dialog-screen--suggest page-enter"
    >
      <div className="channel-dialog-screen__backdrop" aria-hidden />

      <div className="channel-dialog-shell channel-dialog-shell--suggest">
        <section ref={scrollViewportRef} className="channel-dialog-body channel-suggest-body">
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
            <div className="channel-suggest-workspace">
              {introText ? <SuggestionRequirements text={introText} /> : null}

              <section
                ref={suggestComposerRef}
                className={cn(
                  'channel-suggest-composer',
                  canSubmitMessage && 'is-ready',
                  isComposerBusy && 'is-busy',
                )}
                aria-label="Предложить пост"
              >
                <div className="channel-suggest-composer__head">
                  <span
                    className={cn(
                      'channel-suggest-composer__status',
                      canSubmitMessage ? 'is-ready' : 'is-empty',
                    )}
                  >
                    {canSubmitMessage ? 'Готов' : 'Пусто'}
                  </span>
                  <span className="channel-suggest-composer__counter">
                    {draftLength}/{SUGGEST_DRAFT_MAX_LENGTH}
                  </span>
                </div>

                <div
                  className={cn(
                    'channel-suggest-composer__phone',
                    !draft.trim() &&
                      draftAttachments.length === 0 &&
                      suggestPreparingImageSlots === 0 &&
                      'is-empty',
                  )}
                >
                  <div className="channel-suggest-composer__bubble">
                    <SuggestComposeImageGrid
                      attachments={draftAttachments}
                      preparingCount={suggestPreparingImageSlots}
                      busy={isSubmitPending || suggestPreparingImageSlots > 0}
                      onRemove={handleDraftAttachmentRemove}
                    />

                    <div className="channel-suggest-composer__field">
                      <MaxRichTextEditor
                        ref={richTextEditorRef}
                        value={draft}
                        onChange={setDraft}
                        placeholder="Текст идеи или подпись к фото"
                        maxLength={SUGGEST_DRAFT_MAX_LENGTH}
                        disabled={isSubmitPending}
                        ariaLabel="Текст предложки"
                        className="channel-suggest-composer__rich-editor"
                      />
                    </div>

                    <span className="channel-suggest-composer__tail" aria-hidden />
                  </div>
                </div>
              </section>

              {messages.length ? (
                <div className="channel-suggest-list channel-suggest-list--history">
                  {messages.map((message) => {
                    const status = resolveSuggestionStatus(message);
                    const suggestionText = resolveSuggestionText(message);
                    const hasSuggestionText = message.text.trim().length > 0;
                    const hasMedia =
                      message.hasImage ||
                      message.hasVideo ||
                      Boolean(message.imageFileName || message.videoFileName);

                    return (
                      <article
                        key={message.id}
                        className={cn('channel-suggest-card', `is-${status.tone}`)}
                      >
                        <div className="channel-suggest-card__head">
                          <span className={cn('channel-suggest-status', `is-${status.tone}`)}>
                            {status.badge}
                          </span>
                          <time dateTime={message.createdAt}>
                            {formatMessageTime(message.createdAt)}
                          </time>
                        </div>

                        <p className={cn(!hasSuggestionText && 'is-muted')}>
                          {hasSuggestionText && message.textFormat === 'markdown' ? (
                            <MaxMarkdownPreview
                              value={message.text}
                              preserveLinks
                              fallback={suggestionText}
                            />
                          ) : (
                            suggestionText
                          )}
                        </p>

                        {hasMedia ? (
                          <span className="channel-suggest-card__media">
                            <IconoirAttachment aria-hidden focusable="false" />
                            {resolveSuggestionAttachmentLabel(message)}
                          </span>
                        ) : null}

                        {message.publishedUrl ? (
                          <a
                            className="channel-suggest-card__link"
                            href={message.publishedUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Открыть
                          </a>
                        ) : null}
                      </article>
                    );
                  })}
                </div>
              ) : null}
            </div>
          ) : null}
        </section>

        {suggestBar}
      </div>
    </div>
  );
}
