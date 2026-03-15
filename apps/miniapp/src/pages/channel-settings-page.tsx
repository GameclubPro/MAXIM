import type { ChannelAutoPostButtonsMode, ChannelSettings } from '@maxim/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { startTransition, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { BackChevronIcon, ParticipantsIcon } from '../components/ui/entity-header-icons';
import {
  ChannelBroadcastSectionContent,
  ChannelCommentsSectionContent,
  ChannelPostSuggestionsSectionContent,
} from '../components/settings/channel-settings-sections';
import { ManagedGiveawayCard } from '../components/managed-giveaway-card';
import { MaxMarkdownEditor } from '../components/max-markdown-editor';
import { ManagedPollCard } from '../components/managed-poll-card';
import { GlassCard } from '../components/ui/glass-card';
import { SegmentedControl } from '../components/ui/segmented-control';
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
type ChannelSettingsDetailTabKey =
  | 'overview'
  | 'moderation'
  | 'publish'
  | 'content'
  | 'automation'
  | 'launch';
type ChannelSettingsDetailTabDefinition = {
  value: ChannelSettingsDetailTabKey;
  label: string;
  anchorId: string;
};
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

const CHANNEL_SETTINGS_DETAIL_TABS: Partial<
  Record<ChannelSettingsSectionKey, ChannelSettingsDetailTabDefinition[]>
> = {
  comments: [
    {
      value: 'overview',
      label: 'Основное',
      anchorId: 'channel-settings-detail-comments-overview',
    },
    {
      value: 'moderation',
      label: 'Модерация',
      anchorId: 'channel-settings-detail-comments-moderation',
    },
  ],
  postSuggestions: [
    {
      value: 'overview',
      label: 'Основное',
      anchorId: 'channel-settings-detail-suggest-overview',
    },
    {
      value: 'publish',
      label: 'Публикация',
      anchorId: 'channel-settings-detail-suggest-publish',
    },
  ],
  broadcast: [
    {
      value: 'content',
      label: 'Контент',
      anchorId: 'channel-settings-detail-broadcast-content',
    },
    {
      value: 'automation',
      label: 'Авто',
      anchorId: 'channel-settings-detail-broadcast-automation',
    },
    {
      value: 'launch',
      label: 'Запуск',
      anchorId: 'channel-settings-detail-broadcast-launch',
    },
  ],
};

