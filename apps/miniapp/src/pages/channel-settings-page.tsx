import type {
  BroadcastLinkButton,
  ChannelAutoPostButtonsMode,
  ChannelSettings,
} from '@maxim/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import '../styles/lazy-pages.css';
import { startTransition, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  BroadcastSchedulePlanner,
  type BroadcastSchedulePlannerSelectionState,
} from '../components/broadcast-schedule-planner';
import { BroadcastLinkButtonsEditor } from '../components/broadcast-link-buttons-editor';
import { ManagedGiveawayCard } from '../components/managed-giveaway-card';
import { ManagedPollCard } from '../components/managed-poll-card';
import { CompactStickyHeader } from '../components/ui/compact-sticky-header';
import { EntityAvatar } from '../components/ui/entity-avatar';
import { GlassCard } from '../components/ui/glass-card';
import { SkeletonCard } from '../components/ui/skeleton';
import { SettingsDrilldownPanel } from '../components/ui/settings-drilldown-panel';
import { SettingsSectionToggle } from '../components/ui/settings-section-toggle';
import { StatusState } from '../components/ui/status-state';
import { useToast } from '../components/ui/toast';
import {
  getChannelBroadcastHandoffState,
  getChannelSettingsScreen,
  handoffChannelBroadcast,
  updateChannelSettings,
} from '../lib/api/channel-settings-client';
import type { ApiTransport } from '../lib/api/transport';
import type { BroadcastHandoffPayload } from '../lib/api/shared-types';
import {
  buildBroadcastLinkButtonLegacyFields,
  createEmptyBroadcastLinkButton,
  formatBroadcastButtonsStatus,
  hasBroadcastLinkButtonErrors,
  trimBroadcastLinkButtons,
  validateBroadcastLinkButtons,
  type BroadcastLinkButtonFieldErrors,
} from '../lib/broadcast-link-buttons';
import {
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
  avatarUrl: string | null;
};

type ChannelSettingsSectionKey = 'comments' | 'postSuggestions' | 'broadcast' | 'poll' | 'giveaway';
type ChannelSettingsHintKey =
  | 'commentsEnabled'
  | 'commentsModerationEnabled'
  | 'commentsBlockLinksEnabled'
  | 'commentsAntiSpamEnabled'
  | 'commentsLimitTwoInRowEnabled'
  | 'postSuggestionsEnabled'
  | 'broadcastStudio'
  | 'broadcastText'
  | 'broadcastImage'
  | 'broadcastButton'
  | 'broadcastSend';

const MIN_BROADCAST_CYCLE_HOURS = 1;
const BROADCAST_HOUR_MS = 60 * 60 * 1_000;
const CHANNEL_SUGGESTION_DAILY_LIMIT_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
const DESKTOP_TOGGLE_ROW_BLOCKERS = [
  'a',
  'button',
  'input',
  'label',
  'select',
  'summary',
  'textarea',
  '[role="button"]',
  '[role="link"]',
  '[contenteditable="true"]',
  '.channel-settings-hint-anchor',
  '.channel-settings-hint-popover',
  '.settings-native-toggle__hint',
].join(', ');
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
  futureSlotCount: 0,
  isDaySheetOpen: false,
  isConfirmed: false,
};

