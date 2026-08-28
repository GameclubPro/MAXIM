import type {
  ChannelDialogMessage,
  ChannelDialogResponse,
  CreateChannelDialogMessageResponse,
} from '@maxim/contracts/channel-dialog';
import type { MiniappProfile } from '@maxim/contracts/publisher';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Attachment as IconoirAttachment,
  Bold as IconoirBold,
  Code as IconoirCode,
  Italic as IconoirItalic,
  Link as IconoirLink,
  SendDiagonalSolid as IconoirSend,
  Strikethrough as IconoirStrikethrough,
  Type as IconoirType,
  Underline as IconoirUnderline,
} from 'iconoir-react';
import {
  Suspense,
  lazy,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent as ReactChangeEvent,
  type ComponentType,
  type FormEvent as ReactFormEvent,
} from 'react';
import { useParams, useSearchParams } from 'react-router';
import {
  MAX_MARKDOWN_TOOL_DEFINITIONS,
  type MaxMarkdownTool,
} from '../components/max-markdown-editor';
import { PublicDialogUnavailableState } from '../components/public-dialog-unavailable-state';
import type { MaxRichTextEditorHandle } from '../components/max-rich-text-editor';
import { StatusState } from '../components/ui/status-state';
import { useToast } from '../components/ui/toast';
import type { ApiTransport } from '../lib/api/transport';
import {
  resolveSuggestionKeyboardLayout,
  type SuggestionKeyboardViewportBaseline,
} from '../lib/channel-suggestion-keyboard-layout';
import {
  createChannelSuggestionImagePreparationGuard,
  type ChannelSuggestionImagePreparationGuard,
} from '../lib/channel-suggestion-image-preparation';
import { cn } from '../lib/cn';
import { isSessionExpiredApiMessage, isTerminalDialogApiMessage } from '../lib/dialog-api-error';
import type { PreparedCommentDialogAttachment } from '../lib/dialog-attachments';
import { openFileInputPicker, resolveFileInputActivationMode } from '../lib/file-input-picker';
import { maxSelectionChanged } from '../lib/max-bridge';
import { queryKeys } from '../lib/query-keys';
import '../styles/channel-dialog-suggest.css';

const SUGGEST_DRAFT_MAX_LENGTH = 2_000;
const ATTACHMENT_SELECTION_DEDUPE_MS = 2_500;
const MAX_SUGGEST_IMAGES = 10;
const MAX_SUGGEST_IMAGE_BASE64_LENGTH = 8_000_000;
const MAX_SUGGEST_ATTACHMENTS_TOTAL_BASE64 = 24_000_000;

function LazySuggestionChunkLoadFailure() {
  return (
    <button
      type="button"
      className="button button--danger"
      onClick={() => window.location.reload()}
    >
      Обновить
    </button>
  );
}

function lazySuggestionComponent<TProps>(
  loader: () => Promise<{ default: ComponentType<TProps> }>,
  exportName: string,
  recoverAutomatically: boolean,
) {
  return lazy(async () => {
    try {
      return await loader();
    } catch (cause) {
      let reloading = false;
      if (recoverAutomatically) {
        try {
          const recovery = await import('../lib/lazy-load-recovery');
          reloading = recovery.reloadAfterLazyPageLoadFailure(exportName, cause);
        } catch {
          // Keep the explicit reload action available when the recovery chunk also failed.
        }
      }
      if (reloading) {
        await new Promise((resolve) => setTimeout(resolve, 4_000));
      }

      return { default: LazySuggestionChunkLoadFailure as ComponentType<TProps> };
    }
  });
}

const loadChannelSuggestionComposeImageGrid = () =>
  import('../components/channel-suggestion-compose-image-grid');
const LazyChannelSuggestionComposeImageGrid = lazySuggestionComponent(
  loadChannelSuggestionComposeImageGrid,
  'ChannelSuggestionComposeImageGrid',
  false,
);
const loadChannelSuggestionHistory = () => import('../components/channel-suggestion-history');
const LazyChannelSuggestionHistory = lazySuggestionComponent(
  loadChannelSuggestionHistory,
  'ChannelSuggestionHistory',
  true,
);
const loadMaxRichTextEditor = () =>
  import('../components/max-rich-text-editor').then((module) => ({
    default: module.MaxRichTextEditor,
  }));
const LazyMaxRichTextEditor = lazySuggestionComponent(
  loadMaxRichTextEditor,
  'MaxRichTextEditor',
  true,
);

type SuggestDraftAttachment = PreparedCommentDialogAttachment;

type PreparingImageState = {
  total: number;
  done: number;
};

