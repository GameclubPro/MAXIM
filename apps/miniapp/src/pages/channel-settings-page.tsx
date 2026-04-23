import type {
  BroadcastLinkButton,
  ChannelAutoPostButtonsMode,
  ChannelSettings,
  ChannelSettingsScreenResponse,
  ManagedBroadcastDetails,
} from '@maxim/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import '../styles/lazy-pages.css';
import { startTransition, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  BroadcastSchedulePlanner,
  type BroadcastSchedulePlannerSelectionState,
} from '../components/broadcast-schedule-planner';
import { BroadcastLinkButtonsEditor } from '../components/broadcast-link-buttons-editor';
import { MaxMarkdownPreview } from '../components/max-markdown-preview';
import { ManagedGiveawayCard } from '../components/managed-giveaway-card';
import { ManagedPollCard } from '../components/managed-poll-card';
import { CompactStickyHeader } from '../components/ui/compact-sticky-header';
import { EntityAvatar } from '../components/ui/entity-avatar';
import { GlassCard } from '../components/ui/glass-card';
import { ActionConfirmSheet } from '../components/ui/action-confirm-sheet';
import { ResetIcon } from '../components/ui/reset-icon';
import { SkeletonCard } from '../components/ui/skeleton';
import { SettingsDrilldownPanel } from '../components/ui/settings-drilldown-panel';
import { SettingsSectionToggle } from '../components/ui/settings-section-toggle';
import { StatusState } from '../components/ui/status-state';
import { useToast } from '../components/ui/toast';
import {
  cancelChannelManagedBroadcast,
  clearChannelBroadcastHandoffState,
  getChannelBroadcastHandoffState,
  getChannelManagedBroadcast,
  getChannelSettingsScreen,
  handoffChannelBroadcast,
  retryChannelManagedBroadcast,
  updateChannelManagedBroadcast,
  updateChannelSettings,
} from '../lib/api/channel-settings-client';
import type { ApiTransport } from '../lib/api/transport';
import type { BroadcastHandoffPayload, SendBroadcastPayload } from '../lib/api/shared-types';
import {
  buildBroadcastLinkButtonLegacyFields,
  createEmptyBroadcastLinkButton,
  hasBroadcastLinkButtonErrors,
  trimBroadcastLinkButtons,
  validateBroadcastLinkButtons,
  type BroadcastLinkButtonFieldErrors,
} from '../lib/broadcast-link-buttons';
import {
  resolveBroadcastQuickScheduleSelection,
  resolveBroadcastScheduleTimezone,
  sortAndUniqueBroadcastSlots,
  type BroadcastQuickPreset,
} from '../lib/broadcast-schedule';
import { cn } from '../lib/cn';
import { maxNotify, openMaxBotLinkAndClose, setMaxClosingConfirmation } from '../lib/max-bridge';
import { readChatTitle, saveChatTitle } from '../lib/chat-titles';
import { useHintPopoverAutoPosition } from '../lib/hint-popover';
import { buildManagedEntitiesRoute, saveLastEntityId } from '../lib/last-chat';
import { useAutoHideHeader } from '../lib/use-auto-hide-header';

type ChannelRouteState = {
  chatTitle: string;
  chatLink: string;
  avatarUrl: string | null;
};
type ManagedBroadcastListItem = ChannelSettingsScreenResponse['managedBroadcasts'][number];
type BroadcastCountdownPresentation = {
  label: string;
  value: string;
  caption: string;
};
type ManagedBroadcastCardTone = 'active' | 'warning' | 'danger' | 'muted';

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

function formatDateTimeInTimeZone(
  value: string | null,
  options: Intl.DateTimeFormatOptions,
  timeZone?: string | null,
): string {
  if (!value) {
    return '';
  }

  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return '';
  }

  const formatterOptions = timeZone?.trim() ? { ...options, timeZone } : options;
  return new Intl.DateTimeFormat('ru-RU', formatterOptions).format(date);
}

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

function formatManagedBroadcastDateTime(value: string | null, timeZone?: string | null): string {
  return formatDateTimeInTimeZone(
    value,
    {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    },
    timeZone,
  );
}

function formatCompactManagedBroadcastDateTime(
  value: string | null,
  timeZone?: string | null,
): string {
  return formatDateTimeInTimeZone(
    value,
    {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    },
    timeZone,
  );
}

