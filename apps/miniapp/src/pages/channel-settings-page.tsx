import type { ChannelAutoPostButtonsMode, ChannelSettings } from '@maxim/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { BackChevronIcon, ParticipantsIcon } from '../components/ui/entity-header-icons';
import { MaxMarkdownEditor } from '../components/max-markdown-editor';
import { ManagedPollCard } from '../components/managed-poll-card';
import { GlassCard } from '../components/ui/glass-card';
import { SkeletonCard } from '../components/ui/skeleton';
import { StatusState } from '../components/ui/status-state';
import { useToast } from '../components/ui/toast';
import { cn } from '../lib/cn';
import type { ApiClient, SendBroadcastPayload } from '../lib/api-client';
import { readChatTitle, saveChatTitle } from '../lib/chat-titles';
import { useHintPopoverAutoPosition } from '../lib/hint-popover';
import { buildManagedEntitiesRoute, saveLastEntityId } from '../lib/last-chat';

type ChannelRouteState = {
  chatTitle: string;
  chatLink: string;
};

type ChannelSettingsSectionKey = 'comments' | 'postSuggestions' | 'broadcast' | 'poll';
type ChannelSettingsHintKey =
  | 'commentsEnabled'
  | 'commentsModerationEnabled'
  | 'commentsBlockLinksEnabled'
  | 'commentsAntiSpamEnabled'
  | 'commentsLimitTwoInRowEnabled'
  | 'postSuggestionsEnabled'
  | 'engagementMessageText'
  | 'publishEngagement'
  | 'broadcastText'
  | 'broadcastImage'
  | 'broadcastButton';

const AUTOSAVE_DELAY_MS = 700;
const AUTOSAVE_SAVED_HIDE_MS = 1600;
const MAX_BROADCAST_TEXT_LENGTH = 1_000;
const MAX_BROADCAST_IMAGE_SIZE_BYTES = 1_000_000;

function buildAutoPostButtonsMode(
  includeComments: boolean,
  includeSuggest: boolean,
): ChannelAutoPostButtonsMode {
  if (includeComments && includeSuggest) {
    return 'BOTH';
  }
  if (includeComments) {
    return 'COMMENTS';
  }
  if (includeSuggest) {
    return 'SUGGEST';
  }
  return 'OFF';
}

function modeHasComments(mode: ChannelAutoPostButtonsMode): boolean {
  return mode === 'COMMENTS' || mode === 'BOTH';
}

function sanitizeAutoPostButtonsMode(
  mode: ChannelAutoPostButtonsMode,
  commentsEnabled: boolean,
  suggestEnabled: boolean,
): ChannelAutoPostButtonsMode {
  return buildAutoPostButtonsMode(commentsEnabled && modeHasComments(mode), suggestEnabled);
}

function resolveManualPublishButtons(settings: ChannelSettings) {
  return {
    includeCommentsButton:
      settings.autoPostButtonsMode === 'COMMENTS' || settings.autoPostButtonsMode === 'BOTH'
        ? true
        : settings.autoPostButtonsMode === 'OFF'
          ? settings.commentsEnabled
          : false,
    includeSuggestButton: true,
  };
}

function resolveBroadcastSystemButtons(settings: ChannelSettings) {
  return {
    includeCommentsButton:
      settings.autoPostButtonsMode === 'COMMENTS' || settings.autoPostButtonsMode === 'BOTH'
        ? true
        : settings.autoPostButtonsMode === 'OFF'
          ? settings.commentsEnabled
          : false,
    includeSuggestButton: settings.postSuggestionsEnabled,
  };
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function getRouteState(state: unknown): ChannelRouteState {
  if (!state || typeof state !== 'object') {
    return { chatTitle: '', chatLink: '' };
  }

  const row = state as Record<string, unknown>;
  const chatTitle =
    typeof row.chatTitle === 'string' && row.chatTitle.trim() ? row.chatTitle.trim() : '';
  const candidateLink =
    typeof row.chatLink === 'string' && row.chatLink.trim() ? row.chatLink.trim() : '';
  const chatLink = isHttpUrl(candidateLink) ? candidateLink : '';

  return { chatTitle, chatLink };
}

function formatParticipantsCount(value: number | null | undefined): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }

  return new Intl.NumberFormat('ru-RU').format(value);
}

function normalizeApiError(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'Не удалось сохранить настройки.';
  }

  const text = error.message.trim();
  if (!text) {
    return 'Не удалось сохранить настройки.';
  }

  if (text.startsWith('API request failed:')) {
    const details = text.replace(/^API request failed:\s*\d+\s*/u, '').trim();
    return details || 'Не удалось сохранить настройки.';
  }

  return text;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const payload = result.includes(',') ? result.split(',')[1] : '';
      if (!payload) {
        reject(new Error('Не удалось прочитать файл.'));
        return;
      }

      resolve(payload);
    };
    reader.onerror = () => reject(new Error('Не удалось прочитать файл.'));
    reader.readAsDataURL(file);
  });
}

function SectionChevron({ isOpen }: { isOpen: boolean }) {
  return (
    <span className={cn('settings-section__chevron', isOpen && 'is-open')} aria-hidden>
      <svg
        className="settings-section__chevron-icon"
        viewBox="0 0 20 20"
        fill="none"
        focusable="false"
      >
        <path
          d="M5.5 7.75L10 12.25L14.5 7.75"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

function ChannelSettingsInfoButton({
  hintKey,
  openHintKey,
  onToggleHint,
  label,
}: {
  hintKey: ChannelSettingsHintKey;
  openHintKey: ChannelSettingsHintKey | null;
  onToggleHint: (hintKey: ChannelSettingsHintKey) => void;
  label: string;
}) {
  const isOpen = openHintKey === hintKey;

  return (
    <button
      type="button"
      className={cn('settings-info-button', isOpen && 'is-open')}
      aria-label={label}
      aria-controls={`channel-settings-hint-${hintKey}`}
      aria-expanded={isOpen}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onToggleHint(hintKey);
      }}
    >
      <span aria-hidden>i</span>
    </button>
  );
}