type TerminalDialogErrorState = readonly [chatId: string, token: string, message: string];

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

export function ChannelSuggestDialogPage({
  api,
  profile,
}: {
  api: ApiTransport;
  profile: MiniappProfile;
}) {
  const { chatId = '' } = useParams();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token')?.trim() ?? '';
  const [draft, setDraft] = useState('');
  const [editorReady, setEditorReady] = useState(false);
  const [draftAttachments, setDraftAttachments] = useState<SuggestDraftAttachment[]>([]);
  const [preparingImageState, setPreparingImageState] = useState<PreparingImageState | null>(null);
  const [terminalDialogErrorState, setTerminalDialogErrorState] =
    useState<TerminalDialogErrorState | null>(null);
  const screenRef = useRef<HTMLDivElement | null>(null);
  const scrollViewportRef = useRef<HTMLElement | null>(null);
  const suggestComposerRef = useRef<HTMLElement | null>(null);
  const suggestBarRef = useRef<HTMLDivElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const richTextEditorRef = useRef<MaxRichTextEditorHandle | null>(null);
  const suggestionKeyboardBaselineRef = useRef<SuggestionKeyboardViewportBaseline | null>(null);
  const imagePreparationGuardRef = useRef<ChannelSuggestionImagePreparationGuard | null>(null);
  imagePreparationGuardRef.current ??= createChannelSuggestionImagePreparationGuard();
  const imagePreparationGuard = imagePreparationGuardRef.current;
  const attachmentInputWatchCleanupRef = useRef<(() => void) | null>(null);
  const lastHandledAttachmentSelectionRef = useRef<string | null>(null);
  const recentAttachmentSelectionRef = useRef<{ signature: string; handledAt: number } | null>(
    null,
  );
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const canUploadImages = profile === 'moderation';
  const fileInputActivationMode = resolveFileInputActivationMode(
    typeof document === 'undefined' ? undefined : document.documentElement.dataset.maxPlatform,
  );
  const useNativeTapFileInputs = fileInputActivationMode === 'native-tap';
  const dialogQueryKey = queryKeys.entityDialog('channel', chatId, 'suggest', token);
  const terminalDialogError =
    terminalDialogErrorState?.[0] === chatId && terminalDialogErrorState[1] === token
      ? terminalDialogErrorState[2]
      : null;
  const shouldLoadDialog = Boolean(chatId && token) && !terminalDialogError;

  const dialogQuery = useQuery({
    queryKey: dialogQueryKey,
    queryFn: ({ signal }) => getChannelSuggestDialog(api, chatId, token, { signal }),
    enabled: shouldLoadDialog,
    retry: (failureCount, error) =>
      !isTerminalDialogApiMessage(normalizeApiError(error)) && failureCount < 1,
    refetchOnWindowFocus: !terminalDialogError,
    retryOnMount: !terminalDialogError,
    refetchInterval: (query) => {
      const message = query.state.error ? normalizeApiError(query.state.error) : '';
      if (message && isTerminalDialogApiMessage(message)) {
        return false;
      }

      return 8_000;
    },
  });

  useEffect(() => {
    if (terminalDialogError) {
      return;
    }

    const message = dialogQuery.error ? normalizeApiError(dialogQuery.error) : '';
    if (!message || !isTerminalDialogApiMessage(message)) {
      return;
    }

    setTerminalDialogErrorState([chatId, token, message]);
    void queryClient.cancelQueries({ queryKey: dialogQueryKey });
  }, [chatId, dialogQuery.error, dialogQueryKey, queryClient, terminalDialogError, token]);

  const messages = dialogQuery.data?.messages ?? [];
  const introText = dialogQuery.data?.introText?.trim() ?? '';
  const draftLength = draft.trim().length;
  const isPreparingImage = preparingImageState !== null;
  const canSubmitMessage =
    !isPreparingImage &&
    draftLength <= SUGGEST_DRAFT_MAX_LENGTH &&
    (draftLength > 0 || (canUploadImages && draftAttachments.length > 0));
  const suggestPreparingImageSlots = preparingImageState?.total ?? 0;
  const suggestVisibleImageCount = Math.min(
    draftAttachments.length + suggestPreparingImageSlots,
    MAX_SUGGEST_IMAGES,
  );
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
      imagePreparationGuard.cancel();
      resetAttachmentPicker();
    },
    [],
  );

  useEffect(() => {
    if (canUploadImages) {
      return;
    }
    imagePreparationGuard.cancel();
    setDraftAttachments([]);
    setPreparingImageState(null);
    resetAttachmentPicker();
  }, [canUploadImages, imagePreparationGuard]);

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
  }, [dialogQuery.isSuccess]);

  const blurSuggestComposerFocus = () => {
    if (typeof document === 'undefined') {
      return;
    }

    const activeElement = document.activeElement;
    const composer = suggestComposerRef.current;
    const bar = suggestBarRef.current;
    if (
      activeElement instanceof HTMLElement &&
      ((composer && composer.contains(activeElement)) || (bar && bar.contains(activeElement)))
    ) {
      activeElement.blur();
    }
    screenRef.current?.classList.remove('is-suggest-editor-focused');
    screenRef.current?.style.removeProperty('--suggest-keyboard-reserve');
    suggestionKeyboardBaselineRef.current = null;
  };

  useLayoutEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return undefined;
    }

    const screen = screenRef.current;
    const viewport = scrollViewportRef.current;
    const composer = suggestComposerRef.current;
    if (!screen || !viewport || !composer) {
      return undefined;
    }

    let frameId = 0;
    let isEditorFocused = false;
    const timers = new Set<number>();

    const isSuggestEditorTarget = (target: EventTarget | null): target is Element =>
      target instanceof Element &&
      composer.contains(target) &&
      Boolean(
        target.closest('.max-rich-text-editor__surface, .max-rich-text-editor__link-panel input'),
      );

    const readKeyboardOverlap = () => {
      const rawValue = window
        .getComputedStyle(document.documentElement)
        .getPropertyValue('--app-keyboard-overlap');
      const value = Number.parseFloat(rawValue);
      return Number.isFinite(value) ? Math.max(0, value) : 0;
    };

    const getFocusedAnchor = (): HTMLElement => {
      const activeElement = document.activeElement;
      if (activeElement instanceof HTMLElement && composer.contains(activeElement)) {
        const linkPanel = activeElement.closest<HTMLElement>('.max-rich-text-editor__link-panel');
        const editorSurface = activeElement.closest<HTMLElement>('.max-rich-text-editor__surface');
        return linkPanel ?? editorSurface ?? activeElement;
      }

      return composer;
    };

    const readKeyboardLayout = () => {
      const visualViewport = window.visualViewport;
      const layoutHeight = window.innerHeight;
      const visualHeight = visualViewport?.height ?? layoutHeight;
      const baseline = suggestionKeyboardBaselineRef.current ?? {
        layoutHeight,
        visualHeight,
      };
      suggestionKeyboardBaselineRef.current = baseline;

      return resolveSuggestionKeyboardLayout({
        focused: isEditorFocused,
        fallbackEligible:
          document.documentElement.dataset.maxClient === 'native' ||
          Math.min(window.innerWidth, visualViewport?.width ?? window.innerWidth) <= 640,
        layoutHeight,
        visualHeight,
        visualOffsetTop: visualViewport?.offsetTop ?? 0,
        containerBottom: screen.getBoundingClientRect().bottom,
        keyboardOverlap: readKeyboardOverlap(),
        baseline,
      });
    };

    const syncKeyboardReserve = () => {
      if (!isEditorFocused) {
        screen.style.removeProperty('--suggest-keyboard-reserve');
        return null;
      }

      const layout = readKeyboardLayout();
      if (layout.barReservePx > 0) {
        screen.style.setProperty('--suggest-keyboard-reserve', `${layout.barReservePx}px`);
      } else {
        screen.style.removeProperty('--suggest-keyboard-reserve');
      }
      return layout;
    };

    const setEditorFocused = (focused: boolean) => {
      isEditorFocused = focused;
      screen.classList.toggle('is-suggest-editor-focused', focused);
      if (focused) {
        syncKeyboardReserve();
        return;
      }

      screen.style.removeProperty('--suggest-keyboard-reserve');
      suggestionKeyboardBaselineRef.current = null;
    };

    const keepFocusedEditorVisible = (behavior: ScrollBehavior) => {
      if (!isEditorFocused) {
        return;
      }

      const visualViewport = window.visualViewport;
      const viewportRect = viewport.getBoundingClientRect();
      const visualTop = visualViewport?.offsetTop ?? 0;
      const keyboardLayout = syncKeyboardReserve();
      if (!keyboardLayout) {
        return;
      }
      const visibleTop = Math.max(viewportRect.top, visualTop);
      const visibleBottom = Math.min(viewportRect.bottom, keyboardLayout.visibleBottomPx);
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

      setEditorFocused(true);
      scheduleSettlingPasses();
    };

    const handleFocusOut = (event: FocusEvent) => {
      if (isSuggestEditorTarget(event.relatedTarget)) {
        return;
      }

      setEditorFocused(false);
    };

    const handleViewportChange = () => {
      syncKeyboardReserve();
      scheduleKeepVisible('auto');
    };

    composer.addEventListener('focusin', handleFocusIn);
    composer.addEventListener('focusout', handleFocusOut);
    composer.addEventListener('input', handleViewportChange);
    window.addEventListener('resize', handleViewportChange, { passive: true });
    window.visualViewport?.addEventListener('resize', handleViewportChange);
    window.visualViewport?.addEventListener('scroll', handleViewportChange);

    if (isSuggestEditorTarget(document.activeElement)) {
      setEditorFocused(true);
      scheduleSettlingPasses();
    }

    return () => {
      window.cancelAnimationFrame(frameId);
      screen.classList.remove('is-suggest-editor-focused');
      screen.style.removeProperty('--suggest-keyboard-reserve');
      suggestionKeyboardBaselineRef.current = null;
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
  }, [dialogQuery.isSuccess]);

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
      if (!imagePreparationGuard.isActive()) {
        resetAttachmentPicker();
      }
      return;
    }

    const preparationRun = imagePreparationGuard.tryStart();
    if (!preparationRun) {
      return;
    }

    try {
      const remainingSlots = Math.max(0, MAX_SUGGEST_IMAGES - draftAttachments.length);
      if (remainingSlots <= 0) {
        pushToast({
          tone: 'info',
          title: 'Больше фото не поместится',
          description: `В одной предложке может быть до ${MAX_SUGGEST_IMAGES} фото.`,
        });
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

      const { prepareSuggestionDialogImageAttachment, resolveSuggestionDialogImageMaxBytes } =
        await import('../lib/dialog-attachments');
      if (!imagePreparationGuard.owns(preparationRun)) {
        return;
      }

      const prepared: SuggestDraftAttachment[] = [];
      let firstError: string | null = null;
      const suggestionImageMaxBytes = resolveSuggestionDialogImageMaxBytes(
        selectableFiles.length,
        calculateDraftAttachmentsBase64Length(draftAttachments),
      );

      for (const file of selectableFiles) {
        if (!imagePreparationGuard.owns(preparationRun)) {
          return;
        }

        try {
          const attachment = await prepareSuggestionDialogImageAttachment(file, {
            maxBytes: suggestionImageMaxBytes,
          });
          if (!imagePreparationGuard.owns(preparationRun)) {
            return;
          }
          prepared.push(attachment);
        } catch (error: unknown) {
          if (!imagePreparationGuard.owns(preparationRun)) {
            return;
          }
          if (!firstError && error instanceof Error && error.message.trim()) {
            firstError = error.message;
          } else if (!firstError) {
            firstError = 'Не удалось подготовить фото.';
          }
        } finally {
          if (imagePreparationGuard.owns(preparationRun)) {
            setPreparingImageState((current) =>
              current ? { ...current, done: Math.min(current.total, current.done + 1) } : current,
            );
          }
        }
      }

      if (!imagePreparationGuard.owns(preparationRun)) {
        return;
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
      if (imagePreparationGuard.owns(preparationRun)) {
        pushToast({
          tone: 'danger',
          title: 'Фото не добавлено',
          description:
            error instanceof Error && error.message.trim()
              ? error.message
              : 'Не удалось подготовить фото.',
        });
      }
    } finally {
      if (imagePreparationGuard.finish(preparationRun)) {
        resetAttachmentPicker();
        setPreparingImageState(null);
      }
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
        images: (canUploadImages ? payload.attachments : []).map((attachment) => ({
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
        description: 'Предложка сохранена.',
      });
      setDraft('');
      setDraftAttachments([]);
      resetAttachmentPicker();
      void loadChannelSuggestionHistory()
        .catch(() => undefined)
        .then(() => {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              const viewport = scrollViewportRef.current;
              viewport?.scrollTo({
                top: viewport.scrollHeight,
                behavior: 'smooth',
              });
            });
          });
        });
      void queryClient.invalidateQueries({
        queryKey: dialogQueryKey,
      });
    },
    onError: (error) => {
      const message = normalizeApiError(error);
      if (isTerminalDialogApiMessage(message)) {
        setTerminalDialogErrorState([chatId, token, message]);
        void queryClient.cancelQueries({ queryKey: dialogQueryKey });
        return;
      }

      pushToast({
        tone: 'danger',
        title: 'Ошибка',
        description: message,
      });
    },
  });

  const isSubmitPending = sendMutation.isPending;
  const isComposerBusy = isSubmitPending || isPreparingImage || !editorReady;
  const submitDisabled = !canSubmitMessage || isSubmitPending || !editorReady;

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
      imagePreparationGuard.isActive() ||
      isSubmitPending ||
      !chatId ||
      !token ||
      draftLength > SUGGEST_DRAFT_MAX_LENGTH ||
      (!text && (!canUploadImages || draftAttachments.length === 0))
    ) {
      return;
    }

    void loadChannelSuggestionHistory().catch(() => undefined);
    sendMutation.mutate({
      text,
      attachments: canUploadImages ? draftAttachments : [],
    });
  };

  if (terminalDialogError) {
    const sessionExpired = isSessionExpiredApiMessage(terminalDialogError);
    return (
      <PublicDialogUnavailableState
        tone={sessionExpired ? 'danger' : undefined}
        title={sessionExpired ? 'Нужно открыть приложение заново' : 'Диалог недоступен'}
        description={
          sessionExpired
            ? 'Закройте мини-приложение и откройте этот диалог снова из сообщения в MAX.'
            : terminalDialogError
        }
      />
    );
  }

  if (!chatId) {
    return (
      <PublicDialogUnavailableState
        title="Канал не найден"
        description="Откройте диалог заново из сообщения."
      />
    );
  }

  if (!token) {
    return (
      <PublicDialogUnavailableState
        title="Кнопка устарела"
        description="Откройте сообщение и нажмите кнопку ещё раз."
      />
    );
  }

  const suggestImageControl = canUploadImages ? (
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
          <IconoirAttachment aria-hidden focusable="false" />
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
            <IconoirAttachment aria-hidden focusable="false" />
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
  ) : null;

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
                    {canUploadImages && suggestVisibleImageCount > 0 ? (
                      <Suspense
                        fallback={
                          <div
                            className={cn(
                              'channel-suggest-composer__image-grid',
                              `is-count-${suggestVisibleImageCount}`,
                              'is-busy',
                            )}
                            role="list"
                            aria-label="Готовим фото"
                            aria-busy="true"
                          >
                            {Array.from({ length: suggestVisibleImageCount }, (_, index) => (
                              <div
                                key={index}
                                className="channel-suggest-composer__image-tile is-loading"
                                role="listitem"
                              >
                                <span
                                  className="channel-suggest-composer__image-loader"
                                  aria-hidden
                                >
                                  <IconoirAttachment aria-hidden focusable="false" />
                                </span>
                              </div>
                            ))}
                          </div>
                        }
                      >
                        <LazyChannelSuggestionComposeImageGrid
                          attachments={draftAttachments}
                          preparingCount={suggestPreparingImageSlots}
                          busy={isSubmitPending || suggestPreparingImageSlots > 0}
                          maxImages={MAX_SUGGEST_IMAGES}
                          onRemove={handleDraftAttachmentRemove}
                        />
                      </Suspense>
                    ) : null}

                    <div className="channel-suggest-composer__field">
                      <Suspense
                        fallback={
                          <div
                            className="channel-suggest-composer__rich-editor"
                            role="textbox"
                            aria-label="Текст предложки"
                            aria-busy="true"
                          />
                        }
                      >
                        <LazyMaxRichTextEditor
                          ref={richTextEditorRef}
                          value={draft}
                          onChange={setDraft}
                          placeholder="Текст идеи или подпись к фото"
                          maxLength={SUGGEST_DRAFT_MAX_LENGTH}
                          disabled={isSubmitPending}
                          onNormalizationReadyChange={setEditorReady}
                          ariaLabel="Текст предложки"
                          className="channel-suggest-composer__rich-editor"
                          onPasteFiles={canUploadImages ? prepareDraftImagesFromFiles : undefined}
                        />
                      </Suspense>
                    </div>

                    <span className="channel-suggest-composer__tail" aria-hidden />
                  </div>
                </div>
              </section>

              {messages.length ? (
                <Suspense
                  fallback={
                    <div className="channel-dialog-skeletons" aria-label="Загрузка истории">
                      <div className="channel-dialog-skeleton">
                        <span className="channel-dialog-skeleton__avatar" />
                        <div className="channel-dialog-skeleton__body">
                          <span className="channel-dialog-skeleton__line is-short" />
                          <span className="channel-dialog-skeleton__line" />
                        </div>
                      </div>
                    </div>
                  }
                >
                  <LazyChannelSuggestionHistory messages={messages} />
                </Suspense>
              ) : null}
            </div>
          ) : null}
        </section>

        {suggestBar}
      </div>
    </div>
  );
}