function toLocalTimeInputValue(value: Date): string {
  const hours = String(value.getHours()).padStart(2, '0');
  const minutes = String(value.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
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

function sanitizeAutoPostButtonsMode(
  _mode: ChannelAutoPostButtonsMode,
  commentsEnabled: boolean,
  suggestEnabled: boolean,
): ChannelAutoPostButtonsMode {
  return buildAutoPostButtonsMode(commentsEnabled, suggestEnabled);
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
    return { chatTitle: '', chatLink: '', avatarUrl: null };
  }

  const row = state as Record<string, unknown>;
  const chatTitle =
    typeof row.chatTitle === 'string' && row.chatTitle.trim() ? row.chatTitle.trim() : '';
  const candidateLink =
    typeof row.chatLink === 'string' && row.chatLink.trim() ? row.chatLink.trim() : '';
  const chatLink = isHttpUrl(candidateLink) ? candidateLink : '';
  const avatarUrl =
    typeof row.avatarUrl === 'string' && row.avatarUrl.trim() ? row.avatarUrl.trim() : null;

  return { chatTitle, chatLink, avatarUrl };
}

function resolveDesktopToggleRowLabel(target: EventTarget | null): HTMLLabelElement | null {
  if (
    typeof window === 'undefined' ||
    typeof window.matchMedia !== 'function' ||
    !window.matchMedia('(hover: hover) and (pointer: fine)').matches ||
    !(target instanceof HTMLElement)
  ) {
    return null;
  }

  if (window.getSelection()?.type === 'Range') {
    return null;
  }

  if (target.closest(DESKTOP_TOGGLE_ROW_BLOCKERS)) {
    return null;
  }

  const row = target.closest('.settings-native-toggle__row');
  if (!row) {
    return null;
  }

  const switchLabel = row.querySelector<HTMLLabelElement>('.settings-native-switch');
  const switchInput = switchLabel?.querySelector<HTMLInputElement>('input[type="checkbox"]');
  if (!switchLabel || !switchInput || switchInput.disabled) {
    return null;
  }

  return switchLabel;
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

function formatChannelCountLabel(
  count: number,
  singular: string,
  few: string,
  plural: string,
): string {
  const safeCount = Math.max(0, Math.trunc(count));
  const remainder100 = safeCount % 100;
  const remainder10 = safeCount % 10;

  if (remainder100 >= 11 && remainder100 <= 19) {
    return `${safeCount} ${plural}`;
  }

  if (remainder10 === 1) {
    return `${safeCount} ${singular}`;
  }

  if (remainder10 >= 2 && remainder10 <= 4) {
    return `${safeCount} ${few}`;
  }

  return `${safeCount} ${plural}`;
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
    postSuggestionsDailyLimit: Math.max(
      1,
      Math.min(10, Math.trunc(draft.postSuggestionsDailyLimit || 10)),
    ),
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
  const navigate = useNavigate();
  const { isCompact: isHeaderCompact, isHidden: isHeaderHidden } = useAutoHideHeader();
  const routeState = getRouteState(location.state);
  const routeChatTitle = routeState.chatTitle;
  const routeChatLink = routeState.chatLink;
  const routeAvatarUrl = routeState.avatarUrl;
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
  const [, setBroadcastTextError] = useState('');
  const [broadcastButtons, setBroadcastButtons] = useState<BroadcastLinkButton[]>([]);
  const [broadcastButtonRevealSignal, setBroadcastButtonRevealSignal] = useState(0);
  const [broadcastButtonErrors, setBroadcastButtonErrors] = useState<
    BroadcastLinkButtonFieldErrors[]
  >([]);
  const [broadcastImageEnabled, setBroadcastImageEnabled] = useState(false);
  const [, setBroadcastImageBase64] = useState('');
  const [, setBroadcastImageMimeType] = useState('');
  const [, setBroadcastImageFileName] = useState('');
  const [broadcastScheduledSlots, setBroadcastScheduledSlots] = useState<string[]>([]);
  const [broadcastBotHasContent, setBroadcastBotHasContent] = useState(false);
  const [, setBroadcastImageError] = useState('');
  const [, setBroadcastScheduleEnabled] = useState(false);
  const [, setBroadcastScheduleDays] = useState(0);
  const [, setBroadcastScheduleTime] = useState(
    toLocalTimeInputValue(new Date(Date.now() + BROADCAST_HOUR_MS)),
  );
  const [broadcastScheduleError, setBroadcastScheduleError] = useState('');
  const [, setBroadcastCycleEnabled] = useState(false);
  const [, setBroadcastCycleEveryHours] = useState(MIN_BROADCAST_CYCLE_HOURS);
  const [, setBroadcastCycleCount] = useState(2);
  const [, setBroadcastCycleError] = useState('');
  const [broadcastPlannerResetKey, setBroadcastPlannerResetKey] = useState(0);
  const [broadcastPlannerState, setBroadcastPlannerState] =
    useState<BroadcastSchedulePlannerSelectionState>(EMPTY_BROADCAST_PLANNER_STATE);
  const appliedBroadcastHandoffSignatureRef = useRef<string | null>(null);

  const settingsScreenQuery = useQuery({
    queryKey: ['channel-settings-screen', chatId],
    queryFn: ({ signal }) => getChannelSettingsScreen(api, chatId, { signal }),
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
    if (
      focusSection !== 'broadcast' &&
      focusSection !== 'comments' &&
      focusSection !== 'giveaway' &&
      focusSection !== 'poll' &&
      focusSection !== 'postSuggestions'
    ) {
      return;
    }

    setExpandedSections((current) => ({
      ...current,
      ...(focusSection === 'comments'
        ? { comments: true }
        : focusSection === 'postSuggestions'
          ? { postSuggestions: true }
          : focusSection === 'poll'
            ? { poll: true }
            : focusSection === 'giveaway'
              ? { giveaway: true }
              : { broadcast: true }),
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
    setBroadcastButtons(broadcastHandoffStateQuery.data.buttons);
    setBroadcastScheduledSlots(
      sortAndUniqueBroadcastSlots(broadcastHandoffStateQuery.data.scheduledSlots),
    );
    setBroadcastBotHasContent(broadcastHandoffStateQuery.data.hasContent);
    setBroadcastText('');
    setBroadcastImageEnabled(false);
    setBroadcastImageBase64('');
    setBroadcastImageMimeType('');
    setBroadcastImageFileName('');
    setBroadcastButtonErrors([]);
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
    setBroadcastButtons([]);
    setBroadcastBotHasContent(false);
    setBroadcastButtonErrors([]);
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
    if (expandedSections[section]) {
      closeSection(section);
      return;
    }

    startTransition(() => {
      setExpandedSections({
        ...INITIAL_EXPANDED_CHANNEL_SECTIONS,
        [section]: true,
      });
    });
  }

  function toggleHint(hintKey: ChannelSettingsHintKey) {
    setOpenHintKey((current) => (current === hintKey ? null : hintKey));
  }

  function closeSection(section: ChannelSettingsSectionKey) {
    if (
      (section === 'broadcast' && focusSection === 'broadcast') ||
      (section === 'comments' && focusSection === 'comments') ||
      (section === 'postSuggestions' && focusSection === 'postSuggestions') ||
      (section === 'poll' && focusSection === 'poll') ||
      (section === 'giveaway' && focusSection === 'giveaway')
    ) {
      const nextSearchParams = new URLSearchParams(location.search);
      nextSearchParams.delete('focus');
      nextSearchParams.delete('handoff');
      navigate(
        {
          pathname: location.pathname,
          search: nextSearchParams.toString() ? `?${nextSearchParams.toString()}` : '',
        },
        { replace: true, state: location.state },
      );
    }

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
  const normalizedBroadcastButtons = trimBroadcastLinkButtons(broadcastButtons);
  const broadcastHasButton = normalizedBroadcastButtons.length > 0;
  const broadcastSlotsLabel = formatChannelCountLabel(
    broadcastScheduledSlots.length,
    'слот',
    'слота',
    'слотов',
  );
  const broadcastSlotsSummary =
    broadcastScheduledSlots.length > 0 ? broadcastSlotsLabel : 'без слотов';
  const normalizedBroadcastText = broadcastText.trim();
  const broadcastContentReady = broadcastBotHasContent;
  const broadcastButtonDraftValid = !hasBroadcastLinkButtonErrors(
    validateBroadcastLinkButtons(normalizedBroadcastButtons),
  );
  const broadcastPlannerPending =
    broadcastPlannerState.pickedDayCount > 0 || broadcastPlannerState.isDaySheetOpen;
  const broadcastScheduleReady = broadcastScheduledSlots.length > 0 && !broadcastPlannerPending;
  const broadcastHasFutureSlots = broadcastPlannerState.futureSlotCount > 0;
  const showBroadcastPrimaryAction =
    handoffBroadcastMutation.isPending ||
    (broadcastScheduleReady &&
      broadcastButtonDraftValid &&
      broadcastPlannerState.isConfirmed &&
      broadcastHasFutureSlots);
  const showBroadcastResetAction =
    broadcastScheduledSlots.length > 0 ||
    normalizedBroadcastText.length > 0 ||
    broadcastImageEnabled ||
    broadcastHasButton;
  const broadcastHeaderSummary = [broadcastSlotsSummary, broadcastContentReady ? 'готово' : null]
    .filter(Boolean)
    .join(' · ');
  const commentsCardSummary = !draft.commentsEnabled
    ? 'обсуждение через бота выключено'
    : draft.commentsModerationEnabled
      ? 'обсуждение через бота с модерацией'
      : 'обсуждение через бота без модерации';
  const commentsCardStatus = !draft.commentsEnabled
    ? 'Выкл'
    : draft.commentsModerationEnabled
      ? 'Модер'
      : 'Вкл';
  const postSuggestionsCardSummary = draft.postSuggestionsEnabled
    ? `авто-кнопка · лимит ${draft.postSuggestionsDailyLimit}/24ч`
    : 'ручная публикация кнопки';
  const postSuggestionsCardStatus = draft.postSuggestionsEnabled ? 'Авто' : 'Ручн';
  const broadcastCardStatus =
    broadcastScheduledSlots.length > 0
      ? 'Календ'
      : broadcastHasButton
        ? `${broadcastButtons.length} CTA`
        : 'Бот';
  const broadcastDrilldownFooter = (
    <>
      <div className="settings-drilldown__footer-actions is-single-action">
        <button
          type="button"
          className="button button--accent"
          onClick={handleSendChannelBroadcast}
          disabled={handoffBroadcastMutation.isPending}
        >
          {handoffBroadcastMutation.isPending ? 'Передаём в бота...' : 'Открыть бота'}
        </button>
      </div>
    </>
  );

  function resetBroadcastPlanner() {
    setBroadcastPlannerState(EMPTY_BROADCAST_PLANNER_STATE);
    setBroadcastPlannerResetKey((current) => current + 1);
  }

  function resetBroadcastComposer() {
    setBroadcastText('');
    setBroadcastTextError('');
    setBroadcastBotHasContent(false);
    setBroadcastButtons([]);
    setBroadcastButtonErrors([]);
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

  function validateBroadcastButtonDraft() {
    const nextErrors = validateBroadcastLinkButtons(normalizedBroadcastButtons);
    setBroadcastButtonErrors(nextErrors);
    return !hasBroadcastLinkButtonErrors(nextErrors);
  }

  function buildBroadcastHandoffPayload(): BroadcastHandoffPayload {
    const scheduledSlots = sortAndUniqueBroadcastSlots(broadcastScheduledSlots);
    const buttonState = buildBroadcastLinkButtonLegacyFields(normalizedBroadcastButtons);

    return {
      applyToAllChats: false,
      buttons: buttonState.buttons,
      buttonEnabled: buttonState.buttonEnabled,
      buttonUrl: buttonState.buttonUrl,
      buttonText: buttonState.buttonText,
      scheduleMode: 'calendar',
      scheduleTimezone: resolveBroadcastScheduleTimezone(),
      scheduledSlots,
      sendAt: null,
      cycleEnabled: false,
      cycleEveryHours: 1,
      cycleCount: Math.max(scheduledSlots.length, 1),
    };
  }

  function handleSendChannelBroadcast() {
    const scheduledSlots = sortAndUniqueBroadcastSlots(broadcastScheduledSlots);
    setBroadcastScheduleError('');
    setBroadcastCycleError('');

    let hasError = false;

    if (!validateBroadcastButtonDraft()) {
      hasError = true;
    }

    if (scheduledSlots.length === 0) {
      setBroadcastScheduleError('Добавьте хотя бы один слот публикации.');
      hasError = true;
    } else if (broadcastPlannerState.futureSlotCount === 0) {
      setBroadcastScheduleError('Добавьте хотя бы один будущий слот публикации.');
      hasError = true;
    }
    setBroadcastCycleError('');

    if (hasError) {
      return;
    }

    handoffBroadcastMutation.mutate(buildBroadcastHandoffPayload());
  }

  function handleDesktopToggleRowClick(event: MouseEvent<HTMLElement>) {
    const switchLabel = resolveDesktopToggleRowLabel(event.target);
    if (!switchLabel) {
      return;
    }

    event.preventDefault();
    switchLabel.click();
  }

  return (
    <div
      className="channel-settings-screen page-enter"
      onClickCapture={handleDesktopToggleRowClick}
    >
      <CompactStickyHeader
        backTo={buildManagedEntitiesRoute('channel')}
        backLabel="Назад к каналам"
        title={resolvedTitle || 'Настройки'}
        subtitle="Настройки канала"
        avatar={
          <EntityAvatar
            title={resolvedTitle || 'Настройки'}
            entityType="channel"
            avatarUrl={channelHeader?.avatarUrl ?? routeAvatarUrl ?? null}
            className="compact-page-header__entity-avatar"
          />
        }
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
            title="Обсуждение"
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
          title="Обсуждение"
          summary={commentsCardSummary}
          tone="sky"
          className="settings-drilldown__panel--board settings-drilldown__panel--channel-comments"
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
                  title="Включить обсуждение"
                  description="Тред под постами через бота. Это отдельно от нативных комментариев MAX."
                  hintKey="commentsEnabled"
                  openHintKey={openHintKey}
                  onToggleHint={toggleHint}
                  checked={draft.commentsEnabled}
                  onChange={(nextValue) => patchDraft('commentsEnabled', nextValue)}
                />

                {draft.commentsEnabled ? (
                  <div className="channel-settings-stack">
                    <label className="field">
                      <span>Текст-подсказка в диалоге комментариев</span>
                      <textarea
                        rows={3}
                        value={draft.commentsMessageText}
                        onChange={(event) => patchDraft('commentsMessageText', event.target.value)}
                        placeholder="Напишите, о чём участник должен оставить комментарий."
                      />
                    </label>

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
          tone="mint"
          className="settings-drilldown__panel--notice settings-drilldown__panel--post-suggestions"
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
                    <span>Требования для предложки</span>
                    <textarea
                      rows={4}
                      value={draft.postSuggestionsText}
                      onChange={(event) => patchDraft('postSuggestionsText', event.target.value)}
                      placeholder="Опишите, что пользователь должен прислать боту после нажатия кнопки."
                    />
                  </label>

                  <label className="field">
                    <span>Текст поста с кнопками</span>
                    <textarea
                      rows={3}
                      value={draft.engagementMessageText}
                      onChange={(event) => patchDraft('engagementMessageText', event.target.value)}
                      placeholder="Есть идея или обратная связь? Нажмите кнопку ниже."
                    />
                    <span className="field__hint">
                      Используется, когда бот публикует CTA-пост с кнопками обсуждения и предложки.
                    </span>
                  </label>

                  <label className="field">
                    <span>Максимум предложек от одного подписчика</span>
                    <div className="field__number-wrap">
                      <select
                        value={String(draft.postSuggestionsDailyLimit)}
                        onChange={(event) =>
                          patchDraft('postSuggestionsDailyLimit', Number(event.target.value))
                        }
                      >
                        {CHANNEL_SUGGESTION_DAILY_LIMIT_OPTIONS.map((value) => (
                          <option key={value} value={value}>
                            {value}
                          </option>
                        ))}
                      </select>
                      <small>/ 24ч</small>
                    </div>
                    <span className="field__hint">
                      Считается отдельно для каждого подписчика и канала за последние 24 часа.
                    </span>
                  </label>
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
          tone="sky"
          className="settings-drilldown__panel--campaign settings-drilldown__panel--broadcast"
          onClose={() => toggleSection('broadcast')}
          footer={showBroadcastPrimaryAction ? broadcastDrilldownFooter : undefined}
        >
          <div
            id="channel-settings-broadcast"
            className={cn('settings-section__collapse', expandedSections.broadcast && 'is-open')}
          >
            {expandedSections.broadcast ? (
              <div className="settings-section__collapse-inner">
                <div className="channel-broadcast-studio">
                  {showBroadcastResetAction ? (
                    <div className="managed-broadcast-editor-note__actions">
                      <button
                        type="button"
                        className="managed-broadcast-editor-note__link"
                        onClick={resetBroadcastComposer}
                        disabled={handoffBroadcastMutation.isPending}
                      >
                        Очистить
                      </button>
                    </div>
                  ) : null}

                  <div className="broadcast-compose-flow">
                    <div className="broadcast-stage-card broadcast-stage-card--planner">
                      <div className="broadcast-stage-card__head">
                        <div className="broadcast-stage-card__title-wrap">
                          <strong>Выберите дни</strong>
                        </div>
                        <span
                          className={cn(
                            'broadcast-stage-card__status',
                            broadcastHasFutureSlots ? 'is-ready' : 'is-pending',
                          )}
                        >
                          {broadcastHasFutureSlots ? broadcastSlotsLabel : 'Нет слотов'}
                        </span>
                      </div>

                      <div className="broadcast-stage-card__body">
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
                      </div>
                    </div>

                    <div className="broadcast-stage-card">
                      <div className="broadcast-stage-card__head">
                        <div className="broadcast-stage-card__title-wrap">
                          <strong>Кнопка</strong>
                        </div>
                        <span
                          className={cn(
                            'broadcast-stage-card__status',
                            broadcastHasButton ? 'is-ready' : 'is-muted',
                          )}
                        >
                          {formatBroadcastButtonsStatus(normalizedBroadcastButtons)}
                        </span>
                      </div>

                      <div className="broadcast-stage-card__body">
                        <div className="mailing-options-grid">
                          <div
                            className={cn(
                              'mailing-option-card',
                              broadcastHasButton && 'is-enabled',
                              hasBroadcastLinkButtonErrors(broadcastButtonErrors) && 'field--error',
                            )}
                          >
                            <div className="mailing-option-card__head">
                              <span className="mailing-option-card__title">Добавить кнопку</span>

                              <label
                                className="settings-native-switch"
                                aria-label="Добавить кнопку в пост канала"
                              >
                                  <input
                                    type="checkbox"
                                    checked={broadcastHasButton}
                                    onChange={(event) => {
                                      const enabled = event.target.checked;
                                      if (enabled && broadcastButtons.length === 0) {
                                        setBroadcastButtonRevealSignal((current) => current + 1);
                                      }
                                      setBroadcastButtons((current) =>
                                        enabled
                                          ? current.length > 0
                                          ? current
                                          : [createEmptyBroadcastLinkButton()]
                                        : [],
                                    );
                                    if (!enabled) {
                                      setBroadcastButtonErrors([]);
                                    }
                                  }}
                                />
                                <span className="toggle-switch" aria-hidden>
                                  <span className="toggle-switch__thumb" />
                                </span>
                              </label>
                            </div>

                            {broadcastHasButton ? (
                              <div className="mailing-option-card__body">
                                <BroadcastLinkButtonsEditor
                                  api={api}
                                  contextEntityType="channel"
                                  buttons={broadcastButtons}
                                  errors={broadcastButtonErrors}
                                  revealNextStepSignal={broadcastButtonRevealSignal}
                                  onChange={(nextButtons) => {
                                    setBroadcastButtons(nextButtons);
                                    if (broadcastButtonErrors.length > 0) {
                                      setBroadcastButtonErrors([]);
                                    }
                                  }}
                                  urlPlaceholder="https://max.ru/channel/..."
                                  textPlaceholder="Открыть"
                                />
                              </div>
                            ) : null}
                          </div>
                        </div>
                      </div>
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
            tone="ink"
            className="settings-drilldown__panel--campaign settings-drilldown__panel--poll"
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
            tone="amber"
            className="settings-drilldown__panel--campaign settings-drilldown__panel--giveaway"
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
