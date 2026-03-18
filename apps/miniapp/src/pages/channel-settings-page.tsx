import type { ChannelAutoPostButtonsMode, ChannelSettings } from '@maxim/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { startTransition, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import {
  BroadcastSchedulePlanner,
  type BroadcastSchedulePlannerSelectionState,
} from '../components/broadcast-schedule-planner';
import { ManagedGiveawayCard } from '../components/managed-giveaway-card';
import { MaxMarkdownEditor } from '../components/max-markdown-editor';
import { ManagedPollCard } from '../components/managed-poll-card';
import { CompactStickyHeader } from '../components/ui/compact-sticky-header';
import { GlassCard } from '../components/ui/glass-card';
import { SkeletonCard } from '../components/ui/skeleton';
import { SettingsDrilldownPanel } from '../components/ui/settings-drilldown-panel';
import { SettingsSectionToggle } from '../components/ui/settings-section-toggle';
import { StatusState } from '../components/ui/status-state';
import { useToast } from '../components/ui/toast';
import {
  getChannelSettingsScreen,
  getChannelBroadcastHandoffState,
  handoffChannelBroadcast,
  publishChannelEngagement,
  updateChannelSettings,
} from '../lib/api/channel-settings-client';
import type { ApiTransport } from '../lib/api/transport';
import type { BroadcastHandoffPayload } from '../lib/api/shared-types';
import {
  countBroadcastScheduleDays,
  resolveBroadcastScheduleTimezone,
  sortAndUniqueBroadcastSlots,
} from '../lib/broadcast-schedule';
import { cn } from '../lib/cn';
import { maxNotify, openMaxBotLink, setMaxClosingConfirmation } from '../lib/max-bridge';
import { readChatTitle, saveChatTitle } from '../lib/chat-titles';
import { useHintPopoverAutoPosition } from '../lib/hint-popover';
import { buildManagedEntitiesRoute, saveLastEntityId } from '../lib/last-chat';
import { useAutoHideHeader } from '../lib/use-auto-hide-header';

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
const EMPTY_BROADCAST_PLANNER_STATE: BroadcastSchedulePlannerSelectionState = {
  pickedDayCount: 0,
  selectedDayCount: 0,
  slotCount: 0,
  isDaySheetOpen: false,
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
  const { isCompact: isHeaderCompact, isHidden: isHeaderHidden } = useAutoHideHeader();
  const routeState = getRouteState(location.state);
  const routeChatTitle = routeState.chatTitle;
  const routeChatLink = routeState.chatLink;
  const [draft, setDraft] = useState<ChannelSettings | null>(null);
  const [savedSnapshot, setSavedSnapshot] = useState<ChannelSettings | null>(null);
  const [autosaveState, setAutosaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
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
  const [broadcastScheduledSlots, setBroadcastScheduledSlots] = useState<string[]>([]);
  const [broadcastBotHasContent, setBroadcastBotHasContent] = useState(false);
  const [broadcastImageError, setBroadcastImageError] = useState('');
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
  const [broadcastPlannerResetKey, setBroadcastPlannerResetKey] = useState(0);
  const [broadcastPlannerState, setBroadcastPlannerState] =
    useState<BroadcastSchedulePlannerSelectionState>(EMPTY_BROADCAST_PLANNER_STATE);
  const appliedBroadcastHandoffSignatureRef = useRef<string | null>(null);

  const settingsScreenQuery = useQuery({
    queryKey: ['channel-settings-screen', chatId],
    queryFn: () => getChannelSettingsScreen(api, chatId),
    enabled: Boolean(chatId),
    refetchOnWindowFocus: false,
  });
  const searchParams = new URLSearchParams(location.search);
  const focusSection = searchParams.get('focus');
  const handoffRequested = searchParams.get('handoff') === '1';
  const broadcastHandoffStateQuery = useQuery({
    queryKey: ['channel-broadcast-handoff', chatId],
    queryFn: () => getChannelBroadcastHandoffState(api, chatId ?? ''),
    enabled: Boolean(chatId) && focusSection === 'broadcast' && handoffRequested,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (focusSection !== 'giveaway' && focusSection !== 'broadcast') {
      return;
    }

    setExpandedSections((current) => ({
      ...current,
      ...(focusSection === 'giveaway' ? { giveaway: true } : { broadcast: true }),
    }));
  }, [focusSection]);

  const settingsQuery = {
    data: settingsScreenQuery.data?.settings,
    isLoading: settingsScreenQuery.isLoading,
    error: settingsScreenQuery.error,
    refetch: settingsScreenQuery.refetch,
  };
  const channelHeader = settingsScreenQuery.data?.header ?? null;
  const managedBroadcasts = settingsScreenQuery.data?.managedBroadcasts ?? [];

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
    if (!broadcastHandoffStateQuery.data) {
      return;
    }

    const signature = JSON.stringify(broadcastHandoffStateQuery.data);
    if (appliedBroadcastHandoffSignatureRef.current === signature) {
      return;
    }

    appliedBroadcastHandoffSignatureRef.current = signature;
    setBroadcastButtonEnabled(broadcastHandoffStateQuery.data.buttonEnabled);
    setBroadcastButtonUrl(broadcastHandoffStateQuery.data.buttonUrl);
    setBroadcastButtonText(broadcastHandoffStateQuery.data.buttonText || 'Открыть');
    setBroadcastScheduledSlots(
      sortAndUniqueBroadcastSlots(broadcastHandoffStateQuery.data.scheduledSlots),
    );
    setBroadcastBotHasContent(broadcastHandoffStateQuery.data.hasContent);
    setBroadcastText('');
    setBroadcastImageEnabled(false);
    setBroadcastImageBase64('');
    setBroadcastImageMimeType('');
    setBroadcastImageFileName('');
    setBroadcastScheduleError('');
    setBroadcastCycleError('');
    resetBroadcastPlanner();
    setExpandedSections((current) => ({ ...current, broadcast: true }));
    if (broadcastHandoffStateQuery.data.hasContent) {
      pushToast({
        tone: 'success',
        title: 'Контент сохранён в боте',
        description: 'Календарь восстановлен из личного чата бота.',
      });
    }
  }, [broadcastHandoffStateQuery.data, pushToast]);

  useEffect(() => {
    setBroadcastText('');
    setBroadcastTextError('');
    setBroadcastButtonEnabled(false);
    setBroadcastButtonUrl('');
    setBroadcastButtonText('Открыть');
    setBroadcastBotHasContent(false);
    setBroadcastButtonUrlError('');
    setBroadcastButtonTextError('');
    setBroadcastImageEnabled(false);
    setBroadcastImageBase64('');
    setBroadcastImageMimeType('');
    setBroadcastImageFileName('');
    setBroadcastScheduledSlots([]);
    setBroadcastImageError('');
    setBroadcastScheduleEnabled(false);
    setBroadcastScheduleDays(0);
    setBroadcastScheduleTime(toLocalTimeInputValue(new Date(Date.now() + BROADCAST_HOUR_MS)));
    setBroadcastScheduleError('');
    setBroadcastCycleEnabled(false);
    setBroadcastCycleEveryHours(MIN_BROADCAST_CYCLE_HOURS);
    setBroadcastCycleCount(2);
    setBroadcastCycleError('');
    resetBroadcastPlanner();
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

  function closeSection(section: ChannelSettingsSectionKey) {
    setExpandedSections((current) =>
      current[section] ? INITIAL_EXPANDED_CHANNEL_SECTIONS : current,
    );
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

  useEffect(() => {
    if (autosaveState === 'error' && normalizedDraftKey !== lastFailedDraftKeyRef.current) {
      setAutosaveState('idle');
      return;
    }

    if (autosaveState === 'saved' && isDirty) {
      setAutosaveState('idle');
    }
  }, [autosaveState, isDirty, normalizedDraftKey]);

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
        : isDirty
          ? 'draft'
          : 'saved';
  const showHeaderStatus = headerStatusTone !== 'saved';
  const compactHeaderStatusLabel =
    headerStatusTone === 'error' ? 'Ошибка' : headerStatusTone === 'saving' ? 'Сохр.' : 'Черн.';
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
  const broadcastSchedulePreview = `${countBroadcastScheduleDays(broadcastScheduledSlots)} дн. · ${broadcastScheduledSlots.length} слота`;
  const normalizedBroadcastButtonUrl = broadcastButtonUrl.trim();
  const normalizedBroadcastButtonText = broadcastButtonText.trim();
  const broadcastButtonDraftValid =
    !broadcastButtonEnabled ||
    (isHttpUrl(normalizedBroadcastButtonUrl) &&
      normalizedBroadcastButtonText.length > 0 &&
      normalizedBroadcastButtonText.length <= 32);
  const broadcastPlannerPending =
    broadcastPlannerState.pickedDayCount > 0 || broadcastPlannerState.isDaySheetOpen;
  const broadcastScheduleReady = broadcastScheduledSlots.length > 0 && !broadcastPlannerPending;
  const showBroadcastPrimaryAction =
    handoffBroadcastMutation.isPending || (broadcastScheduleReady && broadcastButtonDraftValid);
  const broadcastActionTitle = broadcastPlannerPending
    ? 'Закончите выбор времени'
    : broadcastScheduledSlots.length === 0
      ? 'Сначала соберите календарь'
      : 'Проверьте кнопку';
  const broadcastActionHint = broadcastPlannerPending
    ? 'Для отмеченных дней сначала выберите 1, 2 или 3 отправки либо задайте точные часы.'
    : broadcastScheduledSlots.length === 0
      ? 'Отметьте дни и назначьте им время, после этого откроется переход в бота.'
      : 'Заполните ссылку и текст CTA или выключите кнопку, чтобы продолжить.';
  const broadcastHeaderSummary = [
    broadcastBotHasContent ? 'контент уже в боте' : 'контент в боте',
    broadcastHasButton ? 'CTA' : null,
    broadcastScheduledSlots.length > 0 ? `календарь ${broadcastSchedulePreview}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const commentsCardSummary = !draft.commentsEnabled
    ? 'обсуждение выключено'
    : draft.commentsModerationEnabled
      ? 'обсуждение с модерацией'
      : 'обсуждение без модерации';
  const commentsCardStatus = !draft.commentsEnabled
    ? 'Выкл'
    : draft.commentsModerationEnabled
      ? 'Модер'
      : 'Вкл';
  const postSuggestionsCardSummary = draft.postSuggestionsEnabled
    ? 'авто-кнопка под новыми постами'
    : 'ручная публикация кнопки';
  const postSuggestionsCardStatus = draft.postSuggestionsEnabled ? 'Авто' : 'Ручн';
  const broadcastCardStatus =
    broadcastScheduledSlots.length > 0 ? 'Календ' : broadcastHasButton ? 'CTA' : 'Бот';
  const broadcastDrilldownFooter = (
    <div className="mailing-action-bar">
      {showBroadcastPrimaryAction ? (
        <button
          type="button"
          className="button button--accent mailing-action-bar__send"
          onClick={handleSendChannelBroadcast}
          disabled={handoffBroadcastMutation.isPending}
        >
          {handoffBroadcastMutation.isPending ? 'Открываем бота...' : 'Продолжить в боте'}
        </button>
      ) : (
        <div className="mailing-action-bar__note" aria-live="polite">
          <strong>{broadcastActionTitle}</strong>
          <small>{broadcastActionHint}</small>
        </div>
      )}
      <button
        type="button"
        className="button button--ghost mailing-action-bar__clear"
        onClick={resetBroadcastComposer}
        disabled={handoffBroadcastMutation.isPending}
      >
        Очистить
      </button>
    </div>
  );

  function resetBroadcastPlanner() {
    setBroadcastPlannerState(EMPTY_BROADCAST_PLANNER_STATE);
    setBroadcastPlannerResetKey((current) => current + 1);
  }

  function resetBroadcastComposer() {
    setBroadcastText('');
    setBroadcastTextError('');
    setBroadcastBotHasContent(false);
    setBroadcastButtonEnabled(false);
    setBroadcastButtonUrl('');
    setBroadcastButtonText('Открыть');
    setBroadcastButtonUrlError('');
    setBroadcastButtonTextError('');
    setBroadcastImageEnabled(false);
    setBroadcastImageBase64('');
    setBroadcastImageMimeType('');
    setBroadcastImageFileName('');
    setBroadcastScheduledSlots([]);
    setBroadcastImageError('');
    setBroadcastScheduleEnabled(false);
    setBroadcastScheduleDays(0);
    setBroadcastScheduleTime(toLocalTimeInputValue(new Date(Date.now() + BROADCAST_HOUR_MS)));
    setBroadcastScheduleError('');
    setBroadcastCycleEnabled(false);
    setBroadcastCycleEveryHours(MIN_BROADCAST_CYCLE_HOURS);
    setBroadcastCycleCount(2);
    setBroadcastCycleError('');
    resetBroadcastPlanner();
  }

  async function handleSaveChannelSection(section: ChannelSettingsSectionKey) {
    if (!isDirty) {
      closeSection(section);
      return;
    }

    try {
      const saved = await saveCurrentDraft({ force: true });
      if (saved) {
        closeSection(section);
      }
    } catch {
      // Error state is handled in saveCurrentDraft.
    }
  }

  function renderChannelSectionFooter(section: ChannelSettingsSectionKey) {
    return (
      <div className="settings-drilldown__footer-actions is-single-action">
        <button
          type="button"
          className="button button--accent"
          onClick={() => void handleSaveChannelSection(section)}
          disabled={autosaveState === 'saving' || !isDirty}
        >
          {autosaveState === 'saving' ? 'Сохраняем...' : 'Сохранить'}
        </button>
      </div>
    );
  }

  function handleSendChannelBroadcast() {
    const normalizedButtonUrl = broadcastButtonUrl.trim();
    const normalizedButtonText = broadcastButtonText.trim() || 'Открыть';
    const scheduledSlots = sortAndUniqueBroadcastSlots(broadcastScheduledSlots);
    const scheduleTimezone = resolveBroadcastScheduleTimezone();

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

    if (scheduledSlots.length === 0) {
      setBroadcastScheduleError('Добавьте хотя бы один слот публикации.');
      hasError = true;
    } else if (scheduledSlots.some((slot) => new Date(slot).getTime() <= Date.now() + 30_000)) {
      setBroadcastScheduleError('Все слоты должны быть минимум через 30 секунд.');
      hasError = true;
    }
    setBroadcastCycleError('');

    if (hasError) {
      return;
    }

    handoffBroadcastMutation.mutate({
      applyToAllChats: false,
      buttonEnabled: broadcastButtonEnabled,
      buttonUrl: normalizedButtonUrl,
      buttonText: normalizedButtonText,
      scheduleMode: 'calendar',
      scheduleTimezone,
      scheduledSlots,
      sendAt: null,
      cycleEnabled: false,
      cycleEveryHours: 1,
      cycleCount: scheduledSlots.length,
    });
  }

  return (
    <div className="channel-settings-screen page-enter">
      <CompactStickyHeader
        backTo={buildManagedEntitiesRoute('channel')}
        backLabel="Назад к каналам"
        title={resolvedTitle || 'Настройки'}
        compact={isHeaderCompact}
        hidden={isHeaderHidden}
        className="channel-settings-screen__sticky-header"
        aside={
          showHeaderStatus ? (
            <div className="compact-page-header__actions">
              <span
                className={cn(
                  'compact-page-header__status',
                  `compact-page-header__status--${headerStatusTone}`,
                )}
                aria-live="polite"
                aria-label={
                  headerStatusTone === 'error'
                    ? 'Ошибка сохранения'
                    : headerStatusTone === 'saving'
                      ? 'Сохраняем изменения'
                      : 'Есть несохранённые изменения'
                }
                title={
                  headerStatusTone === 'error'
                    ? 'Ошибка сохранения'
                    : headerStatusTone === 'saving'
                      ? 'Сохраняем изменения'
                      : 'Есть несохранённые изменения'
                }
              >
                {compactHeaderStatusLabel}
              </span>
              {headerStatusTone === 'error' ? (
                <button
                  type="button"
                  className="compact-page-header__retry"
                  onClick={() => {
                    lastFailedDraftKeyRef.current = null;
                    void saveCurrentDraft({ force: true });
                  }}
                  aria-label="Повторить сохранение"
                >
                  ↻
                </button>
              ) : null}
            </div>
          ) : null
        }
      />

      <GlassCard className="channel-settings-card" elevated>
        <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
          <SettingsSectionToggle
            title="Комментарии"
            summary=""
            status={commentsCardStatus}
            icon="comments"
            tone="sky"
            open={expandedSections.comments}
            controls="channel-settings-comments"
            onClick={() => toggleSection('comments')}
          />
        </div>

        <SettingsDrilldownPanel
          id="channel-settings-comments"
          open={expandedSections.comments}
          title="Комментарии"
          summary={commentsCardSummary}
          onClose={() => toggleSection('comments')}
          footer={renderChannelSectionFooter('comments')}
        >
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
                          onChange={(nextValue) =>
                            patchDraft('commentsBlockLinksEnabled', nextValue)
                          }
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
        </SettingsDrilldownPanel>
      </GlassCard>

      <GlassCard className="channel-settings-card" elevated>
        <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
          <SettingsSectionToggle
            title="Предложка"
            summary=""
            status={postSuggestionsCardStatus}
            icon="spark"
            tone="mint"
            open={expandedSections.postSuggestions}
            controls="channel-settings-post-suggestions"
            onClick={() => toggleSection('postSuggestions')}
          />
        </div>

        <SettingsDrilldownPanel
          id="channel-settings-post-suggestions"
          open={expandedSections.postSuggestions}
          title="Предложка"
          summary={postSuggestionsCardSummary}
          onClose={() => toggleSection('postSuggestions')}
          footer={renderChannelSectionFooter('postSuggestions')}
        >
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
        </SettingsDrilldownPanel>
      </GlassCard>

      <GlassCard className="channel-settings-card" elevated>
        <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
          <SettingsSectionToggle
            title="Рассылки"
            summary={broadcastHeaderSummary}
            status={broadcastCardStatus}
            icon="send"
            tone="sky"
            open={expandedSections.broadcast}
            controls="channel-settings-broadcast"
            onClick={() => toggleSection('broadcast')}
          />
        </div>

        <SettingsDrilldownPanel
          id="channel-settings-broadcast"
          open={expandedSections.broadcast}
          title="Рассылки"
          summary={broadcastHeaderSummary}
          onClose={() => toggleSection('broadcast')}
          footer={broadcastDrilldownFooter}
        >
          <div
            id="channel-settings-broadcast"
            className={cn('settings-section__collapse', expandedSections.broadcast && 'is-open')}
          >
            {expandedSections.broadcast ? (
              <div className="settings-section__collapse-inner">
                <div className="channel-broadcast-studio">
                  <BroadcastSchedulePlanner
                    resetKey={broadcastPlannerResetKey}
                    value={broadcastScheduledSlots}
                    occupiedSlots={managedBroadcasts.flatMap(
                      (broadcast) => broadcast.scheduledSlots,
                    )}
                    error={broadcastScheduleError}
                    disabled={handoffBroadcastMutation.isPending}
                    onSelectionStateChange={setBroadcastPlannerState}
                    onChange={(nextValue) => {
                      setBroadcastScheduledSlots(nextValue);
                      if (broadcastScheduleError) {
                        setBroadcastScheduleError('');
                      }
                    }}
                  />

                  <div className="mailing-options-grid">
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
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </SettingsDrilldownPanel>
      </GlassCard>

      {chatId ? (
        <GlassCard className="channel-settings-card" elevated>
          <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
            <SettingsSectionToggle
              title="Опросы"
              summary=""
              status="Пост"
              icon="poll"
              tone="ink"
              open={expandedSections.poll}
              controls="channel-settings-poll"
              onClick={() => toggleSection('poll')}
            />
          </div>

          <SettingsDrilldownPanel
            id="channel-settings-poll"
            open={expandedSections.poll}
            title="Опросы"
            summary="Голосование отдельным постом"
            onClose={() => toggleSection('poll')}
          >
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
          </SettingsDrilldownPanel>
        </GlassCard>
      ) : null}

      {chatId ? (
        <GlassCard className="channel-settings-card" elevated>
          <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
            <SettingsSectionToggle
              title="Розыгрыши"
              summary=""
              status="Бот"
              icon="gift"
              tone="amber"
              open={expandedSections.giveaway}
              controls="channel-settings-giveaway"
              onClick={() => toggleSection('giveaway')}
            />
          </div>

          <SettingsDrilldownPanel
            id="channel-settings-giveaway"
            open={expandedSections.giveaway}
            title="Розыгрыши"
            summary="Управление через бота"
            onClose={() => toggleSection('giveaway')}
          >
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
          </SettingsDrilldownPanel>
        </GlassCard>
      ) : null}
    </div>
  );
}
