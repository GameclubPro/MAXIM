import type { ChannelAutoPostButtonsMode, ChannelSettings } from '@maxim/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { startTransition, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { BackChevronIcon, ParticipantsIcon } from '../components/ui/entity-header-icons';
import { ManagedGiveawayCard } from '../components/managed-giveaway-card';
import { MaxMarkdownEditor } from '../components/max-markdown-editor';
import { ManagedPollCard } from '../components/managed-poll-card';
import { GlassCard } from '../components/ui/glass-card';
import { SkeletonCard } from '../components/ui/skeleton';
import { StatusState } from '../components/ui/status-state';
import { useToast } from '../components/ui/toast';
import {
  getChannelSettingsScreen,
  handoffChannelBroadcast,
  publishChannelEngagement,
  updateChannelSettings,
} from '../lib/api/channel-settings-client';
import type { ApiTransport } from '../lib/api/transport';
import type { BroadcastHandoffPayload } from '../lib/api/shared-types';
import { cn } from '../lib/cn';
import { maxNotify, openMaxBotLink, setMaxClosingConfirmation } from '../lib/max-bridge';
import { readChatTitle, saveChatTitle } from '../lib/chat-titles';
import { useHintPopoverAutoPosition } from '../lib/hint-popover';
import { buildManagedEntitiesRoute, saveLastEntityId } from '../lib/last-chat';

type ChannelRouteState = {
  chatTitle: string;
  chatLink: string;
};

type ChannelSettingsSectionKey = 'comments' | 'postSuggestions' | 'broadcast' | 'poll' | 'giveaway';
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
const MAX_BROADCAST_SCHEDULE_DAYS = 14;
const MIN_BROADCAST_CYCLE_HOURS = 1;
const MAX_BROADCAST_CYCLE_HOURS = 14 * 24;
const MAX_BROADCAST_CYCLE_COUNT = 100;
const BROADCAST_HOUR_MS = 60 * 60 * 1_000;
const BROADCAST_DAY_MS = 24 * 60 * 60 * 1_000;
const INITIAL_EXPANDED_CHANNEL_SECTIONS: Record<ChannelSettingsSectionKey, boolean> = {
  comments: false,
  postSuggestions: false,
  broadcast: false,
  poll: false,
  giveaway: false,
};

function buildBroadcastScheduleIso(days: number, time: string): string | null {
  if (!Number.isInteger(days) || days < 0 || days > MAX_BROADCAST_SCHEDULE_DAYS) {
    return null;
  }

  const [hoursRaw, minutesRaw] = time.split(':');
  const hours = Number.parseInt(hoursRaw ?? '', 10);
  const minutes = Number.parseInt(minutesRaw ?? '', 10);
  if (
    Number.isNaN(hours) ||
    Number.isNaN(minutes) ||
    hours < 0 ||
    hours > 23 ||
    minutes < 0 ||
    minutes > 59
  ) {
    return null;
  }

  const scheduledAt = new Date();
  scheduledAt.setDate(scheduledAt.getDate() + days);
  scheduledAt.setHours(hours, minutes, 0, 0);
  return scheduledAt.toISOString();
}

function clampBroadcastCycleHours(value: number): number {
  if (!Number.isFinite(value)) {
    return MIN_BROADCAST_CYCLE_HOURS;
  }

  return Math.max(
    MIN_BROADCAST_CYCLE_HOURS,
    Math.min(MAX_BROADCAST_CYCLE_HOURS, Math.round(value)),
  );
}