function parseFocusedChannelSection(value: string | null): ChannelSettingsSectionKey | null {
  if (
    value === 'comments' ||
    value === 'postSuggestions' ||
    value === 'broadcast' ||
    value === 'poll' ||
    value === 'giveaway'
  ) {
    return value;
  }

  return null;
}

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
  const { chatId = '', section: sectionParam } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const routeState = getRouteState(location.state);
  const routeChatTitle = routeState.chatTitle;
  const routeChatLink = routeState.chatLink;
  const focusSection = parseFocusedChannelSection(
    new URLSearchParams(location.search).get('focus'),
  );
  const activeSection = parseFocusedChannelSection(sectionParam ?? null) ?? focusSection;
  const isHubMode = activeSection === null;
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
    giveaway: false,
  });
  const [openHintKey, setOpenHintKey] = useState<ChannelSettingsHintKey | null>(null);
  const [activeDetailTab, setActiveDetailTab] = useState<ChannelSettingsDetailTabKey | ''>('');
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
    if (!activeSection) {
      return;
    }

    setExpandedSections((current) =>
      current[activeSection] ? current : { ...current, [activeSection]: true },
    );
  }, [activeSection]);

  useEffect(() => {
    setActiveDetailTab(
      activeSection ? (CHANNEL_SETTINGS_DETAIL_TABS[activeSection]?.[0]?.value ?? '') : '',
    );
  }, [activeSection]);

  useEffect(() => {
    if (!chatId || sectionParam || !focusSection) {
      return;
    }

    navigate(`/channel/${encodeURIComponent(chatId)}/settings/${focusSection}`, {
      replace: true,
      state: location.state,
    });
  }, [chatId, focusSection, location.state, navigate, sectionParam]);

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
    if (activeSection === section) {
      return;
    }

    startTransition(() => {
      setExpandedSections((current) => ({
        ...current,
        [section]: !current[section],
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
  const detailBackHref = chatId ? `/channel/${encodeURIComponent(chatId)}/settings` : '';
  const isSectionExpanded = (section: ChannelSettingsSectionKey) =>
    activeSection === section || expandedSections[section];
  const isSectionVisible = (section: ChannelSettingsSectionKey) =>
    activeSection === null || activeSection === section;
  const isDetailSection = (section: ChannelSettingsSectionKey) => activeSection === section;
  const hubCards: Array<{
    key: ChannelSettingsSectionKey;
    title: string;
    summary: string;
    description: string;
  }> = [
    {
      key: 'comments',
      title: 'Комментарии',
      summary: draft.commentsEnabled ? 'включены' : 'выключены',
      description: 'Обсуждения, модерация и ограничения в комментариях.',
    },
    {
      key: 'postSuggestions',
      title: 'Предложить пост',
      summary: draft.postSuggestionsEnabled ? 'авто' : 'вручную',
      description: 'Кнопка предложки и пост с вовлекающими кнопками.',
    },
    {
      key: 'broadcast',
      title: 'Рассылка',
      summary: broadcastHeaderSummary,
      description: 'Публикация поста через бота, таймер и цикл.',
    },
    {
      key: 'poll',
      title: 'Опрос',
      summary: 'отдельный пост',
      description: 'Голосование и публикация опроса в канале.',
    },
    {
      key: 'giveaway',
      title: 'Розыгрыши',
      summary: 'управление в боте',
      description: 'Создание, публикация и итоги розыгрышей.',
    },
  ];
  const detailTabs = activeSection ? (CHANNEL_SETTINGS_DETAIL_TABS[activeSection] ?? []) : [];
  const effectiveDetailTab = detailTabs.some((item) => item.value === activeDetailTab)
    ? activeDetailTab
    : (detailTabs[0]?.value ?? '');

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

  function handleDetailTabChange(value: string) {
    const nextValue = value as ChannelSettingsDetailTabKey;
    const target = detailTabs.find((item) => item.value === nextValue);
    setActiveDetailTab(nextValue);

    if (!target) {
      return;
    }

    window.requestAnimationFrame(() => {
      document.getElementById(target.anchorId)?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      });
    });
  }

  return (
    <div className="channel-settings-screen page-enter">
      <GlassCard className="channel-settings-header" elevated>
        <div className="channel-settings-header__top">
          <Link
            to={
              isHubMode
                ? buildManagedEntitiesRoute('channel')
                : detailBackHref || buildManagedEntitiesRoute('channel')
            }
            className="channel-settings-header__back"
            aria-label={isHubMode ? 'Назад к каналам' : 'Назад к разделам'}
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

      {isHubMode ? (
        <GlassCard className="settings-sections-shell settings-hub-shell" padding="sm">
          <div className="settings-hub-grid" role="list" aria-label="Разделы настроек канала">
            {hubCards.map((item) => (
              <Link
                key={item.key}
                to={`/channel/${encodeURIComponent(chatId)}/settings/${item.key}`}
                className="settings-hub-card"
                role="listitem"
              >
                <span className="settings-hub-card__eyebrow">Раздел</span>
                <span className="settings-hub-card__title">{item.title}</span>
                <span className="settings-hub-card__summary">{item.summary}</span>
                <span className="settings-hub-card__description">{item.description}</span>
                <span className="settings-hub-card__cta">Открыть</span>
              </Link>
            ))}
          </div>
        </GlassCard>
      ) : (
        <>
          <div className="settings-detail-topbar">
            <div className="settings-detail-topbar__copy">
              <span className="settings-detail-topbar__eyebrow">Раздел канала</span>
              <strong className="settings-detail-topbar__title">
                {hubCards.find((item) => item.key === activeSection)?.title ?? 'Настройки'}
              </strong>
            </div>
            {detailBackHref ? (
              <Link
                to={detailBackHref}
                className="button button--ghost settings-detail-topbar__back"
              >
                Все разделы
              </Link>
            ) : null}
          </div>
          {detailTabs.length > 0 ? (
            <div className="settings-detail-tabs-shell">
              <SegmentedControl
                value={effectiveDetailTab}
                options={detailTabs}
                onChange={handleDetailTabChange}
                className="settings-detail-tabs"
              />
            </div>
          ) : null}

          <GlassCard
            className={cn(
              'channel-settings-card',
              isDetailSection('comments') && 'channel-settings-card--detail',
            )}
            elevated
            hidden={!isSectionVisible('comments')}
          >
            <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
              <button
                type="button"
                className="settings-section__toggle"
                onClick={() => toggleSection('comments')}
                aria-expanded={isSectionExpanded('comments')}
                aria-controls="channel-settings-comments"
              >
                <span className="settings-section__toggle-main">
                  <h3>Комментарии</h3>
                  <small>{draft.commentsEnabled ? 'включены' : 'выключены'}</small>
                </span>
                <SectionChevron isOpen={isSectionExpanded('comments')} />
              </button>
            </div>

            <div
              id="channel-settings-comments"
              className={cn(
                'settings-section__collapse',
                isSectionExpanded('comments') && 'is-open',
              )}
            >
              <div className="settings-section__collapse-inner">
                <div
                  id="channel-settings-detail-comments-overview"
                  className="settings-detail-anchor"
                />
                <ChannelCommentsSectionContent
                  draft={draft}
                  renderToggleCard={(props) => (
                    <ChannelSettingsToggleCard
                      {...props}
                      openHintKey={openHintKey}
                      onToggleHint={toggleHint}
                    />
                  )}
                  patchField={(field, value) => patchDraft(field, value)}
                />
              </div>
            </div>
          </GlassCard>

          <GlassCard
            className={cn(
              'channel-settings-card',
              isDetailSection('postSuggestions') && 'channel-settings-card--detail',
            )}
            elevated
            hidden={!isSectionVisible('postSuggestions')}
          >
            <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
              <button
                type="button"
                className="settings-section__toggle"
                onClick={() => toggleSection('postSuggestions')}
                aria-expanded={isSectionExpanded('postSuggestions')}
                aria-controls="channel-settings-post-suggestions"
              >
                <span className="settings-section__toggle-main">
                  <h3>Предложить пост</h3>
                  <small>{draft.postSuggestionsEnabled ? 'авто' : 'вручную'}</small>
                </span>
                <SectionChevron isOpen={isSectionExpanded('postSuggestions')} />
              </button>
            </div>

            <div
              id="channel-settings-post-suggestions"
              className={cn(
                'settings-section__collapse',
                isSectionExpanded('postSuggestions') && 'is-open',
              )}
            >
              <div className="settings-section__collapse-inner">
                <div
                  id="channel-settings-detail-suggest-overview"
                  className="settings-detail-anchor"
                />
                <ChannelPostSuggestionsSectionContent
                  draft={draft}
                  publishHint={publishHint}
                  canPublishEngagement={canPublishEngagement}
                  publishPending={publishMutation.isPending}
                  onPublish={() => publishMutation.mutate()}
                  renderHintAnchor={({ hintKey, label, children }) => (
                    <ChannelSettingsHintAnchor
                      hintKey={hintKey}
                      openHintKey={openHintKey}
                      onToggleHint={toggleHint}
                      label={label}
                    >
                      {children}
                    </ChannelSettingsHintAnchor>
                  )}
                  renderToggleCard={(props) => (
                    <ChannelSettingsToggleCard
                      {...props}
                      openHintKey={openHintKey}
                      onToggleHint={toggleHint}
                    />
                  )}
                  patchField={(field, value) => patchDraft(field, value)}
                />
              </div>
            </div>
          </GlassCard>

          <GlassCard
            className={cn(
              'channel-settings-card',
              isDetailSection('broadcast') && 'channel-settings-card--detail',
            )}
            elevated
            hidden={!isSectionVisible('broadcast')}
          >
            <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
              <button
                type="button"
                className="settings-section__toggle"
                onClick={() => toggleSection('broadcast')}
                aria-expanded={isSectionExpanded('broadcast')}
                aria-controls="channel-settings-broadcast"
              >
                <span className="settings-section__toggle-main">
                  <h3>Рассылка</h3>
                  <small>{broadcastHeaderSummary}</small>
                </span>
                <SectionChevron isOpen={isSectionExpanded('broadcast')} />
              </button>
            </div>

            <div
              id="channel-settings-broadcast"
              className={cn(
                'settings-section__collapse',
                isSectionExpanded('broadcast') && 'is-open',
              )}
            >
              <div className="settings-section__collapse-inner">
                <div
                  id="channel-settings-detail-broadcast-content"
                  className="settings-detail-anchor"
                />
                <ChannelBroadcastSectionContent
                  renderHintAnchor={({ hintKey, label, children }) => (
                    <ChannelSettingsHintAnchor
                      hintKey={hintKey}
                      openHintKey={openHintKey}
                      onToggleHint={toggleHint}
                      label={label}
                    >
                      {children}
                    </ChannelSettingsHintAnchor>
                  )}
                  broadcastButtonEnabled={broadcastButtonEnabled}
                  setBroadcastButtonEnabled={(value) => {
                    setBroadcastButtonEnabled(value);
                    if (!value) {
                      setBroadcastButtonUrlError('');
                      setBroadcastButtonTextError('');
                    }
                  }}
                  broadcastButtonUrl={broadcastButtonUrl}
                  setBroadcastButtonUrl={(value) => {
                    setBroadcastButtonUrl(value);
                    if (broadcastButtonUrlError) {
                      setBroadcastButtonUrlError('');
                    }
                  }}
                  broadcastButtonText={broadcastButtonText}
                  setBroadcastButtonText={(value) => {
                    setBroadcastButtonText(value);
                    if (broadcastButtonTextError) {
                      setBroadcastButtonTextError('');
                    }
                  }}
                  broadcastButtonUrlError={broadcastButtonUrlError}
                  broadcastButtonTextError={broadcastButtonTextError}
                  broadcastScheduleEnabled={broadcastScheduleEnabled}
                  setBroadcastScheduleEnabled={(value) => {
                    setBroadcastScheduleEnabled(value);
                    if (!value) {
                      setBroadcastScheduleError('');
                    }
                  }}
                  broadcastScheduleDays={broadcastScheduleDays}
                  setBroadcastScheduleDays={(value) => {
                    setBroadcastScheduleDays(value);
                    if (broadcastScheduleError) {
                      setBroadcastScheduleError('');
                    }
                  }}
                  broadcastScheduleTime={broadcastScheduleTime}
                  setBroadcastScheduleTime={(value) => {
                    setBroadcastScheduleTime(value);
                    if (broadcastScheduleError) {
                      setBroadcastScheduleError('');
                    }
                  }}
                  broadcastScheduleError={broadcastScheduleError}
                  broadcastSchedulePreview={broadcastSchedulePreview}
                  broadcastCycleEnabled={broadcastCycleEnabled}
                  setBroadcastCycleEnabled={(value) => {
                    setBroadcastCycleEnabled(value);
                    if (!value) {
                      setBroadcastCycleError('');
                    }
                  }}
                  broadcastCycleEveryHours={broadcastCycleEveryHours}
                  setBroadcastCycleEveryHours={(value) => {
                    setBroadcastCycleEveryHours(clampBroadcastCycleHours(value));
                    if (broadcastCycleError) {
                      setBroadcastCycleError('');
                    }
                  }}
                  broadcastCycleCount={broadcastCycleCount}
                  setBroadcastCycleCount={(value) => {
                    setBroadcastCycleCount(value);
                    if (broadcastCycleError) {
                      setBroadcastCycleError('');
                    }
                  }}
                  broadcastCycleError={broadcastCycleError}
                  minCycleHours={MIN_BROADCAST_CYCLE_HOURS}
                  maxCycleHours={MAX_BROADCAST_CYCLE_HOURS}
                  maxCycleCount={MAX_BROADCAST_CYCLE_COUNT}
                  maxScheduleDays={MAX_BROADCAST_SCHEDULE_DAYS}
                  onSend={handleSendChannelBroadcast}
                  onReset={resetBroadcastComposer}
                  isSending={handoffBroadcastMutation.isPending}
                />
              </div>
            </div>
          </GlassCard>

          {chatId ? (
            <GlassCard
              className={cn(
                'channel-settings-card',
                isDetailSection('poll') && 'channel-settings-card--detail',
              )}
              elevated
              hidden={!isSectionVisible('poll')}
            >
              <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
                <button
                  type="button"
                  className="settings-section__toggle"
                  onClick={() => toggleSection('poll')}
                  aria-expanded={isSectionExpanded('poll')}
                  aria-controls="channel-settings-poll"
                >
                  <span className="settings-section__toggle-main">
                    <h3>Опрос</h3>
                    <small>отдельный пост</small>
                  </span>
                  <SectionChevron isOpen={isSectionExpanded('poll')} />
                </button>
              </div>

              <div
                id="channel-settings-poll"
                className={cn('settings-section__collapse', isSectionExpanded('poll') && 'is-open')}
              >
                <div className="settings-section__collapse-inner">
                  <ManagedPollCard api={api} entityType="channel" entityId={chatId} />
                </div>
              </div>
            </GlassCard>
          ) : null}

          {chatId ? (
            <GlassCard
              className={cn(
                'channel-settings-card',
                isDetailSection('giveaway') && 'channel-settings-card--detail',
              )}
              elevated
              hidden={!isSectionVisible('giveaway')}
            >
              <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
                <button
                  type="button"
                  className="settings-section__toggle"
                  onClick={() => toggleSection('giveaway')}
                  aria-expanded={isSectionExpanded('giveaway')}
                  aria-controls="channel-settings-giveaway"
                >
                  <span className="settings-section__toggle-main">
                    <h3>Розыгрыши</h3>
                    <small>управление в боте</small>
                  </span>
                  <SectionChevron isOpen={isSectionExpanded('giveaway')} />
                </button>
              </div>

              <div
                id="channel-settings-giveaway"
                className={cn(
                  'settings-section__collapse',
                  isSectionExpanded('giveaway') && 'is-open',
                )}
              >
                <div className="settings-section__collapse-inner">
                  <ManagedGiveawayCard api={api} entityType="channel" entityId={chatId} />
                </div>
              </div>
            </GlassCard>
          ) : null}
        </>
      )}
    </div>
  );
}