function formatBroadcastCountdownValue(remainingMs: number): string {
  const totalMinutes = Math.max(0, Math.floor(remainingMs / 60_000));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) {
    return `${days}д ${String(hours).padStart(2, '0')}ч`;
  }

  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}ч ${String(minutes).padStart(2, '0')}м`;
  }

  if (minutes > 0) {
    return `${minutes}м`;
  }

  return '<1м';
}

function resolveBroadcastCountdown(
  nextSendAt: string | null,
  nowMs: number,
  scheduleTimezone?: string | null,
): BroadcastCountdownPresentation | null {
  if (!nextSendAt) {
    return null;
  }

  const targetMs = new Date(nextSendAt).getTime();
  if (!Number.isFinite(targetMs) || targetMs <= nowMs) {
    return null;
  }

  return {
    label: 'До отправки',
    value: formatBroadcastCountdownValue(targetMs - nowMs),
    caption: formatCompactManagedBroadcastDateTime(nextSendAt, scheduleTimezone),
  };
}

function resolveManagedBroadcastCardTone(
  broadcast: ManagedBroadcastListItem,
): ManagedBroadcastCardTone {
  if (broadcast.status === 'FAILED') {
    return 'danger';
  }
  if (broadcast.status === 'PARTIAL') {
    return 'warning';
  }
  if (broadcast.status === 'COMPLETED' || broadcast.status === 'CANCELED') {
    return 'muted';
  }
  return 'active';
}

function resolveManagedBroadcastCardBadge(broadcast: ManagedBroadcastListItem): string {
  if (broadcast.status === 'PARTIAL') {
    return 'Нужно действие';
  }
  if (broadcast.status === 'FAILED') {
    return 'Пауза';
  }
  if (broadcast.status === 'COMPLETED') {
    return 'Завершена';
  }
  if (broadcast.status === 'CANCELED') {
    return 'Остановлена';
  }
  return 'В работе';
}

function resolveManagedBroadcastCardTitle(broadcast: ManagedBroadcastListItem): string {
  if (broadcast.status === 'PARTIAL') {
    return 'Есть ошибки доставки';
  }
  if (broadcast.status === 'FAILED') {
    return 'Нужно повторить отправку';
  }
  if (broadcast.status === 'COMPLETED') {
    return 'Рассылка завершена';
  }
  if (broadcast.status === 'CANCELED') {
    return 'Рассылка остановлена';
  }
  return broadcast.nextSendAt ? 'Следующая отправка' : 'Активная рассылка';
}

function resolveManagedBroadcastMetric(
  broadcast: ManagedBroadcastListItem,
  nowMs: number,
): BroadcastCountdownPresentation & { tone: ManagedBroadcastCardTone } {
  const countdown = resolveBroadcastCountdown(
    broadcast.nextSendAt,
    nowMs,
    broadcast.scheduleTimezone,
  );
  if (countdown && (broadcast.status === 'ACTIVE' || broadcast.status === 'PARTIAL')) {
    return {
      ...countdown,
      tone: broadcast.status === 'PARTIAL' ? 'warning' : 'active',
    };
  }

  if (broadcast.failedChats > 0) {
    return {
      label: 'Ошибки',
      value: String(broadcast.failedChats),
      caption: formatChannelCountLabel(broadcast.failedChats, 'чат', 'чата', 'чатов'),
      tone: broadcast.status === 'FAILED' ? 'danger' : 'warning',
    };
  }

  if (broadcast.pendingChats > 0) {
    return {
      label: 'В очереди',
      value: String(broadcast.pendingChats),
      caption: formatChannelCountLabel(broadcast.pendingChats, 'чат', 'чата', 'чатов'),
      tone: 'active',
    };
  }

  return {
    label: 'Доставлено',
    value: `${broadcast.deliveredChats}/${broadcast.targetChats}`,
    caption: broadcast.applyToAllChats ? 'все чаты' : 'текущий канал',
    tone: broadcast.status === 'COMPLETED' ? 'muted' : 'active',
  };
}

function buildManagedBroadcastFactChips(broadcast: ManagedBroadcastListItem): string[] {
  const scopeLabel = broadcast.applyToAllChats
    ? formatChannelCountLabel(broadcast.targetChats, 'чат', 'чата', 'чатов')
    : 'Текущий канал';
  const scheduleLabel =
    broadcast.scheduleMode === 'calendar'
      ? formatChannelCountLabel(broadcast.scheduledSlots.length, 'слот', 'слота', 'слотов')
      : broadcast.cycleEnabled
        ? `Цикл ${broadcast.sentCount}/${broadcast.cycleCount}`
        : '1 отправка';
  const extras = [
    broadcast.buttonEnabled
      ? `${broadcast.buttons.length > 1 ? broadcast.buttons.length : ''} CTA`.trim()
      : null,
    broadcast.hasImage ? 'Фото' : null,
    broadcast.hasVideo ? 'Видео' : null,
  ]
    .filter((item): item is string => Boolean(item))
    .join(' · ');

  return [
    scopeLabel,
    scheduleLabel,
    extras || null,
    broadcast.pendingChats > 0 ? `В очереди ${broadcast.pendingChats}` : null,
  ].filter((item): item is string => Boolean(item));
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
  const queryClient = useQueryClient();
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
  const [broadcastImageBase64, setBroadcastImageBase64] = useState('');
  const [broadcastImageMimeType, setBroadcastImageMimeType] = useState('');
  const [broadcastImageFileName, setBroadcastImageFileName] = useState('');
  const [broadcastScheduledSlots, setBroadcastScheduledSlots] = useState<string[]>([]);
  const [broadcastQuickPreset, setBroadcastQuickPreset] = useState<BroadcastQuickPreset | null>(
    null,
  );
  const [broadcastScheduleTimezone, setBroadcastScheduleTimezone] = useState(() =>
    resolveBroadcastScheduleTimezone(),
  );
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
  const [editingManagedBroadcast, setEditingManagedBroadcast] =
    useState<ManagedBroadcastDetails | null>(null);
  const [managedBroadcastDeleteTarget, setManagedBroadcastDeleteTarget] =
    useState<ManagedBroadcastListItem | null>(null);
  const [broadcastNowMs, setBroadcastNowMs] = useState(() => Date.now());
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
    enabled:
      Boolean(chatId) &&
      !editingManagedBroadcast &&
      (expandedSections.broadcast || (focusSection === 'broadcast' && handoffRequested)),
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
  const orderedManagedBroadcasts = useMemo(() => {
    const priority = (item: ManagedBroadcastListItem): number => {
      if (item.status === 'FAILED') {
        return 0;
      }
      if (item.status === 'PARTIAL') {
        return 1;
      }
      if (item.status === 'ACTIVE') {
        return 2;
      }
      if (item.status === 'COMPLETED') {
        return 3;
      }
      return 4;
    };

    const parseTimestamp = (value: string | null): number => {
      if (!value) {
        return Number.MAX_SAFE_INTEGER;
      }

      const parsed = new Date(value).getTime();
      return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
    };

    return [...managedBroadcasts].sort((left, right) => {
      const priorityDiff = priority(left) - priority(right);
      if (priorityDiff !== 0) {
        return priorityDiff;
      }

      const nextSendDiff = parseTimestamp(left.nextSendAt) - parseTimestamp(right.nextSendAt);
      if (nextSendDiff !== 0) {
        return nextSendDiff;
      }

      return parseTimestamp(right.updatedAt) - parseTimestamp(left.updatedAt);
    });
  }, [managedBroadcasts]);

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
    setBroadcastQuickPreset(null);
    setBroadcastScheduledSlots(
      sortAndUniqueBroadcastSlots(broadcastHandoffStateQuery.data.scheduledSlots),
    );
    setBroadcastScheduleTimezone(
      broadcastHandoffStateQuery.data.scheduleTimezone.trim() || resolveBroadcastScheduleTimezone(),
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
    if (handoffRequested && broadcastHandoffStateQuery.data.hasContent) {
      pushToast({
        tone: 'success',
        title: 'Контент сохранён в боте',
        description: 'Календарь восстановлен из личного чата бота.',
      });
    }
  }, [broadcastHandoffStateQuery.data, handoffRequested, pushToast]);

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
    setBroadcastQuickPreset(null);
    setBroadcastScheduledSlots([]);
    setBroadcastScheduleTimezone(resolveBroadcastScheduleTimezone());
    setBroadcastImageError('');
    setBroadcastScheduleEnabled(false);
    setBroadcastScheduleDays(0);
    setBroadcastScheduleTime(toLocalTimeInputValue(new Date(Date.now() + BROADCAST_HOUR_MS)));
    setBroadcastScheduleError('');
    setBroadcastCycleEnabled(false);
    setBroadcastCycleEveryHours(MIN_BROADCAST_CYCLE_HOURS);
    setBroadcastCycleCount(2);
    setBroadcastCycleError('');
    setEditingManagedBroadcast(null);
    resetBroadcastPlanner();
  }, [chatId]);

  useEffect(() => {
    const timerId = window.setInterval(() => {
      setBroadcastNowMs(Date.now());
    }, 60_000);

    return () => {
      window.clearInterval(timerId);
    };
  }, []);

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
      if (!openMaxBotLinkAndClose(result.botUrl)) {
        pushToast({
          tone: 'danger',
          title: 'Не удалось открыть бота',
          description: 'Ссылка на handoff вернулась пустой.',
        });
        return;
      }

      pushToast({
        tone: 'info',
        title: 'Открываем личный чат бота',
        description: 'Отправьте там текст или фото, затем подтвердите публикацию.',
      });
      maxNotify('success');
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

  const clearBroadcastHandoffMutation = useMutation({
    mutationFn: () => clearChannelBroadcastHandoffState(api, chatId ?? ''),
    onSuccess: () => {
      resetBroadcastComposer();
      void queryClient.invalidateQueries({ queryKey: ['channel-broadcast-handoff', chatId] });
      pushToast({
        tone: 'success',
        title: 'Черновик очищен',
      });
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось очистить черновик',
        description: normalizeApiError(error),
      });
      maxNotify('error');
    },
  });

  const updateManagedBroadcastMutation = useMutation({
    mutationFn: ({
      broadcastId,
      payload,
    }: {
      broadcastId: string;
      payload: SendBroadcastPayload;
    }) => updateChannelManagedBroadcast(api, chatId ?? '', broadcastId, payload),
    onSuccess: (broadcast) => {
      void queryClient.invalidateQueries({ queryKey: ['channel-settings-screen', chatId] });
      resetBroadcastComposer();
      pushToast({
        tone: broadcast.status === 'FAILED' ? 'info' : 'success',
        title: 'Рассылка обновлена',
        description: broadcast.nextSendAt
          ? `Следующая отправка: ${formatManagedBroadcastDateTime(
              broadcast.nextSendAt,
              broadcast.scheduleTimezone,
            )}.`
          : 'Изменения сохранены.',
      });
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось обновить рассылку',
        description: normalizeApiError(error),
      });
      maxNotify('error');
    },
  });

  const cancelManagedBroadcastMutation = useMutation({
    mutationFn: (broadcastId: string) =>
      cancelChannelManagedBroadcast(api, chatId ?? '', broadcastId),
    onSuccess: (broadcast) => {
      void queryClient.invalidateQueries({ queryKey: ['channel-settings-screen', chatId] });
      setManagedBroadcastDeleteTarget(null);
      if (editingManagedBroadcast?.id === broadcast.id) {
        resetBroadcastComposer();
      }
      pushToast({
        tone: 'info',
        title: 'Рассылка удалена',
      });
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось удалить рассылку',
        description: normalizeApiError(error),
      });
      maxNotify('error');
    },
  });

  const retryManagedBroadcastMutation = useMutation({
    mutationFn: (broadcastId: string) =>
      retryChannelManagedBroadcast(api, chatId ?? '', broadcastId),
    onSuccess: (broadcast) => {
      void queryClient.invalidateQueries({ queryKey: ['channel-settings-screen', chatId] });
      pushToast({
        tone: broadcast.status === 'FAILED' || broadcast.status === 'PARTIAL' ? 'info' : 'success',
        title:
          broadcast.status === 'FAILED' || broadcast.status === 'PARTIAL'
            ? 'Часть чатов всё ещё с ошибкой'
            : 'Повтор выполнен',
        description: broadcast.nextSendAt
          ? `Следующая отправка: ${formatManagedBroadcastDateTime(
              broadcast.nextSendAt,
              broadcast.scheduleTimezone,
            )}.`
          : 'Ошибка закрыта.',
      });
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось повторить рассылку',
        description: normalizeApiError(error),
      });
      maxNotify('error');
    },
  });

  const openManagedBroadcastEditorMutation = useMutation({
    mutationFn: (broadcastId: string) => getChannelManagedBroadcast(api, chatId ?? '', broadcastId),
    onSuccess: (broadcast) => {
      setEditingManagedBroadcast(broadcast);
      setBroadcastText(broadcast.text);
      setBroadcastBotHasContent(false);
      setBroadcastButtons(broadcast.buttons);
      setBroadcastButtonErrors([]);
      setBroadcastImageEnabled(broadcast.imageEnabled);
      setBroadcastImageBase64(broadcast.imageBase64);
      setBroadcastImageMimeType(broadcast.imageMimeType);
      setBroadcastImageFileName(broadcast.imageFileName);
      setBroadcastQuickPreset(null);
      setBroadcastScheduledSlots(sortAndUniqueBroadcastSlots(broadcast.scheduledSlots));
      setBroadcastScheduleTimezone(
        broadcast.scheduleTimezone.trim() || resolveBroadcastScheduleTimezone(),
      );
      setBroadcastTextError('');
      setBroadcastImageError('');
      setBroadcastScheduleError('');
      setBroadcastCycleError('');
      resetBroadcastPlanner();
      setExpandedSections((current) => ({ ...current, broadcast: true }));
      pushToast({
        tone: 'info',
        title: 'Редактирование рассылки',
        description: broadcast.nextSendAt
          ? `Следующая отправка: ${formatManagedBroadcastDateTime(
              broadcast.nextSendAt,
              broadcast.scheduleTimezone,
            )}.`
          : 'Измените слоты и сохраните.',
      });
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось открыть рассылку',
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
  const broadcastOccupiedSlots = managedBroadcasts
    .filter((broadcast) => broadcast.id !== editingManagedBroadcast?.id)
    .flatMap((broadcast) => broadcast.scheduledSlots);
  const isUpdatingManagedBroadcast = updateManagedBroadcastMutation.isPending;
  const isOpeningManagedBroadcastEditor = openManagedBroadcastEditorMutation.isPending;
  const isBroadcastBusy =
    handoffBroadcastMutation.isPending ||
    clearBroadcastHandoffMutation.isPending ||
    isOpeningManagedBroadcastEditor ||
    isUpdatingManagedBroadcast ||
    cancelManagedBroadcastMutation.isPending ||
    retryManagedBroadcastMutation.isPending;
  const broadcastSlotsLabel = formatChannelCountLabel(
    broadcastScheduledSlots.length,
    'слот',
    'слота',
    'слотов',
  );
  const normalizedBroadcastText = broadcastText.trim();
  const editingBroadcastHasVideo =
    editingManagedBroadcast?.mediaType === 'video' && Boolean(editingManagedBroadcast.mediaPayload);
  const broadcastContentReady = editingManagedBroadcast
    ? normalizedBroadcastText.length > 0 || broadcastImageEnabled || editingBroadcastHasVideo
    : broadcastBotHasContent;
  const broadcastButtonDraftValid = !hasBroadcastLinkButtonErrors(
    validateBroadcastLinkButtons(normalizedBroadcastButtons),
  );
  const broadcastQuickSchedule = broadcastQuickPreset
    ? resolveBroadcastQuickScheduleSelection(broadcastQuickPreset)
    : null;
  const broadcastMessageFacts = [
    broadcastImageEnabled ? 'Фото' : null,
    editingBroadcastHasVideo ? 'Видео' : null,
    broadcastHasButton
      ? `${normalizedBroadcastButtons.length > 1 ? normalizedBroadcastButtons.length : ''} CTA`.trim()
      : null,
  ].filter((item): item is string => Boolean(item));
  const broadcastSlotsSummary = broadcastQuickSchedule
    ? broadcastQuickSchedule.summary
    : broadcastScheduledSlots.length > 0
      ? broadcastSlotsLabel
      : 'без слотов';
  const broadcastSelectionSummary = [
    broadcastPlannerState.selectedDayCount > 0
      ? formatChannelCountLabel(broadcastPlannerState.selectedDayCount, 'день', 'дня', 'дней')
      : null,
    broadcastPlannerState.futureSlotCount > 0
      ? formatChannelCountLabel(broadcastPlannerState.futureSlotCount, 'слот', 'слота', 'слотов')
      : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const broadcastPlannerPending =
    broadcastPlannerState.pickedDayCount > 0 || broadcastPlannerState.isDaySheetOpen;
  const broadcastScheduleReady =
    (broadcastScheduledSlots.length > 0 || broadcastQuickSchedule !== null) &&
    !broadcastPlannerPending;
  const broadcastHasFutureSlots =
    broadcastQuickSchedule !== null || broadcastPlannerState.futureSlotCount > 0;
  const showBroadcastPrimaryAction =
    isBroadcastBusy ||
    (broadcastScheduleReady &&
      broadcastButtonDraftValid &&
      (broadcastQuickSchedule !== null || broadcastPlannerState.isConfirmed) &&
      broadcastHasFutureSlots);
  const showBroadcastResetAction =
    editingManagedBroadcast !== null ||
    broadcastQuickPreset !== null ||
    broadcastScheduledSlots.length > 0 ||
    normalizedBroadcastText.length > 0 ||
    broadcastImageEnabled ||
    broadcastHasButton ||
    broadcastBotHasContent;
  const broadcastHeaderSummary = broadcastSlotsSummary;
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
  const broadcastResetActionLabel = editingManagedBroadcast
    ? 'Сбросить изменения'
    : broadcastBotHasContent
      ? 'Очистить черновик в боте'
      : 'Очистить рассылку';
  const broadcastFooterTitle = editingManagedBroadcast
    ? 'Сохранить рассылку'
    : broadcastQuickSchedule
      ? broadcastQuickSchedule.label
      : broadcastSelectionSummary || 'Рассылка';
  const broadcastFooterMeta = [
    'Текущий канал',
    !editingManagedBroadcast && broadcastBotHasContent ? 'В боте' : null,
    broadcastImageEnabled ? 'Фото' : null,
    editingBroadcastHasVideo ? 'Видео' : null,
    broadcastHasButton
      ? `${normalizedBroadcastButtons.length > 1 ? normalizedBroadcastButtons.length : ''} CTA`.trim()
      : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const broadcastDrilldownFooter = (
    <div className="broadcast-publish-bar">
      <div className="broadcast-publish-bar__copy">
        <strong>{broadcastFooterTitle}</strong>
        <small>{broadcastFooterMeta}</small>
      </div>
      <button
        type="button"
        className="button button--accent broadcast-publish-bar__button"
        onClick={handleSendChannelBroadcast}
        disabled={isBroadcastBusy}
      >
        {isUpdatingManagedBroadcast
          ? 'Сохраняем...'
          : handoffBroadcastMutation.isPending
            ? 'Передаём...'
            : isOpeningManagedBroadcastEditor
              ? 'Открываем...'
              : editingManagedBroadcast
                ? 'Сохранить'
                : 'Открыть бота'}
      </button>
    </div>
  );

  function resetBroadcastPlanner() {
    setBroadcastPlannerState(EMPTY_BROADCAST_PLANNER_STATE);
    setBroadcastPlannerResetKey((current) => current + 1);
  }

  function resetBroadcastComposer() {
    setEditingManagedBroadcast(null);
    setBroadcastText('');
    setBroadcastTextError('');
    setBroadcastBotHasContent(false);
    setBroadcastButtons([]);
    setBroadcastButtonErrors([]);
    setBroadcastImageEnabled(false);
    setBroadcastImageBase64('');
    setBroadcastImageMimeType('');
    setBroadcastImageFileName('');
    setBroadcastQuickPreset(null);
    setBroadcastScheduledSlots([]);
    setBroadcastScheduleTimezone(resolveBroadcastScheduleTimezone());
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

  function handleCancelBroadcastEdit() {
    resetBroadcastComposer();
  }

  function handleClearBroadcastComposer() {
    if (editingManagedBroadcast) {
      handleCancelBroadcastEdit();
      return;
    }

    if (!chatId || clearBroadcastHandoffMutation.isPending) {
      resetBroadcastComposer();
      return;
    }

    clearBroadcastHandoffMutation.mutate();
  }

  function handleSelectBroadcastQuickPreset(preset: BroadcastQuickPreset) {
    setBroadcastQuickPreset((current) => (current === preset ? null : preset));
    setBroadcastScheduledSlots([]);
    setBroadcastScheduleError('');
    resetBroadcastPlanner();
  }

  function handleClearBroadcastQuickPreset() {
    setBroadcastQuickPreset(null);
  }

  function handleDeleteManagedBroadcast(broadcast: ManagedBroadcastListItem) {
    if (!chatId || cancelManagedBroadcastMutation.isPending) {
      return;
    }

    setManagedBroadcastDeleteTarget(broadcast);
  }

  function handleEditManagedBroadcast(broadcast: ManagedBroadcastListItem) {
    if (!chatId || openManagedBroadcastEditorMutation.isPending) {
      return;
    }

    openManagedBroadcastEditorMutation.mutate(broadcast.id);
  }

  function handleDeleteManagedBroadcastById(broadcastId: string) {
    const broadcast = managedBroadcasts.find((item) => item.id === broadcastId);
    if (!broadcast) {
      return;
    }

    handleDeleteManagedBroadcast(broadcast);
  }

  function handleEditManagedBroadcastById(broadcastId: string) {
    const broadcast = managedBroadcasts.find((item) => item.id === broadcastId);
    if (!broadcast) {
      return;
    }

    handleEditManagedBroadcast(broadcast);
  }

  function confirmDeleteManagedBroadcast() {
    if (!managedBroadcastDeleteTarget || !chatId || cancelManagedBroadcastMutation.isPending) {
      return;
    }

    cancelManagedBroadcastMutation.mutate(managedBroadcastDeleteTarget.id);
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
    const quickSchedule = broadcastQuickPreset
      ? resolveBroadcastQuickScheduleSelection(broadcastQuickPreset)
      : null;

    return {
      targetMode: 'current',
      targetChatIds: chatId ? [chatId] : [],
      applyToAllChats: false,
      buttons: buttonState.buttons,
      buttonEnabled: buttonState.buttonEnabled,
      buttonUrl: buttonState.buttonUrl,
      buttonText: buttonState.buttonText,
      scheduleMode: quickSchedule ? 'legacy' : 'calendar',
      scheduleTimezone: broadcastScheduleTimezone.trim() || resolveBroadcastScheduleTimezone(),
      scheduledSlots: quickSchedule ? [] : scheduledSlots,
      sendAt: quickSchedule?.sendAt ?? null,
      cycleEnabled: false,
      cycleEveryHours: 1,
      cycleCount: quickSchedule ? 1 : Math.max(scheduledSlots.length, 1),
    };
  }

  function handleSendChannelBroadcast() {
    if (!chatId) {
      return;
    }

    const scheduledSlots = sortAndUniqueBroadcastSlots(broadcastScheduledSlots);
    const quickSchedule = broadcastQuickPreset
      ? resolveBroadcastQuickScheduleSelection(broadcastQuickPreset)
      : null;
    setBroadcastScheduleError('');
    setBroadcastCycleError('');

    let hasError = false;

    if (!validateBroadcastButtonDraft()) {
      hasError = true;
    }

    if (!quickSchedule && scheduledSlots.length === 0) {
      setBroadcastScheduleError('Добавьте хотя бы один слот публикации.');
      hasError = true;
    } else if (!quickSchedule && broadcastPlannerState.futureSlotCount === 0) {
      setBroadcastScheduleError('Добавьте хотя бы один будущий слот публикации.');
      hasError = true;
    }
    setBroadcastCycleError('');

    if (hasError) {
      return;
    }

    const handoffPayload = buildBroadcastHandoffPayload();

    if (editingManagedBroadcast) {
      const keepVideoMedia =
        !broadcastImageEnabled &&
        editingManagedBroadcast.mediaType === 'video' &&
        editingManagedBroadcast.mediaPayload;
      const payload: SendBroadcastPayload = {
        text: normalizedBroadcastText,
        textFormat: editingManagedBroadcast.textFormat,
        ...handoffPayload,
        imageEnabled: broadcastImageEnabled,
        imageBase64: broadcastImageEnabled ? broadcastImageBase64 : '',
        imageMimeType: broadcastImageEnabled ? broadcastImageMimeType : '',
        imageFileName: broadcastImageEnabled ? broadcastImageFileName : '',
        mediaType: keepVideoMedia ? 'video' : null,
        mediaPayload: keepVideoMedia ? editingManagedBroadcast.mediaPayload : null,
        mediaMimeType: keepVideoMedia ? editingManagedBroadcast.mediaMimeType : '',
        mediaFileName: keepVideoMedia ? editingManagedBroadcast.mediaFileName : '',
      };
      updateManagedBroadcastMutation.mutate({
        broadcastId: editingManagedBroadcast.id,
        payload,
      });
      return;
    }

    handoffBroadcastMutation.mutate(handoffPayload);
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
                    <div className="broadcast-studio-shell__topbar">
                      <button
                        type="button"
                        className="broadcast-shell-reset"
                        onClick={handleClearBroadcastComposer}
                        disabled={isBroadcastBusy}
                        aria-label={
                          clearBroadcastHandoffMutation.isPending
                            ? 'Сбрасываем'
                            : broadcastResetActionLabel
                        }
                        title={
                          clearBroadcastHandoffMutation.isPending
                            ? 'Сбрасываем'
                            : broadcastResetActionLabel
                        }
                      >
                        <ResetIcon />
                      </button>
                    </div>
                  ) : null}

                  <div className="broadcast-compose-flow">
                    <div className="broadcast-stage-card broadcast-stage-card--message">
                      <div className="broadcast-stage-card__head">
                        <div className="broadcast-stage-card__title-wrap">
                          <strong>Сообщение</strong>
                        </div>
                      </div>

                      <div className="broadcast-stage-card__body">
                        <div
                          className={cn(
                            'broadcast-message-card',
                            !broadcastContentReady && 'is-empty',
                          )}
                        >
                          <div className="broadcast-message-card__surface">
                            {editingManagedBroadcast ? (
                              <MaxMarkdownPreview
                                value={broadcastText}
                                className="broadcast-message-card__preview max-markdown-preview--clamp-3"
                                normalizeWhitespace
                                fallback={
                                  broadcastImageEnabled
                                    ? 'Фото без текста'
                                    : editingBroadcastHasVideo
                                      ? 'Видео без текста'
                                      : 'Пусто'
                                }
                              />
                            ) : (
                              <span className="broadcast-message-card__preview broadcast-message-card__preview--placeholder">
                                {broadcastBotHasContent ? 'В боте' : 'Пусто'}
                              </span>
                            )}
                          </div>

                          {broadcastMessageFacts.length > 0 ? (
                            <div className="broadcast-message-card__facts">
                              {broadcastMessageFacts.map((fact) => (
                                <span key={`broadcast-message-${fact}`}>{fact}</span>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </div>

                    <div className="broadcast-stage-card broadcast-stage-card--planner">
                      <div className="broadcast-stage-card__head">
                        <div className="broadcast-stage-card__title-wrap">
                          <strong>Расписание</strong>
                        </div>
                      </div>

                      <div className="broadcast-stage-card__body">
                        <BroadcastSchedulePlanner
                          resetKey={broadcastPlannerResetKey}
                          value={broadcastScheduledSlots}
                          occupiedSlots={broadcastOccupiedSlots}
                          error={broadcastScheduleError}
                          disabled={isBroadcastBusy}
                          managedBroadcasts={managedBroadcasts}
                          managedBroadcastsLoading={
                            settingsScreenQuery.isLoading || settingsScreenQuery.isFetching
                          }
                          currentTargetLabel="Текущий канал"
                          excludeBroadcastId={editingManagedBroadcast?.id ?? null}
                          onEditBroadcast={handleEditManagedBroadcastById}
                          onDeleteBroadcast={handleDeleteManagedBroadcastById}
                          pendingEditBroadcastId={
                            openManagedBroadcastEditorMutation.isPending
                              ? openManagedBroadcastEditorMutation.variables
                              : null
                          }
                          pendingDeleteBroadcastId={
                            cancelManagedBroadcastMutation.isPending
                              ? cancelManagedBroadcastMutation.variables
                              : null
                          }
                          quickPreset={broadcastQuickPreset}
                          onSelectQuickPreset={handleSelectBroadcastQuickPreset}
                          onClearQuickPreset={handleClearBroadcastQuickPreset}
                          onSelectionStateChange={setBroadcastPlannerState}
                          onChange={(nextValue) => {
                            if (broadcastQuickPreset) {
                              setBroadcastQuickPreset(null);
                            }
                            setBroadcastScheduledSlots(nextValue);
                            if (broadcastScheduleError) {
                              setBroadcastScheduleError('');
                            }
                          }}
                        />
                      </div>
                    </div>

                    <div className="broadcast-stage-card broadcast-stage-card--cta">
                      <div className="broadcast-stage-card__head">
                        <div className="broadcast-stage-card__title-wrap">
                          <strong>Кнопка</strong>
                        </div>
                      </div>

                      <div className="broadcast-stage-card__body">
                        <div className="broadcast-cta-toggle">
                          <span
                            className={cn(
                              'broadcast-cta-toggle__pill',
                              broadcastHasButton && 'is-active',
                            )}
                          >
                            {broadcastHasButton
                              ? normalizedBroadcastButtons[0]?.text || 'CTA'
                              : 'Без CTA'}
                          </span>

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
                              disabled={isBroadcastBusy}
                            />
                            <span className="toggle-switch" aria-hidden>
                              <span className="toggle-switch__thumb" />
                            </span>
                          </label>
                        </div>

                        {broadcastHasButton ? (
                          <BroadcastLinkButtonsEditor
                            api={api}
                            contextEntityType="channel"
                            buttons={broadcastButtons}
                            errors={broadcastButtonErrors}
                            revealNextStepSignal={broadcastButtonRevealSignal}
                            compact
                            title="CTA"
                            subtitle=""
                            onChange={(nextButtons) => {
                              setBroadcastButtons(nextButtons);
                              if (broadcastButtonErrors.length > 0) {
                                setBroadcastButtonErrors([]);
                              }
                            }}
                            disabled={isBroadcastBusy}
                            urlPlaceholder="https://max.ru/channel/..."
                            textPlaceholder="Открыть"
                          />
                        ) : null}
                      </div>
                    </div>

                    <div className="broadcast-stage-card broadcast-stage-card--feed">
                      <div className="broadcast-stage-card__head">
                        <div className="broadcast-stage-card__title-wrap">
                          <strong>{editingManagedBroadcast ? 'Редактирование' : 'Рассылки'}</strong>
                          <small>
                            {editingManagedBroadcast
                              ? 'Черновик'
                              : orderedManagedBroadcasts.length > 0
                                ? `${orderedManagedBroadcasts.length} в работе`
                                : 'Пусто'}
                          </small>
                        </div>
                      </div>

                      <div className="broadcast-stage-card__body">
                        {editingManagedBroadcast ? (
                          <div className={cn('managed-broadcast-card', 'is-active')}>
                            <div className="managed-broadcast-card__top">
                              <span className="managed-broadcast-card__main">
                                <span className={cn('managed-broadcast-card__badge', 'is-active')}>
                                  Черновик
                                </span>
                                <strong>Редактирование рассылки</strong>
                                <MaxMarkdownPreview
                                  value={editingManagedBroadcast.text}
                                  className="managed-broadcast-card__preview max-markdown-preview--clamp-2"
                                  normalizeWhitespace
                                  fallback={
                                    editingManagedBroadcast.imageEnabled ? 'Фото без текста' : null
                                  }
                                />
                              </span>
                              <span className="managed-broadcast-card__aside">
                                <span className={cn('managed-broadcast-card__metric', 'is-active')}>
                                  <small>Следующая</small>
                                  <strong>
                                    {formatCompactManagedBroadcastDateTime(
                                      editingManagedBroadcast.nextSendAt,
                                      editingManagedBroadcast.scheduleTimezone,
                                    ) || 'По слотам'}
                                  </strong>
                                  <span>
                                    {formatChannelCountLabel(
                                      broadcastScheduledSlots.length,
                                      'слот',
                                      'слота',
                                      'слотов',
                                    )}
                                  </span>
                                </span>
                              </span>
                            </div>

                            <div className="managed-broadcast-card__facts">
                              {[
                                'Текущий канал',
                                formatChannelCountLabel(
                                  broadcastScheduledSlots.length,
                                  'слот',
                                  'слота',
                                  'слотов',
                                ),
                                normalizedBroadcastButtons.length > 0
                                  ? `${normalizedBroadcastButtons.length} CTA`
                                  : null,
                                editingManagedBroadcast.imageEnabled ? 'Фото' : null,
                              ]
                                .filter((fact): fact is string => Boolean(fact))
                                .map((fact) => (
                                  <span key={`${editingManagedBroadcast.id}-${fact}`}>{fact}</span>
                                ))}
                            </div>

                            <div className="managed-broadcast-card__body">
                              <div className="managed-broadcast-card__actions">
                                <button
                                  type="button"
                                  className="button button--ghost"
                                  onClick={handleCancelBroadcastEdit}
                                  disabled={isBroadcastBusy}
                                >
                                  Отменить
                                </button>
                              </div>
                            </div>
                          </div>
                        ) : (
                          <div className="managed-broadcasts-list">
                            {orderedManagedBroadcasts.length === 0 ? (
                              <div className="managed-broadcasts-list__empty">
                                Активных рассылок нет.
                              </div>
                            ) : null}

                            {orderedManagedBroadcasts.map((broadcast) => {
                              const cardTone = resolveManagedBroadcastCardTone(broadcast);
                              const cardMetric = resolveManagedBroadcastMetric(
                                broadcast,
                                broadcastNowMs,
                              );
                              const cardFacts = buildManagedBroadcastFactChips(broadcast);
                              const canEditBroadcastSchedule =
                                broadcast.scheduleMode === 'calendar';
                              const isDeletingBroadcast =
                                cancelManagedBroadcastMutation.isPending &&
                                cancelManagedBroadcastMutation.variables === broadcast.id;
                              const isOpeningBroadcastEditor =
                                openManagedBroadcastEditorMutation.isPending &&
                                openManagedBroadcastEditorMutation.variables === broadcast.id;
                              const isRetryingBroadcast =
                                retryManagedBroadcastMutation.isPending &&
                                retryManagedBroadcastMutation.variables === broadcast.id;
                              const cardBadge = isOpeningBroadcastEditor
                                ? 'Открываем'
                                : resolveManagedBroadcastCardBadge(broadcast);
                              const content = (
                                <>
                                  <div className="managed-broadcast-card__top">
                                    <span className="managed-broadcast-card__main">
                                      <span
                                        className={cn(
                                          'managed-broadcast-card__badge',
                                          `is-${cardTone}`,
                                        )}
                                      >
                                        {cardBadge}
                                      </span>
                                      <strong>{resolveManagedBroadcastCardTitle(broadcast)}</strong>
                                      <MaxMarkdownPreview
                                        value={broadcast.textPreview}
                                        className="managed-broadcast-card__preview max-markdown-preview--clamp-2"
                                        normalizeWhitespace
                                        fallback={broadcast.hasImage ? 'Фото без текста' : null}
                                      />
                                    </span>
                                    <span className="managed-broadcast-card__aside">
                                      <span
                                        className={cn(
                                          'managed-broadcast-card__metric',
                                          `is-${cardMetric.tone}`,
                                        )}
                                      >
                                        <small>{cardMetric.label}</small>
                                        <strong>{cardMetric.value}</strong>
                                        <span>{cardMetric.caption}</span>
                                      </span>
                                    </span>
                                  </div>

                                  <div className="managed-broadcast-card__facts">
                                    {cardFacts.map((fact) => (
                                      <span key={`${broadcast.id}-${fact}`}>{fact}</span>
                                    ))}
                                  </div>

                                  {broadcast.lastError ? (
                                    <small className="managed-broadcast-card__error">
                                      {broadcast.lastError}
                                    </small>
                                  ) : null}
                                </>
                              );

                              return (
                                <div
                                  key={broadcast.id}
                                  className={cn(
                                    'managed-broadcast-card',
                                    `is-${cardTone}`,
                                    canEditBroadcastSchedule && 'is-editable',
                                  )}
                                >
                                  {canEditBroadcastSchedule ? (
                                    <button
                                      type="button"
                                      className="managed-broadcast-card__surface"
                                      onClick={() => handleEditManagedBroadcast(broadcast)}
                                      disabled={isBroadcastBusy || isDeletingBroadcast}
                                    >
                                      {content}
                                    </button>
                                  ) : (
                                    <div
                                      className={cn('managed-broadcast-card__surface', 'is-static')}
                                    >
                                      {content}
                                    </div>
                                  )}

                                  <div className="managed-broadcast-card__actions">
                                    {broadcast.canRetry ? (
                                      <button
                                        type="button"
                                        className="button button--accent"
                                        onClick={() =>
                                          retryManagedBroadcastMutation.mutate(broadcast.id)
                                        }
                                        disabled={isBroadcastBusy}
                                      >
                                        {isRetryingBroadcast ? 'Повторяем...' : 'Повторить'}
                                      </button>
                                    ) : null}
                                    <button
                                      type="button"
                                      className="button button--danger"
                                      onClick={() => handleDeleteManagedBroadcast(broadcast)}
                                      disabled={isBroadcastBusy}
                                    >
                                      {isDeletingBroadcast ? 'Удаляем...' : 'Удалить'}
                                    </button>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}
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
              status="Mini app"
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
            summary="Запуск, итоги и реролл в mini app"
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

      <ActionConfirmSheet
        id="channel-managed-broadcast-delete"
        open={managedBroadcastDeleteTarget !== null}
        title="Удалить рассылку?"
        previewTitle={
          managedBroadcastDeleteTarget ? (
            <MaxMarkdownPreview
              value={managedBroadcastDeleteTarget.textPreview}
              className="action-confirm-sheet__preview-markdown max-markdown-preview--clamp-2"
              normalizeWhitespace
              fallback={managedBroadcastDeleteTarget.hasImage ? 'Фото без текста' : null}
            />
          ) : undefined
        }
        previewMeta={
          managedBroadcastDeleteTarget
            ? managedBroadcastDeleteTarget.nextSendAt
              ? `Следующая отправка · ${formatCompactManagedBroadcastDateTime(
                  managedBroadcastDeleteTarget.nextSendAt,
                  managedBroadcastDeleteTarget.scheduleTimezone,
                )}`
              : 'Будущие слоты будут сняты.'
            : undefined
        }
        confirmLabel="Удалить"
        confirmBusyLabel="Удаляем..."
        tone="danger"
        isBusy={cancelManagedBroadcastMutation.isPending}
        onClose={() => setManagedBroadcastDeleteTarget(null)}
        onConfirm={confirmDeleteManagedBroadcast}
      />
    </div>
  );
}