function ChannelSettingsHintAnchor({
  hintKey,
  openHintKey,
  onToggleHint,
  label,
  children,
}: {
  hintKey: ChannelSettingsHintKey;
  openHintKey: ChannelSettingsHintKey | null;
  onToggleHint: (hintKey: ChannelSettingsHintKey) => void;
  label: string;
  children: string;
}) {
  return (
    <span className="channel-settings-hint-anchor">
      <ChannelSettingsInfoButton
        hintKey={hintKey}
        openHintKey={openHintKey}
        onToggleHint={onToggleHint}
        label={label}
      />
      <ChannelSettingsHint hintKey={hintKey} openHintKey={openHintKey}>
        {children}
      </ChannelSettingsHint>
    </span>
  );
}

function ChannelSettingsHint({
  hintKey,
  openHintKey,
  children,
}: {
  hintKey: ChannelSettingsHintKey;
  openHintKey: ChannelSettingsHintKey | null;
  children: string;
}) {
  if (openHintKey !== hintKey) {
    return null;
  }

  return (
    <p
      id={`channel-settings-hint-${hintKey}`}
      className="channel-settings-hint-popover"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      {children}
    </p>
  );
}

function ChannelSettingsToggleCard({
  title,
  description,
  hintKey,
  openHintKey,
  onToggleHint,
  checked,
  onChange,
  disabled = false,
}: {
  title: string;
  description?: string;
  hintKey?: ChannelSettingsHintKey;
  openHintKey: ChannelSettingsHintKey | null;
  onToggleHint: (hintKey: ChannelSettingsHintKey) => void;
  checked: boolean;
  onChange: (nextValue: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div
      className={cn('channel-settings-toggle-card', disabled && 'is-disabled')}
      onClick={(event) => {
        if (disabled) {
          return;
        }

        const target = event.target as HTMLElement;
        if (
          target.closest(
            'button, input, label, .channel-settings-hint-anchor, .settings-native-toggle__hint',
          )
        ) {
          return;
        }

        onChange(!checked);
      }}
    >
      <div className="channel-settings-toggle-card__copy">
        <div className="channel-settings-toggle-card__title-row">
          <strong>{title}</strong>
          {description && hintKey ? (
            <ChannelSettingsHintAnchor
              hintKey={hintKey}
              openHintKey={openHintKey}
              onToggleHint={onToggleHint}
              label={`Пояснение для настройки «${title}»`}
            >
              {description}
            </ChannelSettingsHintAnchor>
          ) : null}
        </div>
        {description && !hintKey ? <span>{description}</span> : null}
      </div>
      <label className="settings-native-switch">
        <input
          type="checkbox"
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
          disabled={disabled}
        />
        <span className="toggle-switch" aria-hidden>
          <span className="toggle-switch__thumb" />
        </span>
      </label>
    </div>
  );
}

function normalizeChannelSettingsDraft(
  draft: ChannelSettings,
  resolvedChannelLink: string,
): ChannelSettings {
  const autoPostButtonsMode = sanitizeAutoPostButtonsMode(
    draft.autoPostButtonsMode,
    draft.commentsEnabled,
    draft.postSuggestionsEnabled,
  );

  return {
    ...draft,
    autoPostButtonsMode,
    engagementMessageText:
      draft.engagementMessageText.trim() || 'Есть идея или обратная связь? Нажмите кнопку ниже.',
    postSuggestionsButtonText: draft.postSuggestionsButtonText.trim() || 'Предложить пост',
    postSuggestionsButtonUrl:
      draft.postSuggestionsButtonEnabled && resolvedChannelLink
        ? resolvedChannelLink
        : draft.postSuggestionsButtonUrl,
  };
}

export function ChannelSettingsPage({ api }: { api: ApiClient }) {
  const { chatId = '' } = useParams();
  const location = useLocation();
  const routeState = getRouteState(location.state);
  const routeChatTitle = routeState.chatTitle;
  const routeChatLink = routeState.chatLink;
  const [draft, setDraft] = useState<ChannelSettings | null>(null);
  const [savedSnapshot, setSavedSnapshot] = useState<ChannelSettings | null>(null);
  const [autosaveState, setAutosaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const autosaveTimerRef = useRef<number | null>(null);
  const autosaveHideTimerRef = useRef<number | null>(null);
  const saveInFlightRef = useRef<Promise<ChannelSettings> | null>(null);
  const lastFailedDraftKeyRef = useRef<string | null>(null);
  const latestNormalizedDraftRef = useRef<ChannelSettings | null>(null);
  const latestDraftKeyRef = useRef('');
  const isDirtyRef = useRef(false);
  const [expandedSections, setExpandedSections] = useState<
    Record<ChannelSettingsSectionKey, boolean>
  >({
    comments: false,
    postSuggestions: false,
    broadcast: false,
    poll: false,
  });
  const [openHintKey, setOpenHintKey] = useState<ChannelSettingsHintKey | null>(null);
  const { pushToast } = useToast();
  const [broadcastText, setBroadcastText] = useState('');
  const [broadcastTextError, setBroadcastTextError] = useState('');
  const [broadcastButtonEnabled, setBroadcastButtonEnabled] = useState(false);
  const [broadcastButtonUrl, setBroadcastButtonUrl] = useState('');
  const [broadcastButtonText, setBroadcastButtonText] = useState('Открыть');
  const [broadcastButtonUrlError, setBroadcastButtonUrlError] = useState('');
  const [broadcastButtonTextError, setBroadcastButtonTextError] = useState('');
  const [broadcastImageEnabled, setBroadcastImageEnabled] = useState(false);
  const [broadcastImageBase64, setBroadcastImageBase64] = useState('');
  const [broadcastImageMimeType, setBroadcastImageMimeType] = useState('');
  const [broadcastImageFileName, setBroadcastImageFileName] = useState('');
  const [broadcastImageError, setBroadcastImageError] = useState('');

  const settingsQuery = useQuery({
    queryKey: ['channel-settings', chatId],
    queryFn: () => api.getChannelSettings(chatId),
    enabled: Boolean(chatId),
  });

  const channelHeaderQuery = useQuery({
    queryKey: ['channel-header', chatId],
    queryFn: () => api.getChannelHeader(chatId),
    enabled: Boolean(chatId),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (!settingsQuery.data) {
      return;
    }

    setDraft(settingsQuery.data);
    setSavedSnapshot(settingsQuery.data);
    setAutosaveState('idle');
    lastFailedDraftKeyRef.current = null;
  }, [settingsQuery.data]);

  useEffect(() => {
    setBroadcastText('');
    setBroadcastTextError('');
    setBroadcastButtonEnabled(false);
    setBroadcastButtonUrl('');
    setBroadcastButtonText('Открыть');
    setBroadcastButtonUrlError('');
    setBroadcastButtonTextError('');
    setBroadcastImageEnabled(false);
    setBroadcastImageBase64('');
    setBroadcastImageMimeType('');
    setBroadcastImageFileName('');
    setBroadcastImageError('');
  }, [chatId]);

  useEffect(() => {
    if (!chatId) {
      return;
    }

    saveLastEntityId('channel', chatId);
    if (routeChatTitle) {
      saveChatTitle(chatId, routeChatTitle);
    }
  }, [chatId, routeChatTitle]);

  const resolvedTitle = useMemo(() => {
    const fromHeader = channelHeaderQuery.data?.title?.trim();
    if (fromHeader) {
      return fromHeader;
    }

    if (routeChatTitle) {
      return routeChatTitle;
    }

    return readChatTitle(chatId);
  }, [channelHeaderQuery.data?.title, chatId, routeChatTitle]);

  useEffect(() => {
    if (!chatId || !resolvedTitle) {
      return;
    }

    saveChatTitle(chatId, resolvedTitle);
  }, [chatId, resolvedTitle]);

  const resolvedChannelLink = useMemo(() => {
    const fromHeader = channelHeaderQuery.data?.link?.trim() ?? '';
    if (isHttpUrl(fromHeader)) {
      return fromHeader;
    }

    if (routeChatLink) {
      return routeChatLink;
    }

    return '';
  }, [channelHeaderQuery.data?.link, routeChatLink]);

  function toggleSection(section: ChannelSettingsSectionKey) {
    setExpandedSections((current) => ({
      ...current,
      [section]: !current[section],
    }));
  }

  function toggleHint(hintKey: ChannelSettingsHintKey) {
    setOpenHintKey((current) => (current === hintKey ? null : hintKey));
  }

  const normalizedDraft = useMemo(
    () => (draft ? normalizeChannelSettingsDraft(draft, resolvedChannelLink) : null),
    [draft, resolvedChannelLink],
  );

  const normalizedSavedSnapshot = useMemo(
    () =>
      savedSnapshot ? normalizeChannelSettingsDraft(savedSnapshot, resolvedChannelLink) : null,
    [resolvedChannelLink, savedSnapshot],
  );

  const normalizedDraftKey = useMemo(
    () => (normalizedDraft ? JSON.stringify(normalizedDraft) : ''),
    [normalizedDraft],
  );

  const normalizedSavedSnapshotKey = useMemo(
    () => (normalizedSavedSnapshot ? JSON.stringify(normalizedSavedSnapshot) : ''),
    [normalizedSavedSnapshot],
  );

  const isDirty = useMemo(() => {
    if (!normalizedDraft || !normalizedSavedSnapshot) {
      return false;
    }

    return normalizedDraftKey !== normalizedSavedSnapshotKey;
  }, [normalizedDraft, normalizedDraftKey, normalizedSavedSnapshot, normalizedSavedSnapshotKey]);

  const patchDraft = <K extends keyof ChannelSettings>(key: K, value: ChannelSettings[K]) => {
    setDraft((current) => {
      if (!current) {
        return current;
      }

      const nextDraft: ChannelSettings = {
        ...current,
        [key]: value,
      };

      nextDraft.autoPostButtonsMode = sanitizeAutoPostButtonsMode(
        nextDraft.autoPostButtonsMode,
        nextDraft.commentsEnabled,
        nextDraft.postSuggestionsEnabled,
      );

      return nextDraft;
    });
  };

  useEffect(() => {
    latestNormalizedDraftRef.current = normalizedDraft;
    latestDraftKeyRef.current = normalizedDraftKey;
    isDirtyRef.current = isDirty;
  }, [isDirty, normalizedDraft, normalizedDraftKey]);

  const clearAutosaveTimer = () => {
    if (autosaveTimerRef.current !== null) {
      window.clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
  };

  const clearAutosaveHideTimer = () => {
    if (autosaveHideTimerRef.current !== null) {
      window.clearTimeout(autosaveHideTimerRef.current);
      autosaveHideTimerRef.current = null;
    }
  };

  useEffect(
    () => () => {
      clearAutosaveTimer();
      clearAutosaveHideTimer();
    },
    [],
  );

  const saveCurrentDraft = async ({
    force = false,
  }: {
    force?: boolean;
  } = {}): Promise<ChannelSettings | null> => {
    const payload = latestNormalizedDraftRef.current;
    const payloadKey = latestDraftKeyRef.current;

    if (!payload || (!force && !isDirtyRef.current)) {
      return null;
    }

    if (!force && payloadKey === lastFailedDraftKeyRef.current) {
      setAutosaveState('error');
      return null;
    }

    if (saveInFlightRef.current) {
      return saveInFlightRef.current;
    }

    clearAutosaveTimer();
    clearAutosaveHideTimer();
    setAutosaveState('saving');

    const request = api
      .updateChannelSettings(chatId, payload)
      .then((saved) => {
        lastFailedDraftKeyRef.current = null;
        setSavedSnapshot(saved);
        setDraft((current) => {
          if (!current) {
            return current;
          }

          const currentNormalized = normalizeChannelSettingsDraft(current, resolvedChannelLink);
          return JSON.stringify(currentNormalized) === payloadKey ? saved : current;
        });
        setAutosaveState('saved');
        autosaveHideTimerRef.current = window.setTimeout(() => {
          setAutosaveState((current) => (current === 'saved' ? 'idle' : current));
          autosaveHideTimerRef.current = null;
        }, AUTOSAVE_SAVED_HIDE_MS);
        return saved;
      })
      .catch((error: unknown) => {
        lastFailedDraftKeyRef.current = payloadKey;
        setAutosaveState('error');
        throw error;
      })
      .finally(() => {
        saveInFlightRef.current = null;
      });

    saveInFlightRef.current = request;
    return request;
  };

  useEffect(() => {
    clearAutosaveTimer();

    if (!chatId || !normalizedDraft || !normalizedSavedSnapshot || !isDirty) {
      return;
    }

    if (saveInFlightRef.current) {
      setAutosaveState('saving');
      return;
    }

    if (normalizedDraftKey === lastFailedDraftKeyRef.current) {
      setAutosaveState('error');
      return;
    }

    clearAutosaveHideTimer();
    setAutosaveState('saving');
    autosaveTimerRef.current = window.setTimeout(() => {
      void saveCurrentDraft();
    }, AUTOSAVE_DELAY_MS);

    return clearAutosaveTimer;
  }, [chatId, isDirty, normalizedDraft, normalizedDraftKey, normalizedSavedSnapshot]);

  const sendBroadcastMutation = useMutation({
    mutationFn: (payload: SendBroadcastPayload) => api.sendChannelBroadcast(chatId, payload),
    onSuccess: () => {
      pushToast({
        tone: 'success',
        title: 'Пост отправлен',
        description: 'Сообщение опубликовано в канал.',
      });
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось отправить пост',
        description: normalizeApiError(error),
      });
    },
  });

  const publishMutation = useMutation({
    mutationFn: async () => {
      if (!chatId) {
        throw new Error('Канал не выбран.');
      }

      const payload = latestNormalizedDraftRef.current;
      if (!payload) {
        throw new Error('Нет данных для публикации.');
      }

      const { includeCommentsButton, includeSuggestButton } = resolveManualPublishButtons(payload);
      return api.publishChannelEngagement(chatId, {
        text:
          payload.engagementMessageText.trim() ||
          'Есть идея или обратная связь? Нажмите кнопку ниже.',
        commentsButtonText: '💬 Комментарии',
        suggestButtonText: payload.postSuggestionsButtonText.trim() || '📰 Предложить пост',
        includeCommentsButton,
        includeSuggestButton,
      });
    },
    onSuccess: (result) => {
      pushToast({
        tone: 'success',
        title: result.updatedExisting ? 'Пост обновлен' : 'Пост опубликован',
        description: result.updatedExisting
          ? 'Текст и кнопки обновлены в уже опубликованном сообщении.'
          : 'Сообщение с кнопками отправлено в канал.',
      });
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Ошибка публикации',
        description: normalizeApiError(error),
      });
    },
  });

  if (!chatId) {
    return (
      <div className="page-stack page-enter">
        <GlassCard>
          <StatusState
            tone="warning"
            title="Канал не выбран"
            description="Откройте канал из списка на главном экране."
            action={
              <Link to={buildManagedEntitiesRoute('channel')} className="button button--accent">
                К списку
              </Link>
            }
          />
        </GlassCard>
      </div>
    );
  }

  if (settingsQuery.isLoading) {
    return (
      <div className="page-stack page-enter">
        <GlassCard className="settings-section">
          <SkeletonCard lines={6} />
        </GlassCard>
      </div>
    );
  }

  if (settingsQuery.error) {
    return (
      <div className="page-stack page-enter">
        <GlassCard>
          <StatusState
            tone="danger"
            title="Не удалось загрузить настройки"
            description={normalizeApiError(settingsQuery.error)}
            action={
              <button
                type="button"
                className="button button--danger"
                onClick={() => void settingsQuery.refetch()}
              >
                Повторить
              </button>
            }
          />
        </GlassCard>
      </div>
    );
  }

  if (!draft) {
    return (
      <div className="page-stack page-enter">
        <GlassCard className="settings-section">
          <SkeletonCard lines={6} />
        </GlassCard>
      </div>
    );
  }

  const headerStatusTone =
    autosaveState === 'error'
      ? 'error'
      : autosaveState === 'saving'
        ? 'saving'
        : autosaveState === 'saved' || !isDirty
          ? 'saved'
          : 'draft';
  const headerStatusLabel =
    headerStatusTone === 'error'
      ? 'Ошибка'
      : headerStatusTone === 'saving'
        ? 'Сохраняем'
        : headerStatusTone === 'draft'
          ? 'Черновик'
          : 'Сохранено';
  const channelMetaLabel =
    resolvedTitle && resolvedTitle !== chatId
      ? resolvedChannelLink || `ID ${chatId}`
      : 'Настройки канала';
  const showHeaderStatus = headerStatusTone !== 'saved';
  const participantsCountLabel = formatParticipantsCount(
    channelHeaderQuery.data?.participantsCount ?? null,
  );
  const publishButtons = resolveManualPublishButtons(
    normalizedDraft ?? normalizeChannelSettingsDraft(draft, resolvedChannelLink),
  );
  const canPublishEngagement =
    publishButtons.includeCommentsButton || publishButtons.includeSuggestButton;
  const publishHint = !canPublishEngagement
    ? 'Включите хотя бы один сценарий, чтобы публиковать пост с кнопками.'
    : draft.postSuggestionsEnabled
      ? publishButtons.includeCommentsButton
        ? 'На новых постах предложка появится автоматически. В этом сообщении будут кнопки «Комментарии» и «Предложить пост».'
        : 'На новых постах предложка появится автоматически. В этом сообщении будет кнопка «Предложить пост».'
      : publishButtons.includeCommentsButton
        ? 'Автопредложка выключена. Кнопка «Предложить пост» появится только под этим сообщением, вместе с кнопкой «Комментарии».'
        : 'Автопредложка выключена. Кнопка «Предложить пост» появится только под этим сообщением.';
  const broadcastHasImage = broadcastImageEnabled && Boolean(broadcastImageBase64);
  const broadcastHasButton = broadcastButtonEnabled && Boolean(broadcastButtonText.trim());
  const broadcastSystemButtons = normalizedDraft
    ? resolveBroadcastSystemButtons(normalizedDraft)
    : {
        includeCommentsButton: false,
        includeSuggestButton: false,
      };
  const broadcastHasSystemButtons =
    broadcastSystemButtons.includeCommentsButton || broadcastSystemButtons.includeSuggestButton;
  const broadcastCanSend = Boolean(broadcastText.trim()) || broadcastHasImage;
  const broadcastHeaderSummary = broadcastCanSend
    ? broadcastHasImage && broadcastHasButton
      ? 'ТЕКСТ, ФОТО И CTA ГОТОВЫ'
      : broadcastHasImage
        ? 'ПОСТ С ФОТО ГОТОВ'
        : broadcastHasButton
          ? 'ПОСТ С CTA ГОТОВ'
          : 'ПОСТ ГОТОВ К ОТПРАВКЕ'
    : 'ТЕКСТ, ФОТО И КНОПКА';
  const broadcastRichTextEnabled = broadcastButtonEnabled || broadcastHasSystemButtons;

  useHintPopoverAutoPosition(openHintKey !== null);

  function resetBroadcastComposer() {
    setBroadcastText('');
    setBroadcastTextError('');
    setBroadcastButtonEnabled(false);
    setBroadcastButtonUrl('');
    setBroadcastButtonText('Открыть');
    setBroadcastButtonUrlError('');
    setBroadcastButtonTextError('');
    setBroadcastImageEnabled(false);
    setBroadcastImageBase64('');
    setBroadcastImageMimeType('');
    setBroadcastImageFileName('');
    setBroadcastImageError('');
  }

  function handleSendChannelBroadcast() {
    const normalizedText = broadcastText.trim();
    const normalizedButtonUrl = broadcastButtonUrl.trim();
    const normalizedButtonText = broadcastButtonText.trim() || 'Открыть';

    setBroadcastTextError('');
    setBroadcastButtonUrlError('');
    setBroadcastButtonTextError('');
    setBroadcastImageError('');

    let hasError = false;

    if (!normalizedText && !broadcastHasImage) {
      setBroadcastTextError('Введите текст или добавьте фото.');
      hasError = true;
    } else if (normalizedText.length > MAX_BROADCAST_TEXT_LENGTH) {
      setBroadcastTextError(`Максимум ${MAX_BROADCAST_TEXT_LENGTH} символов.`);
      hasError = true;
    }

    if (broadcastButtonEnabled) {
      if (!isHttpUrl(normalizedButtonUrl)) {
        setBroadcastButtonUrlError('Укажите корректную ссылку (http/https).');
        hasError = true;
      }
      if (!normalizedButtonText || normalizedButtonText.length > 32) {
        setBroadcastButtonTextError('Введите название кнопки до 32 символов.');
        hasError = true;
      }
    }

    if (broadcastImageEnabled) {
      if (!broadcastImageBase64 || !broadcastImageMimeType) {
        setBroadcastImageError('Загрузите фото.');
        hasError = true;
      }
    }

    if (hasError) {
      return;
    }

    sendBroadcastMutation.mutate({
      text: normalizedText,
      textFormat: 'markdown',
      applyToAllChats: false,
      buttonEnabled: broadcastButtonEnabled,
      buttonUrl: normalizedButtonUrl,
      buttonText: normalizedButtonText,
      imageEnabled: broadcastHasImage,
      imageBase64: broadcastHasImage ? broadcastImageBase64 : '',
      imageMimeType: broadcastHasImage ? broadcastImageMimeType : '',
      imageFileName: broadcastHasImage ? broadcastImageFileName : '',
      sendAt: null,
      cycleEnabled: false,
      cycleEveryHours: 1,
      cycleCount: 1,
    });
  }

  return (
    <div className="channel-settings-screen page-enter">
      <GlassCard className="channel-settings-header" elevated>
        <div className="channel-settings-header__top">
          <Link
            to={buildManagedEntitiesRoute('channel')}
            className="channel-settings-header__back"
            aria-label="Назад к каналам"
          >
            <BackChevronIcon />
          </Link>
          <div className="channel-settings-header__body">
            <div className="channel-settings-header__title-row">
              <div className="channel-settings-header__main">
                <h1>{resolvedTitle || 'Настройки'}</h1>
                <p>{channelMetaLabel}</p>
              </div>
              {showHeaderStatus ? (
                <div className="channel-settings-header__actions">
                  {showHeaderStatus ? (
                    <span
                      className={cn('channel-settings-header__status', `is-${headerStatusTone}`)}
                      aria-live="polite"
                    >
                      {headerStatusLabel}
                    </span>
                  ) : null}
                  {headerStatusTone === 'error' ? (
                    <button
                      type="button"
                      className="channel-settings-header__retry"
                      onClick={() => {
                        lastFailedDraftKeyRef.current = null;
                        void saveCurrentDraft({ force: true });
                      }}
                    >
                      Повторить
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
            {participantsCountLabel ? (
              <div className="channel-settings-header__footer">
                <span
                  className="channel-settings-header__members"
                  aria-label={`Участников: ${participantsCountLabel}`}
                >
                  <ParticipantsIcon />
                  <span>{participantsCountLabel}</span>
                </span>
              </div>
            ) : null}
          </div>
        </div>
      </GlassCard>

      <GlassCard className="channel-settings-card" elevated>
        <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
          <button
            type="button"
            className="settings-section__toggle"
            onClick={() => toggleSection('comments')}
            aria-expanded={expandedSections.comments}
            aria-controls="channel-settings-comments"
          >
            <span className="settings-section__toggle-main">
              <h3>Комментарии</h3>
              <small>
                {draft.commentsEnabled ? 'ОБСУЖДЕНИЕ ВКЛЮЧЕНО' : 'ОБСУЖДЕНИЕ ВЫКЛЮЧЕНО'}
              </small>
            </span>
            <SectionChevron isOpen={expandedSections.comments} />
          </button>
        </div>

        <div
          id="channel-settings-comments"
          className={cn('settings-section__collapse', expandedSections.comments && 'is-open')}
        >
          <div className="settings-section__collapse-inner">
            <ChannelSettingsToggleCard
              title="Включить комментарии"
              description="Открывает обсуждение под постами канала."
              hintKey="commentsEnabled"
              openHintKey={openHintKey}
              onToggleHint={toggleHint}
              checked={draft.commentsEnabled}
              onChange={(nextValue) => patchDraft('commentsEnabled', nextValue)}
            />

            {draft.commentsEnabled ? (
              <div className="channel-settings-stack">
                <ChannelSettingsToggleCard
                  title="Модерация"
                  description="Бот следит за сообщениями в комментариях."
                  hintKey="commentsModerationEnabled"
                  openHintKey={openHintKey}
                  onToggleHint={toggleHint}
                  checked={draft.commentsModerationEnabled}
                  onChange={(nextValue) => patchDraft('commentsModerationEnabled', nextValue)}
                />

                {draft.commentsModerationEnabled ? (
                  <div className="channel-settings-stack">
                    <ChannelSettingsToggleCard
                      title="Запретить ссылки"
                      description="Комментарий со ссылкой сразу отклоняется."
                      hintKey="commentsBlockLinksEnabled"
                      openHintKey={openHintKey}
                      onToggleHint={toggleHint}
                      checked={draft.commentsBlockLinksEnabled}
                      onChange={(nextValue) => patchDraft('commentsBlockLinksEnabled', nextValue)}
                    />

                    <ChannelSettingsToggleCard
                      title="Антиспам"
                      description="Блокирует частые и повторяющиеся комментарии."
                      hintKey="commentsAntiSpamEnabled"
                      openHintKey={openHintKey}
                      onToggleHint={toggleHint}
                      checked={draft.commentsAntiSpamEnabled}
                      onChange={(nextValue) => patchDraft('commentsAntiSpamEnabled', nextValue)}
                    />

                    <ChannelSettingsToggleCard
                      title="Не больше двух подряд"
                      description="Третий комментарий подряд от одного автора отклоняется."
                      hintKey="commentsLimitTwoInRowEnabled"
                      openHintKey={openHintKey}
                      onToggleHint={toggleHint}
                      checked={draft.commentsLimitTwoInRowEnabled}
                      onChange={(nextValue) =>
                        patchDraft('commentsLimitTwoInRowEnabled', nextValue)
                      }
                    />
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </GlassCard>

      <GlassCard className="channel-settings-card" elevated>
        <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
          <button
            type="button"
            className="settings-section__toggle"
            onClick={() => toggleSection('postSuggestions')}
            aria-expanded={expandedSections.postSuggestions}
            aria-controls="channel-settings-post-suggestions"
          >
            <span className="settings-section__toggle-main">
              <h3>Предложить пост</h3>
              <small>
                {draft.postSuggestionsEnabled ? 'ПОД КАЖДЫМ ПОСТОМ' : 'ТОЛЬКО РУЧНАЯ ПУБЛИКАЦИЯ'}
              </small>
            </span>
            <SectionChevron isOpen={expandedSections.postSuggestions} />
          </button>
        </div>

        <div
          id="channel-settings-post-suggestions"
          className={cn(
            'settings-section__collapse',
            expandedSections.postSuggestions && 'is-open',
          )}
        >
          <div className="settings-section__collapse-inner">
            <ChannelSettingsToggleCard
              title="Разрешить предложения"
              description="Автоматически добавляет предложку под каждым новым постом. Если выключить, кнопку можно опубликовать вручную только для одного сообщения."
              hintKey="postSuggestionsEnabled"
              openHintKey={openHintKey}
              onToggleHint={toggleHint}
              checked={draft.postSuggestionsEnabled}
              onChange={(nextValue) => patchDraft('postSuggestionsEnabled', nextValue)}
            />

            <div className="channel-settings-stack">
              <label className="field">
                <div className="channel-settings-field-label">
                  <span>Текст публикации</span>
                  <ChannelSettingsHintAnchor
                    hintKey="engagementMessageText"
                    openHintKey={openHintKey}
                    onToggleHint={toggleHint}
                    label="Пояснение для текста публикации"
                  >
                    Этот текст будет опубликован в канале над кнопками.
                  </ChannelSettingsHintAnchor>
                </div>
                <textarea
                  rows={3}
                  value={draft.engagementMessageText}
                  onChange={(event) => patchDraft('engagementMessageText', event.target.value)}
                  placeholder="Есть идея или обратная связь? Нажмите кнопку ниже."
                />
              </label>

              <label className="field">
                <span>Название кнопки</span>
                <input
                  type="text"
                  value={draft.postSuggestionsButtonText}
                  onChange={(event) => patchDraft('postSuggestionsButtonText', event.target.value)}
                  placeholder="Предложить пост"
                  maxLength={32}
                />
              </label>

              <label className="field">
                <span>Текст</span>
                <textarea
                  rows={3}
                  value={draft.postSuggestionsText}
                  onChange={(event) => patchDraft('postSuggestionsText', event.target.value)}
                  placeholder="Коротко объясните, что отправлять."
                />
              </label>

              <div className="channel-settings-inline-fields">
                <label className="field">
                  <div className="channel-settings-field-label">
                    <span>Пост с кнопками</span>
                    <ChannelSettingsHintAnchor
                      hintKey="publishEngagement"
                      openHintKey={openHintKey}
                      onToggleHint={toggleHint}
                      label="Пояснение для поста с кнопками"
                    >
                      {publishHint}
                    </ChannelSettingsHintAnchor>
                  </div>
                </label>
                <button
                  type="button"
                  className="button button--accent"
                  onClick={() => publishMutation.mutate()}
                  disabled={!canPublishEngagement || publishMutation.isPending}
                >
                  {publishMutation.isPending ? 'Публикуем…' : 'Опубликовать или обновить'}
                </button>
              </div>
            </div>
          </div>
        </div>
      </GlassCard>

      <GlassCard className="channel-settings-card" elevated>
        <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
          <button
            type="button"
            className="settings-section__toggle"
            onClick={() => toggleSection('broadcast')}
            aria-expanded={expandedSections.broadcast}
            aria-controls="channel-settings-broadcast"
          >
            <span className="settings-section__toggle-main">
              <h3>Рассылка</h3>
              <small>{broadcastHeaderSummary}</small>
            </span>
            <SectionChevron isOpen={expandedSections.broadcast} />
          </button>
        </div>

        <div
          id="channel-settings-broadcast"
          className={cn('settings-section__collapse', expandedSections.broadcast && 'is-open')}
        >
          <div className="settings-section__collapse-inner">
            <div className="channel-broadcast-studio">
              <label
                className={cn(
                  'field',
                  'mailing-message-field',
                  broadcastTextError && 'field--error',
                )}
              >
                <div className="channel-settings-field-label">
                  <span className="field__label">Текст сообщения</span>
                  <ChannelSettingsHintAnchor
                    hintKey="broadcastText"
                    openHintKey={openHintKey}
                    onToggleHint={toggleHint}
                    label="Пояснение для текста рассылки"
                  >
                    Форматирование в канале сохраняется, если пост сразу публикуется с кнопками.
                    Это может быть ваша CTA-кнопка или системные кнопки комментариев и предложки,
                    если они включены в настройках канала.
                  </ChannelSettingsHintAnchor>
                </div>
                <MaxMarkdownEditor
                  value={broadcastText}
                  onChange={(nextValue) => {
                    setBroadcastText(nextValue);
                    if (broadcastTextError) {
                      setBroadcastTextError('');
                    }
                  }}
                  ariaLabel="Текст рассылки в канал"
                  rows={5}
                  showToolbar={broadcastRichTextEnabled}
                  maxLength={MAX_BROADCAST_TEXT_LENGTH}
                  placeholder="Например: Новый пост уже в канале. Откройте выпуск по кнопке ниже."
                />
                {broadcastRichTextEnabled ? null : (
                  <small className="field__hint">
                    Сейчас у поста нет кнопок, поэтому сообщение опубликуется как обычный текст.
                  </small>
                )}
                {broadcastRichTextEnabled && !broadcastButtonEnabled && broadcastHasSystemButtons ? (
                  <small className="field__hint">
                    Форматирование сохранится: канал добавит системные кнопки сразу при публикации.
                  </small>
                ) : null}
                <div className="mailing-message-field__meta">
                  {broadcastTextError ? (
                    <small className="field__hint">{broadcastTextError}</small>
                  ) : (
                    <span />
                  )}
                  <small
                    className={cn(
                      'mailing-message-field__counter',
                      broadcastText.length >= MAX_BROADCAST_TEXT_LENGTH && 'is-limit',
                    )}
                  >
                    {broadcastText.length}/{MAX_BROADCAST_TEXT_LENGTH}
                  </small>
                </div>
              </label>

              <div className="mailing-options-grid">
                <div
                  className={cn(
                    'mailing-option-card',
                    broadcastImageEnabled && 'is-enabled',
                    broadcastImageError && 'field--error',
                  )}
                >
                  <div className="mailing-option-card__head">
                    <div className="mailing-option-card__title-wrap">
                      <div className="channel-settings-field-label">
                        <span className="mailing-option-card__title">Фото</span>
                        <ChannelSettingsHintAnchor
                          hintKey="broadcastImage"
                          openHintKey={openHintKey}
                          onToggleHint={toggleHint}
                          label="Пояснение для фото в рассылке"
                        >
                          Используйте обложку или ключевой кадр. Поддерживаются изображения до 1 MB.
                        </ChannelSettingsHintAnchor>
                      </div>
                      <small className="mailing-option-card__subtitle">
                        {broadcastHasImage
                          ? 'Изображение будет отправлено с постом.'
                          : 'Необязательно'}
                      </small>
                    </div>

                    <label className="settings-native-switch" aria-label="Добавить фото в пост">
                      <input
                        type="checkbox"
                        checked={broadcastImageEnabled}
                        onChange={(event) => {
                          const enabled = event.target.checked;
                          setBroadcastImageEnabled(enabled);
                          if (!enabled) {
                            setBroadcastImageBase64('');
                            setBroadcastImageMimeType('');
                            setBroadcastImageFileName('');
                            setBroadcastImageError('');
                          }
                        }}
                      />
                      <span className="toggle-switch" aria-hidden>
                        <span className="toggle-switch__thumb" />
                      </span>
                    </label>
                  </div>

                  {broadcastImageEnabled ? (
                    <div className="mailing-option-card__body">
                      <label
                        className={cn(
                          'field',
                          'mailing-upload-field',
                          broadcastImageError && 'field--error',
                        )}
                      >
                        <span className="field__label">Файл изображения</span>
                        <input
                          type="file"
                          accept="image/*"
                          onChange={async (event) => {
                            const file = event.target.files?.[0];
                            if (!file) {
                              setBroadcastImageBase64('');
                              setBroadcastImageMimeType('');
                              setBroadcastImageFileName('');
                              setBroadcastImageError('Выберите фото.');
                              return;
                            }

                            if (!file.type.toLowerCase().startsWith('image/')) {
                              setBroadcastImageBase64('');
                              setBroadcastImageMimeType('');
                              setBroadcastImageFileName('');
                              setBroadcastImageError('Нужен файл изображения.');
                              return;
                            }

                            if (file.size > MAX_BROADCAST_IMAGE_SIZE_BYTES) {
                              setBroadcastImageBase64('');
                              setBroadcastImageMimeType('');
                              setBroadcastImageFileName('');
                              setBroadcastImageError('Фото слишком большое. Максимум 1 MB.');
                              return;
                            }

                            try {
                              const imageBase64 = await fileToBase64(file);
                              setBroadcastImageBase64(imageBase64);
                              setBroadcastImageMimeType(file.type);
                              setBroadcastImageFileName(file.name);
                              setBroadcastImageError('');
                            } catch {
                              setBroadcastImageBase64('');
                              setBroadcastImageMimeType('');
                              setBroadcastImageFileName('');
                              setBroadcastImageError('Не удалось прочитать фото.');
                            }
                          }}
                        />
                        {broadcastImageError ? (
                          <small className="field__hint">{broadcastImageError}</small>
                        ) : broadcastImageFileName ? (
                          <small className="field__hint">{broadcastImageFileName}</small>
                        ) : null}
                      </label>
                    </div>
                  ) : null}
                </div>

                <div
                  className={cn(
                    'mailing-option-card',
                    broadcastButtonEnabled && 'is-enabled',
                    (broadcastButtonUrlError || broadcastButtonTextError) && 'field--error',
                  )}
                >
                  <div className="mailing-option-card__head">
                    <div className="mailing-option-card__title-wrap">
                      <div className="channel-settings-field-label">
                        <span className="mailing-option-card__title">Кнопка</span>
                        <ChannelSettingsHintAnchor
                          hintKey="broadcastButton"
                          openHintKey={openHintKey}
                          onToggleHint={toggleHint}
                          label="Пояснение для кнопки в рассылке"
                        >
                          Добавляйте CTA, когда нужно перевести пользователя в канал, пост или на
                          внешнюю страницу одним нажатием.
                        </ChannelSettingsHintAnchor>
                      </div>
                      <small className="mailing-option-card__subtitle">
                        {broadcastButtonEnabled ? 'CTA включён' : 'Необязательно'}
                      </small>
                    </div>

                    <label
                      className="settings-native-switch"
                      aria-label="Добавить кнопку в пост канала"
                    >
                      <input
                        type="checkbox"
                        checked={broadcastButtonEnabled}
                        onChange={(event) => {
                          const enabled = event.target.checked;
                          setBroadcastButtonEnabled(enabled);
                          if (!enabled) {
                            setBroadcastButtonUrlError('');
                            setBroadcastButtonTextError('');
                          }
                        }}
                      />
                      <span className="toggle-switch" aria-hidden>
                        <span className="toggle-switch__thumb" />
                      </span>
                    </label>
                  </div>

                  {broadcastButtonEnabled ? (
                    <div className="mailing-option-card__body">
                      <label
                        className={cn(
                          'field settings-url-field',
                          broadcastButtonUrlError && 'field--error',
                        )}
                      >
                        <span className="field__label">Ссылка кнопки</span>
                        <input
                          type="url"
                          inputMode="url"
                          value={broadcastButtonUrl}
                          onChange={(event) => {
                            setBroadcastButtonUrl(event.target.value);
                            if (broadcastButtonUrlError) {
                              setBroadcastButtonUrlError('');
                            }
                          }}
                          placeholder="https://max.ru/channel/..."
                        />
                        {broadcastButtonUrlError ? (
                          <small className="field__hint">{broadcastButtonUrlError}</small>
                        ) : null}
                      </label>

                      <label
                        className={cn(
                          'field settings-text-field',
                          broadcastButtonTextError && 'field--error',
                        )}
                      >
                        <span className="field__label">Название кнопки</span>
                        <input
                          type="text"
                          maxLength={32}
                          value={broadcastButtonText}
                          onChange={(event) => {
                            setBroadcastButtonText(event.target.value);
                            if (broadcastButtonTextError) {
                              setBroadcastButtonTextError('');
                            }
                          }}
                          placeholder="Открыть"
                        />
                        {broadcastButtonTextError ? (
                          <small className="field__hint">{broadcastButtonTextError}</small>
                        ) : null}
                      </label>
                    </div>
                  ) : null}
                </div>
              </div>

              <div className="mailing-action-bar">
                <button
                  type="button"
                  className="button button--accent mailing-action-bar__send"
                  onClick={handleSendChannelBroadcast}
                  disabled={sendBroadcastMutation.isPending || !broadcastCanSend}
                >
                  {sendBroadcastMutation.isPending ? 'Отправляем...' : 'Опубликовать в канал'}
                </button>
                <button
                  type="button"
                  className="button button--ghost mailing-action-bar__clear"
                  onClick={resetBroadcastComposer}
                  disabled={sendBroadcastMutation.isPending}
                >
                  Очистить
                </button>
              </div>
            </div>
          </div>
        </div>
      </GlassCard>

      {chatId ? (
        <GlassCard className="channel-settings-card" elevated>
          <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
            <button
              type="button"
              className="settings-section__toggle"
              onClick={() => toggleSection('poll')}
              aria-expanded={expandedSections.poll}
              aria-controls="channel-settings-poll"
            >
              <span className="settings-section__toggle-main">
                <h3>Опрос</h3>
                <small>ГОЛОСОВАНИЕ В ОТДЕЛЬНОМ ПОСТЕ</small>
              </span>
              <SectionChevron isOpen={expandedSections.poll} />
            </button>
          </div>

          <div
            id="channel-settings-poll"
            className={cn('settings-section__collapse', expandedSections.poll && 'is-open')}
          >
            <div className="settings-section__collapse-inner">
              <ManagedPollCard api={api} entityType="channel" entityId={chatId} />
            </div>
          </div>
        </GlassCard>
      ) : null}
    </div>
  );
}