function toLocalTimeInputValue(value: Date): string {
  const hours = String(value.getHours()).padStart(2, '0');
  const minutes = String(value.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

function formatBroadcastDateTime(value: string | null): string {
  if (!value) {
    return '';
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return '';
  }

  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(parsed);
}

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

export function ChannelSettingsPage({ api }: { api: ApiTransport }) {
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
  >(INITIAL_EXPANDED_CHANNEL_SECTIONS);
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
  const hasExpandedSection = Object.values(expandedSections).some(Boolean);

  useEffect(() => {
    if (!hasExpandedSection) {
      return undefined;
    }

    const { style: bodyStyle } = document.body;
    const { style: documentStyle } = document.documentElement;
    const previousBodyOverflow = bodyStyle.overflow;
    const previousDocumentOverflow = documentStyle.overflow;

    bodyStyle.overflow = 'hidden';
    documentStyle.overflow = 'hidden';

    return () => {
      bodyStyle.overflow = previousBodyOverflow;
      documentStyle.overflow = previousDocumentOverflow;
    };
  }, [hasExpandedSection]);
  const [broadcastScheduleEnabled, setBroadcastScheduleEnabled] = useState(false);
  const [broadcastScheduleDays, setBroadcastScheduleDays] = useState(0);
  const [broadcastScheduleTime, setBroadcastScheduleTime] = useState(
    toLocalTimeInputValue(new Date(Date.now() + BROADCAST_HOUR_MS)),
  );
  const [broadcastScheduleError, setBroadcastScheduleError] = useState('');
  const [broadcastCycleEnabled, setBroadcastCycleEnabled] = useState(false);
  const [broadcastCycleEveryHours, setBroadcastCycleEveryHours] =
    useState(MIN_BROADCAST_CYCLE_HOURS);
  const [broadcastCycleCount, setBroadcastCycleCount] = useState(2);
  const [broadcastCycleError, setBroadcastCycleError] = useState('');

  const settingsScreenQuery = useQuery({
    queryKey: ['channel-settings-screen', chatId],
    queryFn: () => getChannelSettingsScreen(api, chatId),
    enabled: Boolean(chatId),
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    const focusSection = new URLSearchParams(location.search).get('focus');
    if (focusSection !== 'giveaway') {
      return;
    }

    setExpandedSections((current) => ({ ...current, giveaway: true }));
  }, [location.search]);

  const settingsQuery = {
    data: settingsScreenQuery.data?.settings,
    isLoading: settingsScreenQuery.isLoading,
    error: settingsScreenQuery.error,
    refetch: settingsScreenQuery.refetch,
  };
  const channelHeader = settingsScreenQuery.data?.header ?? null;

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
    setBroadcastScheduleEnabled(false);
    setBroadcastScheduleDays(0);
    setBroadcastScheduleTime(toLocalTimeInputValue(new Date(Date.now() + BROADCAST_HOUR_MS)));
    setBroadcastScheduleError('');
    setBroadcastCycleEnabled(false);
    setBroadcastCycleEveryHours(MIN_BROADCAST_CYCLE_HOURS);
    setBroadcastCycleCount(2);
    setBroadcastCycleError('');
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
    const fromHeader = channelHeader?.title?.trim();
    if (fromHeader) {
      return fromHeader;
    }

    if (routeChatTitle) {
      return routeChatTitle;
    }

    return readChatTitle(chatId);
  }, [channelHeader?.title, chatId, routeChatTitle]);

  useEffect(() => {
    if (!chatId || !resolvedTitle) {
      return;
    }

    saveChatTitle(chatId, resolvedTitle);
  }, [chatId, resolvedTitle]);

  const resolvedChannelLink = useMemo(() => {
    const fromHeader = channelHeader?.link?.trim() ?? '';
    if (isHttpUrl(fromHeader)) {
      return fromHeader;
    }

    if (routeChatLink) {
      return routeChatLink;
    }

    return '';
  }, [channelHeader?.link, routeChatLink]);

  function toggleSection(section: ChannelSettingsSectionKey) {
    startTransition(() => {
      setExpandedSections((current) => ({
        ...INITIAL_EXPANDED_CHANNEL_SECTIONS,
        ...(current[section] ? {} : { [section]: true }),
      }));
    });
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

  useEffect(() => {
    const shouldBlockClose = isDirty || autosaveState === 'saving';
    setMaxClosingConfirmation(shouldBlockClose);
    return () => {
      setMaxClosingConfirmation(false);
    };
  }, [autosaveState, isDirty]);

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

    const request = updateChannelSettings(api, chatId, payload)
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
        maxNotify('error');
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

  const handoffBroadcastMutation = useMutation({
    mutationFn: (payload: BroadcastHandoffPayload) => handoffChannelBroadcast(api, chatId, payload),
    onSuccess: (result) => {
      pushToast({
        tone: 'info',
        title: 'Открываем личный чат бота',
        description: 'Отправьте там текст или фото, затем подтвердите публикацию.',
      });
      maxNotify('success');
      openMaxBotLink(result.botUrl);
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось открыть сбор контента',
        description: normalizeApiError(error),
      });
      maxNotify('error');
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
      return publishChannelEngagement(api, chatId, {
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
      maxNotify('success');
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Ошибка публикации',
        description: normalizeApiError(error),
      });
      maxNotify('error');
    },
  });

  useHintPopoverAutoPosition(openHintKey !== null);

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
    resolvedTitle && resolvedTitle !== chatId && resolvedChannelLink
      ? resolvedChannelLink
      : 'Настройки канала';
  const showHeaderStatus = headerStatusTone !== 'saved';
  const participantsCountLabel = formatParticipantsCount(channelHeader?.participantsCount ?? null);
  const publishButtons = resolveManualPublishButtons(
    normalizedDraft ?? normalizeChannelSettingsDraft(draft, resolvedChannelLink),
  );
  const canPublishEngagement =
    publishButtons.includeCommentsButton || publishButtons.includeSuggestButton;
  const publishHint = !canPublishEngagement
    ? 'Включите хотя бы один сценарий.'
    : draft.postSuggestionsEnabled
      ? publishButtons.includeCommentsButton
        ? 'Опубликуем кнопки «Комментарии» и «Предложить пост».'
        : 'Опубликуем кнопку «Предложить пост».'
      : publishButtons.includeCommentsButton
        ? 'Кнопки будут только в этом посте.'
        : 'Кнопка будет только в этом посте.';
  const broadcastHasButton = broadcastButtonEnabled && Boolean(broadcastButtonText.trim());
  const broadcastSchedulePreview = broadcastScheduleEnabled
    ? formatBroadcastDateTime(
        buildBroadcastScheduleIso(broadcastScheduleDays, broadcastScheduleTime),
      )
    : '';
  const broadcastHeaderSummary = [
    'контент в боте',
    broadcastHasButton ? 'CTA' : null,
    broadcastScheduleEnabled && broadcastSchedulePreview
      ? `таймер ${broadcastSchedulePreview}`
      : null,
    broadcastCycleEnabled ? `цикл ${broadcastCycleCount}x` : null,
  ]
    .filter(Boolean)
    .join(' · ');

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
    setBroadcastScheduleEnabled(false);
    setBroadcastScheduleDays(0);
    setBroadcastScheduleTime(toLocalTimeInputValue(new Date(Date.now() + BROADCAST_HOUR_MS)));
    setBroadcastScheduleError('');
    setBroadcastCycleEnabled(false);
    setBroadcastCycleEveryHours(MIN_BROADCAST_CYCLE_HOURS);
    setBroadcastCycleCount(2);
    setBroadcastCycleError('');
  }

  function handleSendChannelBroadcast() {
    const normalizedButtonUrl = broadcastButtonUrl.trim();
    const normalizedButtonText = broadcastButtonText.trim() || 'Открыть';
    const scheduleIso = broadcastScheduleEnabled
      ? buildBroadcastScheduleIso(broadcastScheduleDays, broadcastScheduleTime)
      : null;
    const cycleEveryHours = clampBroadcastCycleHours(broadcastCycleEveryHours);
    const cycleCount = Math.max(2, Math.min(MAX_BROADCAST_CYCLE_COUNT, broadcastCycleCount));

    setBroadcastButtonUrlError('');
    setBroadcastButtonTextError('');
    setBroadcastScheduleError('');
    setBroadcastCycleError('');

    let hasError = false;

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

    if (broadcastScheduleEnabled) {
      if (!scheduleIso) {
        setBroadcastScheduleError('Проверьте день и время отправки.');
        hasError = true;
      } else if (new Date(scheduleIso).getTime() <= Date.now() + 30_000) {
        setBroadcastScheduleError('Выберите время минимум через 30 секунд.');
        hasError = true;
      }
    }

    if (broadcastCycleEnabled) {
      const firstDelayMs = scheduleIso ? new Date(scheduleIso).getTime() - Date.now() : 0;
      if (firstDelayMs < 0) {
        setBroadcastCycleError('Проверьте стартовое время цикла.');
        hasError = true;
      } else {
        const totalDelayMs = firstDelayMs + (cycleCount - 1) * cycleEveryHours * BROADCAST_HOUR_MS;
        if (totalDelayMs > MAX_BROADCAST_SCHEDULE_DAYS * BROADCAST_DAY_MS) {
          setBroadcastCycleError('Все циклы должны уместиться в 14 дней.');
          hasError = true;
        }
      }
    }

    if (hasError) {
      return;
    }

    handoffBroadcastMutation.mutate({
      applyToAllChats: false,
      buttonEnabled: broadcastButtonEnabled,
      buttonUrl: normalizedButtonUrl,
      buttonText: normalizedButtonText,
      sendAt: broadcastScheduleEnabled ? scheduleIso : null,
      cycleEnabled: broadcastCycleEnabled,
      cycleEveryHours: broadcastCycleEnabled ? cycleEveryHours : 1,
      cycleCount: broadcastCycleEnabled ? cycleCount : 1,
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
              <small>{draft.commentsEnabled ? 'включены' : 'выключены'}</small>
            </span>
            <SectionChevron isOpen={expandedSections.comments} />
          </button>
        </div>

        <div
          id="channel-settings-comments"
          className={cn('settings-section__collapse', expandedSections.comments && 'is-open')}
        >
          {expandedSections.comments ? (
            <div className="settings-section__collapse-inner">
              <ChannelSettingsToggleCard
                title="Включить комментарии"
                description="Обсуждение под постами."
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
                    description="Проверка комментариев."
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
                        description="Ссылки в комментариях блокируются."
                        hintKey="commentsBlockLinksEnabled"
                        openHintKey={openHintKey}
                        onToggleHint={toggleHint}
                        checked={draft.commentsBlockLinksEnabled}
                        onChange={(nextValue) => patchDraft('commentsBlockLinksEnabled', nextValue)}
                      />

                      <ChannelSettingsToggleCard
                        title="Антиспам"
                        description="Блок частых повторов."
                        hintKey="commentsAntiSpamEnabled"
                        openHintKey={openHintKey}
                        onToggleHint={toggleHint}
                        checked={draft.commentsAntiSpamEnabled}
                        onChange={(nextValue) => patchDraft('commentsAntiSpamEnabled', nextValue)}
                      />

                      <ChannelSettingsToggleCard
                        title="Не больше двух подряд"
                        description="Третий подряд блокируется."
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
          ) : null}
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
              <small>{draft.postSuggestionsEnabled ? 'авто' : 'вручную'}</small>
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
          {expandedSections.postSuggestions ? (
            <div className="settings-section__collapse-inner">
              <ChannelSettingsToggleCard
                title="Разрешить предложения"
                description="Кнопка предложки под новыми постами."
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
                      Текст поста перед кнопками.
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
                    onChange={(event) =>
                      patchDraft('postSuggestionsButtonText', event.target.value)
                    }
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
          ) : null}
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
          {expandedSections.broadcast ? (
            <div className="settings-section__collapse-inner">
              <div className="channel-broadcast-studio">
                <div className="mailing-options-grid">
                  <div className="managed-broadcast-editor-note">
                    <strong>Контент в боте</strong>
                    <small>Текст и фото отправляются в личке бота.</small>
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
                            Кнопка для перехода в канал, пост или ссылку.
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

                  <div
                    className={cn(
                      'mailing-option-card',
                      broadcastScheduleEnabled && 'is-enabled',
                      broadcastScheduleError && 'field--error',
                    )}
                  >
                    <div className="mailing-option-card__head">
                      <div className="mailing-option-card__title-wrap">
                        <div className="channel-settings-field-label">
                          <span className="mailing-option-card__title">Таймер</span>
                          <ChannelSettingsHintAnchor
                            hintKey="broadcastText"
                            openHintKey={openHintKey}
                            onToggleHint={toggleHint}
                            label="Пояснение для таймера рассылки"
                          >
                            Можно отложить пост в канал максимум на 14 дней.
                          </ChannelSettingsHintAnchor>
                        </div>
                        <small className="mailing-option-card__subtitle">
                          {broadcastScheduleEnabled && broadcastSchedulePreview
                            ? broadcastSchedulePreview
                            : 'Отправка сразу'}
                        </small>
                      </div>

                      <label
                        className="settings-native-switch"
                        aria-label="Включить таймер для рассылки в канал"
                      >
                        <input
                          type="checkbox"
                          checked={broadcastScheduleEnabled}
                          onChange={(event) => {
                            setBroadcastScheduleEnabled(event.target.checked);
                            if (!event.target.checked) {
                              setBroadcastScheduleError('');
                            }
                          }}
                        />
                        <span className="toggle-switch" aria-hidden>
                          <span className="toggle-switch__thumb" />
                        </span>
                      </label>
                    </div>

                    {broadcastScheduleEnabled ? (
                      <div className="mailing-option-card__body">
                        <label className="field settings-text-field mailing-inline-field">
                          <span className="field__label">Через дней</span>
                          <input
                            type="number"
                            min={0}
                            max={MAX_BROADCAST_SCHEDULE_DAYS}
                            value={broadcastScheduleDays}
                            onChange={(event) => {
                              const nextValue = Number.parseInt(event.target.value, 10);
                              setBroadcastScheduleDays(
                                Number.isNaN(nextValue)
                                  ? 0
                                  : Math.max(0, Math.min(MAX_BROADCAST_SCHEDULE_DAYS, nextValue)),
                              );
                              if (broadcastScheduleError) {
                                setBroadcastScheduleError('');
                              }
                            }}
                          />
                        </label>

                        <label className="field settings-text-field mailing-inline-field">
                          <span className="field__label">Время</span>
                          <input
                            type="time"
                            value={broadcastScheduleTime}
                            onChange={(event) => {
                              setBroadcastScheduleTime(event.target.value);
                              if (broadcastScheduleError) {
                                setBroadcastScheduleError('');
                              }
                            }}
                          />
                        </label>

                        {broadcastScheduleError ? (
                          <small className="field__hint">{broadcastScheduleError}</small>
                        ) : null}
                      </div>
                    ) : null}
                  </div>

                  <div
                    className={cn(
                      'mailing-option-card',
                      broadcastCycleEnabled && 'is-enabled',
                      broadcastCycleError && 'field--error',
                    )}
                  >
                    <div className="mailing-option-card__head">
                      <div className="mailing-option-card__title-wrap">
                        <div className="channel-settings-field-label">
                          <span className="mailing-option-card__title">Цикл</span>
                          <ChannelSettingsHintAnchor
                            hintKey="broadcastImage"
                            openHintKey={openHintKey}
                            onToggleHint={toggleHint}
                            label="Пояснение для цикла рассылки"
                          >
                            Повторяет отправку в канал через заданный интервал. Общая длина цикла не
                            должна превышать 14 дней.
                          </ChannelSettingsHintAnchor>
                        </div>
                        <small className="mailing-option-card__subtitle">
                          {broadcastCycleEnabled
                            ? `${broadcastCycleCount} отправок / ${broadcastCycleEveryHours}ч`
                            : 'Выключено'}
                        </small>
                      </div>

                      <label
                        className="settings-native-switch"
                        aria-label="Включить циклическую рассылку в канал"
                      >
                        <input
                          type="checkbox"
                          checked={broadcastCycleEnabled}
                          onChange={(event) => {
                            setBroadcastCycleEnabled(event.target.checked);
                            if (!event.target.checked) {
                              setBroadcastCycleError('');
                            }
                          }}
                        />
                        <span className="toggle-switch" aria-hidden>
                          <span className="toggle-switch__thumb" />
                        </span>
                      </label>
                    </div>

                    {broadcastCycleEnabled ? (
                      <div className="mailing-option-card__body">
                        <label className="field settings-text-field mailing-inline-field">
                          <span className="field__label">Интервал, часов</span>
                          <input
                            type="number"
                            min={MIN_BROADCAST_CYCLE_HOURS}
                            max={MAX_BROADCAST_CYCLE_HOURS}
                            value={broadcastCycleEveryHours}
                            onChange={(event) => {
                              const nextValue = Number.parseInt(event.target.value, 10);
                              setBroadcastCycleEveryHours(
                                clampBroadcastCycleHours(
                                  Number.isNaN(nextValue) ? MIN_BROADCAST_CYCLE_HOURS : nextValue,
                                ),
                              );
                              if (broadcastCycleError) {
                                setBroadcastCycleError('');
                              }
                            }}
                          />
                        </label>

                        <label className="field settings-text-field mailing-inline-field">
                          <span className="field__label">Количество</span>
                          <input
                            type="number"
                            min={2}
                            max={MAX_BROADCAST_CYCLE_COUNT}
                            value={broadcastCycleCount}
                            onChange={(event) => {
                              const nextValue = Number.parseInt(event.target.value, 10);
                              setBroadcastCycleCount(
                                Number.isNaN(nextValue)
                                  ? 2
                                  : Math.max(2, Math.min(MAX_BROADCAST_CYCLE_COUNT, nextValue)),
                              );
                              if (broadcastCycleError) {
                                setBroadcastCycleError('');
                              }
                            }}
                          />
                        </label>

                        {broadcastCycleError ? (
                          <small className="field__hint">{broadcastCycleError}</small>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </div>

                <div className="mailing-action-bar">
                  <button
                    type="button"
                    className="button button--accent mailing-action-bar__send"
                    onClick={handleSendChannelBroadcast}
                    disabled={handoffBroadcastMutation.isPending}
                  >
                    {handoffBroadcastMutation.isPending ? 'Открываем бота...' : 'Продолжить в боте'}
                  </button>
                  <button
                    type="button"
                    className="button button--ghost mailing-action-bar__clear"
                    onClick={resetBroadcastComposer}
                    disabled={handoffBroadcastMutation.isPending}
                  >
                    Очистить
                  </button>
                </div>
              </div>
            </div>
          ) : null}
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
                <small>отдельный пост</small>
              </span>
              <SectionChevron isOpen={expandedSections.poll} />
            </button>
          </div>

          <div
            id="channel-settings-poll"
            className={cn('settings-section__collapse', expandedSections.poll && 'is-open')}
          >
            {expandedSections.poll ? (
              <div className="settings-section__collapse-inner">
                <ManagedPollCard api={api} entityType="channel" entityId={chatId} />
              </div>
            ) : null}
          </div>
        </GlassCard>
      ) : null}

      {chatId ? (
        <GlassCard className="channel-settings-card" elevated>
          <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
            <button
              type="button"
              className="settings-section__toggle"
              onClick={() => toggleSection('giveaway')}
              aria-expanded={expandedSections.giveaway}
              aria-controls="channel-settings-giveaway"
            >
              <span className="settings-section__toggle-main">
                <h3>Розыгрыши</h3>
                <small>управление в боте</small>
              </span>
              <SectionChevron isOpen={expandedSections.giveaway} />
            </button>
          </div>

          <div
            id="channel-settings-giveaway"
            className={cn('settings-section__collapse', expandedSections.giveaway && 'is-open')}
          >
            {expandedSections.giveaway ? (
              <div className="settings-section__collapse-inner">
                <ManagedGiveawayCard api={api} entityType="channel" entityId={chatId} />
              </div>
            ) : null}
          </div>
        </GlassCard>
      ) : null}
    </div>
  );
}
