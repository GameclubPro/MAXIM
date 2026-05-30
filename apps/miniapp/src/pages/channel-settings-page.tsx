import {
  type BroadcastImage,
  type BroadcastLinkButton,
  type ChannelAutoPostButtonsMode,
  type ChannelSettings,
  type ChannelSettingsScreenResponse,
  type ChannelSuggestionEntryMode,
  type ManagedBroadcastDetails,
  type SendBroadcastResult,
} from '@maxim/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import '../styles/settings-drilldown-core.css';
import '../styles/managed-giveaway.css';
import '../styles/lazy-pages.css';
import '../styles/settings-drilldown-polish.css';
import '../styles/settings-route-polish.css';
import '../styles/broadcast-studio.css';
import '../styles/broadcast-autopost-polish.css';
import {
  Suspense,
  lazy,
  startTransition,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import type { BroadcastSchedulePlannerSelectionState } from '../components/broadcast-schedule-planner';
import { BroadcastPublishBar } from '../components/broadcast-publish-bar';
import {
  BroadcastHistoryFilterTabs,
  BroadcastWorkspaceChrome,
  countManagedBroadcastHistoryFilters,
  filterManagedBroadcastsByHistoryFilter,
  type BroadcastHistoryFilter,
  type BroadcastWorkspaceView,
} from '../components/broadcast-studio-workspace';
import {
  BroadcastStudioHeader,
  type BroadcastStudioSignal,
} from '../components/broadcast-studio-header';
import { ManagedBroadcastHistoryCard } from '../components/managed-broadcast-history-card';
import { MaxMarkdownPreview } from '../components/max-markdown-preview';
import { ManagedGiveawayCard } from '../components/managed-giveaway-card';
import { ManagedPollCard } from '../components/managed-poll-card';
import { CompactStickyHeader } from '../components/ui/compact-sticky-header';
import { EntityAvatar } from '../components/ui/entity-avatar';
import { GlassCard } from '../components/ui/glass-card';
import { ActionConfirmSheet } from '../components/ui/action-confirm-sheet';
import { SkeletonCard } from '../components/ui/skeleton';
import { SettingsDrilldownPanel } from '../components/ui/settings-drilldown-panel';
import { SettingsSectionToggle } from '../components/ui/settings-section-toggle';
import { SegmentedControl } from '../components/ui/segmented-control';
import { StatusState } from '../components/ui/status-state';
import { useToast } from '../components/ui/toast';
import {
  cancelChannelManagedBroadcast,
  clearChannelBroadcastHandoffState,
  getChannelBroadcastHandoffState,
  getChannelManagedBroadcastCalendar,
  getChannelManagedBroadcast,
  getChannelSettingsScreen,
  getChannelVkParsingCapability,
  retryChannelManagedBroadcast,
  sendChannelBroadcast,
  sendChannelBroadcastTest,
  updateChannelManagedBroadcast,
  updateChannelSettings,
} from '../lib/api/channel-settings-client';
import type { ApiTransport } from '../lib/api/transport';
import type { BroadcastHandoffPayload, SendBroadcastPayload } from '../lib/api/shared-types';
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
  createDefaultBroadcastCycleDraft,
  findBroadcastSlotConflicts,
  formatBroadcastCycleSummary,
  getBroadcastCycleValidationError,
  normalizeBroadcastCycleDraft,
  resolveBroadcastCycleSendAt,
  resolveBroadcastScheduleTimezone,
  sortAndUniqueBroadcastSlots,
  type BroadcastCycleDraft,
  type BroadcastTimingMode,
} from '../lib/broadcast-schedule';
import {
  loadBroadcastComposerDraft,
  loadBroadcastComposerDraftAsync,
  saveBroadcastComposerDraft,
  type BroadcastComposerDraft,
} from '../lib/broadcast-composer-draft';
import { buildChannelBroadcastSystemButtons } from '../lib/broadcast-system-buttons';
import { buildBroadcastAudiencePresentation } from '../lib/broadcast-audience-presentation';
import { cn } from '../lib/cn';
import { maxNotify, setMaxClosingConfirmation } from '../lib/max-bridge';
import { readChatTitle, saveChatTitle } from '../lib/chat-titles';
import { useHintPopoverAutoPosition } from '../lib/hint-popover';
import { buildManagedEntitiesRoute, saveLastEntityId } from '../lib/last-chat';
import { queryKeys } from '../lib/query-keys';
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
type PendingBroadcastPublishReview = {
  broadcastId: string | null;
  payload: SendBroadcastPayload;
};

function normalizeBroadcastImageList(images: BroadcastImage[]): BroadcastImage[] {
  return images.filter((image) => image.base64.trim()).slice(0, 10);
}

function resolveBroadcastImagesFromLegacyFields(value: {
  imageEnabled?: boolean;
  imageBase64?: string | null;
  imageMimeType?: string | null;
  imageFileName?: string | null;
  images?: BroadcastImage[] | null;
}): BroadcastImage[] {
  const images = normalizeBroadcastImageList(value.images ?? []);
  const imageBase64 = value.imageBase64?.trim() ?? '';
  if (images.length > 0 || !value.imageEnabled || !imageBase64) {
    return images;
  }

  return [
    {
      base64: imageBase64,
      mimeType: value.imageMimeType?.trim() ?? '',
      fileName: value.imageFileName?.trim() ?? '',
    },
  ];
}

function areBroadcastImagesReady(images: BroadcastImage[]): boolean {
  return (
    images.length > 0 &&
    images.every((image) => image.base64 && image.mimeType.toLowerCase().startsWith('image/'))
  );
}

type ChannelSettingsSectionKey =
  | 'comments'
  | 'postSuggestions'
  | 'vkParsing'
  | 'broadcast'
  | 'poll'
  | 'giveaway';
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
const MAX_BROADCAST_TEXT_LENGTH = 2_000;
const CHANNEL_SUGGESTION_DAILY_LIMIT_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
const CHANNEL_SUGGESTION_ENTRY_MODE_OPTIONS: Array<{
  value: ChannelSuggestionEntryMode;
  label: string;
}> = [
  { value: 'MINIAPP', label: 'Мини-апп' },
  { value: 'BOT', label: 'Бот' },
];
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
  vkParsing: false,
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

function areBroadcastPlannerStatesEqual(
  left: BroadcastSchedulePlannerSelectionState,
  right: BroadcastSchedulePlannerSelectionState,
): boolean {
  return (
    left.pickedDayCount === right.pickedDayCount &&
    left.selectedDayCount === right.selectedDayCount &&
    left.slotCount === right.slotCount &&
    left.futureSlotCount === right.futureSlotCount &&
    left.isDaySheetOpen === right.isDaySheetOpen &&
    left.isConfirmed === right.isConfirmed
  );
}

const LazySettingsHandoffState = lazy(() => import('../components/handoff'));
const LazyBroadcastSchedulePlanner = lazy(() =>
  import('../components/broadcast-schedule-planner').then((module) => ({
    default: module.BroadcastSchedulePlanner,
  })),
);
const LazyBroadcastContentComposer = lazy(() => import('../components/broadcast-content-composer'));
const LazyBroadcastButtonsSheet = lazy(() => import('../components/broadcast-buttons-sheet'));
const LazyBroadcastPublishReviewSheet = lazy(
  () => import('../components/broadcast-publish-review-sheet'),
);
const LazyVkParsingCard = lazy(() =>
  import('../components/vk-parsing-card').then((module) => ({ default: module.VkParsingCard })),
);

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

function formatChannelBroadcastResultDescription(result: SendBroadcastResult): string {
  const sentTargetLabel =
    result.sentChatPreviews.length > 0
      ? `${result.sentChatPreviews[0]?.title}${result.sentChatOverflowCount > 0 ? ` +${result.sentChatOverflowCount}` : ''}`
      : '';
  const failedTargetLabel =
    result.failedChatPreviews.length > 0
      ? `${result.failedChatPreviews[0]?.title}${result.failedChatOverflowCount > 0 ? ` +${result.failedChatOverflowCount}` : ''}`
      : '';
  if (result.sentChats === 0 && result.nextSendAt) {
    return `Первый слот: ${formatManagedBroadcastDateTime(
      result.nextSendAt,
      result.scheduleTimezone,
    )}.`;
  }

  if (result.failedChats > 0) {
    if (failedTargetLabel) {
      return `Ошибки: ${failedTargetLabel}. Отправлено: ${result.sentChats}/${result.targetChats}.`;
    }
    return `Отправлено: ${result.sentChats}/${result.targetChats}, ошибок: ${result.failedChats}.`;
  }

  if (result.nextSendAt && result.scheduledOccurrences > 0) {
    return `Следующий слот: ${formatManagedBroadcastDateTime(
      result.nextSendAt,
      result.scheduleTimezone,
    )}.`;
  }

  return sentTargetLabel
    ? `Отправлено: ${sentTargetLabel}.`
    : `Отправлено: ${result.sentChats}/${result.targetChats}.`;
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

function formatBroadcastPayloadScheduleLabel(payload: SendBroadcastPayload): string {
  if (payload.scheduleMode === 'calendar') {
    const slots = sortAndUniqueBroadcastSlots(payload.scheduledSlots);
    if (slots.length === 1) {
      return formatCompactManagedBroadcastDateTime(slots[0], payload.scheduleTimezone);
    }

    return formatChannelCountLabel(slots.length, 'слот', 'слота', 'слотов');
  }

  if (payload.sendAt) {
    return formatCompactManagedBroadcastDateTime(payload.sendAt, payload.scheduleTimezone);
  }

  return 'Сразу';
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
    return 'Автопостинг завершён';
  }
  if (broadcast.status === 'CANCELED') {
    return 'Автопостинг остановлен';
  }
  return broadcast.nextSendAt ? 'Следующая отправка' : 'Активный автопостинг';
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
    caption: buildBroadcastAudiencePresentation({
      targetMode: broadcast.targetMode,
      targetChatIds: broadcast.targetChatIds,
      targetPreviews: broadcast.targetPreviews,
      targetOverflowCount: broadcast.targetOverflowCount,
      targetChats: broadcast.targetChats,
      currentLabel: 'Текущий канал',
    }).label,
    tone: broadcast.status === 'COMPLETED' ? 'muted' : 'active',
  };
}

function buildManagedBroadcastFactChips(broadcast: ManagedBroadcastListItem): string[] {
  const scopeLabel = buildBroadcastAudiencePresentation({
    targetMode: broadcast.targetMode,
    targetChatIds: broadcast.targetChatIds,
    targetPreviews: broadcast.targetPreviews,
    targetOverflowCount: broadcast.targetOverflowCount,
    targetChats: broadcast.targetChats,
    currentLabel: 'Текущий канал',
  }).label;
  const scheduleLabel =
    broadcast.scheduleMode === 'calendar'
      ? formatChannelCountLabel(broadcast.scheduledSlots.length, 'слот', 'слота', 'слотов')
      : broadcast.cycleEnabled
        ? `Цикл ${broadcast.sentCount}/${broadcast.cycleCount}`
        : '1 отправка';
  const extras = [
    broadcast.buttonEnabled ? formatBroadcastButtonsStatus(broadcast.buttons) : null,
    broadcast.hasImage
      ? broadcast.imageCount > 1
        ? `${broadcast.imageCount} фото`
        : 'Фото'
      : null,
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
      className={cn('channel-settings-toggle-card', checked && 'is-on', disabled && 'is-disabled')}
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
  const { isCompact: isHeaderCompact } = useAutoHideHeader();
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
  const [broadcastTextError, setBroadcastTextError] = useState('');
  const [broadcastButtons, setBroadcastButtons] = useState<BroadcastLinkButton[]>([]);
  const [broadcastButtonsSheetOpen, setBroadcastButtonsSheetOpen] = useState(false);
  const [broadcastButtonRevealSignal, setBroadcastButtonRevealSignal] = useState(0);
  const [broadcastButtonErrors, setBroadcastButtonErrors] = useState<
    BroadcastLinkButtonFieldErrors[]
  >([]);
  const [broadcastImageEnabled, setBroadcastImageEnabled] = useState(false);
  const [broadcastImageBase64, setBroadcastImageBase64] = useState('');
  const [broadcastImageMimeType, setBroadcastImageMimeType] = useState('');
  const [broadcastImageFileName, setBroadcastImageFileName] = useState('');
  const [broadcastImages, setBroadcastImages] = useState<BroadcastImage[]>([]);
  const [broadcastImagesPreparing, setBroadcastImagesPreparing] = useState(false);
  const [broadcastVideoCleared, setBroadcastVideoCleared] = useState(false);
  const [broadcastScheduledSlots, setBroadcastScheduledSlots] = useState<string[]>([]);
  const [broadcastTimingMode, setBroadcastTimingMode] = useState<BroadcastTimingMode>('now');
  const [broadcastCycleDraft, setBroadcastCycleDraft] = useState<BroadcastCycleDraft>(() =>
    createDefaultBroadcastCycleDraft(),
  );
  const [broadcastScheduleTimezone, setBroadcastScheduleTimezone] = useState(() =>
    resolveBroadcastScheduleTimezone(),
  );
  const [broadcastImageError, setBroadcastImageError] = useState('');
  const [, setBroadcastScheduleEnabled] = useState(false);
  const [, setBroadcastScheduleDays] = useState(0);
  const [, setBroadcastScheduleTime] = useState(
    toLocalTimeInputValue(new Date(Date.now() + BROADCAST_HOUR_MS)),
  );
  const [broadcastScheduleError, setBroadcastScheduleError] = useState('');
  const [, setBroadcastCycleEnabled] = useState(false);
  const [, setBroadcastCycleEveryHours] = useState(MIN_BROADCAST_CYCLE_HOURS);
  const [, setBroadcastCycleCount] = useState(2);
  const [broadcastCycleError, setBroadcastCycleError] = useState('');
  const [broadcastPlannerResetKey, setBroadcastPlannerResetKey] = useState(0);
  const [broadcastPlannerState, setBroadcastPlannerState] =
    useState<BroadcastSchedulePlannerSelectionState>(EMPTY_BROADCAST_PLANNER_STATE);
  const [editingManagedBroadcast, setEditingManagedBroadcast] =
    useState<ManagedBroadcastDetails | null>(null);
  const [duplicatedManagedBroadcast, setDuplicatedManagedBroadcast] =
    useState<ManagedBroadcastDetails | null>(null);
  const [managedBroadcastDeleteTarget, setManagedBroadcastDeleteTarget] =
    useState<ManagedBroadcastListItem | null>(null);
  const [pendingBroadcastSlotConflict, setPendingBroadcastSlotConflict] = useState<{
    broadcastId: string | null;
    payload: SendBroadcastPayload;
  } | null>(null);
  const [pendingBroadcastPublishReview, setPendingBroadcastPublishReview] =
    useState<PendingBroadcastPublishReview | null>(null);
  const [broadcastWorkspaceView, setBroadcastWorkspaceView] =
    useState<BroadcastWorkspaceView>('compose');
  const [broadcastHistoryFilter, setBroadcastHistoryFilter] =
    useState<BroadcastHistoryFilter>('future');
  const [broadcastNowMs, setBroadcastNowMs] = useState(() => Date.now());
  const appliedBroadcastHandoffSignatureRef = useRef<string | null>(null);
  const searchParams = new URLSearchParams(location.search);
  const focusSection = searchParams.get('focus');
  const handoffRequested = searchParams.get('handoff') === '1';

  function applyBroadcastImages(nextImages: BroadcastImage[]) {
    const normalizedImages = normalizeBroadcastImageList(nextImages);
    const firstImage = normalizedImages[0];
    setBroadcastImages(normalizedImages);
    setBroadcastImagesPreparing(false);
    setBroadcastImageEnabled(normalizedImages.length > 0);
    setBroadcastImageBase64(firstImage?.base64 ?? '');
    setBroadcastImageMimeType(firstImage?.mimeType ?? '');
    setBroadcastImageFileName(firstImage?.fileName ?? '');
  }

  const settingsScreenQuery = useQuery({
    queryKey: queryKeys.channelSettingsScreen(chatId),
    queryFn: ({ signal }) => getChannelSettingsScreen(api, chatId, { signal }),
    enabled: Boolean(chatId),
    refetchOnWindowFocus: false,
    ...(handoffRequested
      ? {
          retry: 7,
          retryDelay: (failureCount: number) => Math.min(800 + failureCount * 400, 2600),
        }
      : {}),
  });
  const broadcastHandoffStateQuery = useQuery({
    queryKey: queryKeys.channelBroadcastHandoff(chatId),
    queryFn: () => getChannelBroadcastHandoffState(api, chatId ?? ''),
    enabled:
      Boolean(chatId) &&
      !editingManagedBroadcast &&
      focusSection === 'broadcast' &&
      handoffRequested,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (
      focusSection !== 'broadcast' &&
      focusSection !== 'comments' &&
      focusSection !== 'giveaway' &&
      focusSection !== 'poll' &&
      focusSection !== 'postSuggestions' &&
      focusSection !== 'vkParsing'
    ) {
      return;
    }

    setExpandedSections((current) => ({
      ...current,
      ...(focusSection === 'comments'
        ? { comments: true }
        : focusSection === 'postSuggestions'
          ? { postSuggestions: true }
          : focusSection === 'vkParsing'
            ? { vkParsing: true }
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
  const settingsHandoffRetryCount = settingsScreenQuery.failureCount;
  const showSettingsHandoffPending =
    Boolean(chatId) &&
    handoffRequested &&
    !settingsScreenQuery.data &&
    !settingsScreenQuery.isError &&
    (settingsScreenQuery.isPending || settingsHandoffRetryCount > 0);
  const showSettingsHandoffError =
    Boolean(chatId) && handoffRequested && !settingsScreenQuery.data && settingsScreenQuery.isError;
  const channelHeader = settingsScreenQuery.data?.header ?? null;
  const vkParsingCapabilityQuery = useQuery({
    queryKey: queryKeys.channelVkParsingCapability(chatId),
    queryFn: () => getChannelVkParsingCapability(api, chatId ?? ''),
    enabled: Boolean(chatId),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
  const vkParsingCapability = vkParsingCapabilityQuery.data ?? null;
  const canAccessVkParsing = vkParsingCapability?.canUse === true;
  const shouldShowVkParsingSection =
    canAccessVkParsing || vkParsingCapability?.reasonCode === 'NOT_CONFIGURED';
  const broadcastTargetContextLabel = channelHeader?.title?.trim() || 'Текущий канал';
  const managedBroadcasts = settingsScreenQuery.data?.managedBroadcasts ?? [];
  const broadcastCalendarQuery = useQuery({
    queryKey: queryKeys.channelManagedBroadcastCalendar(chatId),
    queryFn: () =>
      getChannelManagedBroadcastCalendar(api, chatId ?? '', {
        targetChatIds: chatId ? [chatId] : [],
      }),
    enabled: Boolean(chatId) && expandedSections.broadcast,
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });
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
  const broadcastHistoryCounts = useMemo(
    () => countManagedBroadcastHistoryFilters(orderedManagedBroadcasts),
    [orderedManagedBroadcasts],
  );
  const filteredBroadcasts = useMemo(
    () => filterManagedBroadcastsByHistoryFilter(orderedManagedBroadcasts, broadcastHistoryFilter),
    [broadcastHistoryFilter, orderedManagedBroadcasts],
  );

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
    if (!broadcastHandoffStateQuery.data || !handoffRequested) {
      return;
    }

    const hasHandoffDraft =
      broadcastHandoffStateQuery.data.buttons.length > 0 ||
      broadcastHandoffStateQuery.data.scheduledSlots.length > 0;
    if (!hasHandoffDraft) {
      return;
    }

    const signature = JSON.stringify(broadcastHandoffStateQuery.data);
    if (appliedBroadcastHandoffSignatureRef.current === signature) {
      return;
    }

    appliedBroadcastHandoffSignatureRef.current = signature;
    setEditingManagedBroadcast(null);
    setDuplicatedManagedBroadcast(null);
    setBroadcastButtons(broadcastHandoffStateQuery.data.buttons);
    setBroadcastTimingMode(
      broadcastHandoffStateQuery.data.scheduledSlots.length > 0 ? 'scheduled' : 'now',
    );
    setBroadcastScheduledSlots(
      sortAndUniqueBroadcastSlots(broadcastHandoffStateQuery.data.scheduledSlots),
    );
    setBroadcastScheduleTimezone(
      broadcastHandoffStateQuery.data.scheduleTimezone.trim() || resolveBroadcastScheduleTimezone(),
    );
    setBroadcastButtonErrors([]);
    setBroadcastScheduleError('');
    setBroadcastCycleError('');
    resetBroadcastPlanner();
    setBroadcastWorkspaceView('compose');
    setExpandedSections((current) => ({ ...current, broadcast: true }));
  }, [broadcastHandoffStateQuery.data, handoffRequested]);

  useEffect(() => {
    setBroadcastText('');
    setBroadcastTextError('');
    setBroadcastButtons([]);
    setBroadcastButtonsSheetOpen(false);
    setBroadcastButtonErrors([]);
    applyBroadcastImages([]);
    setBroadcastVideoCleared(false);
    setBroadcastTimingMode('now');
    setBroadcastCycleDraft(createDefaultBroadcastCycleDraft());
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
    setDuplicatedManagedBroadcast(null);
    setBroadcastWorkspaceView('compose');
    setPendingBroadcastPublishReview(null);
    resetBroadcastPlanner();
    let cancelled = false;
    const applySavedBroadcastDraft = (savedBroadcastDraft: BroadcastComposerDraft) => {
      if (cancelled) {
        return;
      }
      setBroadcastText(savedBroadcastDraft.text);
      setBroadcastButtons(savedBroadcastDraft.buttons);
      applyBroadcastImages(resolveBroadcastImagesFromLegacyFields(savedBroadcastDraft));
      setBroadcastTimingMode(savedBroadcastDraft.timingMode);
      setBroadcastCycleDraft(normalizeBroadcastCycleDraft(savedBroadcastDraft.cycle));
      setBroadcastScheduledSlots(sortAndUniqueBroadcastSlots(savedBroadcastDraft.scheduledSlots));
      setBroadcastScheduleTimezone(
        savedBroadcastDraft.scheduleTimezone.trim() || resolveBroadcastScheduleTimezone(),
      );
    };
    const savedBroadcastDraft = chatId ? loadBroadcastComposerDraft('channel', chatId) : null;
    if (savedBroadcastDraft) {
      applySavedBroadcastDraft(savedBroadcastDraft);
    }

    if (chatId) {
      void loadBroadcastComposerDraftAsync('channel', chatId).then((draft) => {
        if (draft) {
          applySavedBroadcastDraft(draft);
        }
      });
    }

    return () => {
      cancelled = true;
    };
  }, [chatId]);

  useEffect(() => {
    if (!chatId || editingManagedBroadcast) {
      return;
    }

    const draftToPersist: BroadcastComposerDraft = {
      text: broadcastText,
      targetMode: 'current',
      targetChatIds: chatId ? [chatId] : [],
      lastScopedTargetMode: 'current',
      buttons: broadcastButtons,
      imageEnabled: broadcastImageEnabled,
      imageBase64: broadcastImageBase64,
      imageMimeType: broadcastImageMimeType,
      imageFileName: broadcastImageFileName,
      images: broadcastImages,
      timingMode: broadcastTimingMode,
      scheduledSlots: broadcastScheduledSlots,
      scheduleTimezone: broadcastScheduleTimezone,
      cycle: broadcastCycleDraft,
    };

    saveBroadcastComposerDraft('channel', chatId, draftToPersist);
  }, [
    broadcastButtons,
    broadcastCycleDraft,
    broadcastImageBase64,
    broadcastImageEnabled,
    broadcastImageFileName,
    broadcastImageMimeType,
    broadcastImages,
    broadcastScheduleTimezone,
    broadcastScheduledSlots,
    broadcastText,
    broadcastTimingMode,
    chatId,
    editingManagedBroadcast,
  ]);

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
      (section === 'vkParsing' && focusSection === 'vkParsing') ||
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

  const sendBroadcastMutation = useMutation({
    mutationFn: (payload: SendBroadcastPayload) => sendChannelBroadcast(api, chatId ?? '', payload),
    onSuccess: (result) => {
      appliedBroadcastHandoffSignatureRef.current = null;
      resetBroadcastComposer();
      if (chatId) {
        void clearChannelBroadcastHandoffState(api, chatId).catch(() => undefined);
      }
      void queryClient.invalidateQueries({ queryKey: queryKeys.channelSettingsScreen(chatId) });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.channelManagedBroadcastCalendar(chatId),
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.channelBroadcastHandoff(chatId) });
      pushToast({
        tone: result.failedChats > 0 ? 'info' : 'success',
        title: result.failedChats > 0 ? 'Часть публикаций с ошибкой' : 'Автопостинг готов',
        description: formatChannelBroadcastResultDescription(result),
      });
      maxNotify(result.failedChats > 0 ? 'warning' : 'success');
    },
    onError: (error) => {
      const description = normalizeApiError(error);
      if (
        description.includes('выбранное время') ||
        description.includes('BROADCAST_SLOT_CONFLICT') ||
        description.includes('BROADCAST_TARGET_SLOT_CONFLICT')
      ) {
        setBroadcastScheduleError('Календарь обновился. Выберите свободный слот.');
        void queryClient.invalidateQueries({ queryKey: queryKeys.channelSettingsScreen(chatId) });
        void queryClient.invalidateQueries({
          queryKey: queryKeys.channelManagedBroadcastCalendar(chatId),
        });
      }
      pushToast({
        tone: 'danger',
        title: 'Не удалось запустить автопостинг',
        description,
      });
      maxNotify('error');
    },
  });

  const sendBroadcastTestMutation = useMutation({
    mutationFn: (payload: SendBroadcastPayload) =>
      sendChannelBroadcastTest(api, chatId ?? '', payload),
    onSuccess: () => {
      pushToast({
        tone: 'success',
        title: 'Тест отправлен',
      });
      maxNotify('success');
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Тест не отправлен',
        description: normalizeApiError(error),
      });
      maxNotify('error');
    },
  });

  const clearBroadcastHandoffMutation = useMutation({
    mutationFn: () => clearChannelBroadcastHandoffState(api, chatId ?? ''),
    onSuccess: () => {
      resetBroadcastComposer();
      void queryClient.invalidateQueries({ queryKey: queryKeys.channelBroadcastHandoff(chatId) });
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
      void queryClient.invalidateQueries({ queryKey: queryKeys.channelSettingsScreen(chatId) });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.channelManagedBroadcastCalendar(chatId),
      });
      resetBroadcastComposer();
      pushToast({
        tone: broadcast.status === 'FAILED' ? 'info' : 'success',
        title: 'Автопостинг обновлён',
        description: broadcast.nextSendAt
          ? `Следующая отправка: ${formatManagedBroadcastDateTime(
              broadcast.nextSendAt,
              broadcast.scheduleTimezone,
            )}.`
          : 'Изменения сохранены.',
      });
    },
    onError: (error) => {
      const description = normalizeApiError(error);
      if (
        description.includes('выбранное время') ||
        description.includes('BROADCAST_SLOT_CONFLICT') ||
        description.includes('BROADCAST_TARGET_SLOT_CONFLICT')
      ) {
        setBroadcastScheduleError('Календарь обновился. Выберите свободный слот.');
        void queryClient.invalidateQueries({ queryKey: queryKeys.channelSettingsScreen(chatId) });
        void queryClient.invalidateQueries({
          queryKey: queryKeys.channelManagedBroadcastCalendar(chatId),
        });
      }
      pushToast({
        tone: 'danger',
        title: 'Не удалось обновить автопостинг',
        description,
      });
      maxNotify('error');
    },
  });

  const cancelManagedBroadcastMutation = useMutation({
    mutationFn: (broadcastId: string) =>
      cancelChannelManagedBroadcast(api, chatId ?? '', broadcastId),
    onSuccess: (broadcast) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.channelSettingsScreen(chatId) });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.channelManagedBroadcastCalendar(chatId),
      });
      setManagedBroadcastDeleteTarget(null);
      if (editingManagedBroadcast?.id === broadcast.id) {
        resetBroadcastComposer();
      }
      pushToast({
        tone: 'info',
        title: 'Автопостинг удалён',
      });
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось удалить автопостинг',
        description: normalizeApiError(error),
      });
      maxNotify('error');
    },
  });

  const retryManagedBroadcastMutation = useMutation({
    mutationFn: (broadcastId: string) =>
      retryChannelManagedBroadcast(api, chatId ?? '', broadcastId),
    onSuccess: (broadcast) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.channelSettingsScreen(chatId) });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.channelManagedBroadcastCalendar(chatId),
      });
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
        title: 'Не удалось повторить автопостинг',
        description: normalizeApiError(error),
      });
      maxNotify('error');
    },
  });

  function applyManagedBroadcastToComposer(
    broadcast: ManagedBroadcastDetails,
    mode: 'edit' | 'duplicate',
  ) {
    setEditingManagedBroadcast(mode === 'edit' ? broadcast : null);
    setDuplicatedManagedBroadcast(
      mode === 'duplicate' && broadcast.mediaType === 'video' && broadcast.mediaPayload
        ? broadcast
        : null,
    );
    setBroadcastText(broadcast.text);
    setBroadcastButtons(broadcast.buttons);
    setBroadcastButtonErrors([]);
    applyBroadcastImages(resolveBroadcastImagesFromLegacyFields(broadcast));
    setBroadcastVideoCleared(false);
    const restoredTimingMode: BroadcastTimingMode =
      broadcast.scheduleMode === 'calendar'
        ? 'scheduled'
        : broadcast.cycleEnabled
          ? 'cycle'
          : broadcast.nextSendAt
            ? 'scheduled'
            : 'now';
    setBroadcastTimingMode(restoredTimingMode);
    setBroadcastCycleDraft(
      normalizeBroadcastCycleDraft({
        startMode: broadcast.nextSendAt ? 'later' : 'now',
        startAt: broadcast.nextSendAt ?? createDefaultBroadcastCycleDraft().startAt,
        everyHours: broadcast.cycleEveryHours,
        count: Math.max(2, broadcast.cycleCount),
      }),
    );
    setBroadcastScheduledSlots(
      mode === 'edit'
        ? sortAndUniqueBroadcastSlots(
            broadcast.scheduleMode === 'calendar'
              ? broadcast.scheduledSlots
              : broadcast.nextSendAt && !broadcast.cycleEnabled
                ? [broadcast.nextSendAt]
                : [],
          )
        : [],
    );
    setBroadcastScheduleTimezone(
      broadcast.scheduleTimezone.trim() || resolveBroadcastScheduleTimezone(),
    );
    setBroadcastTextError('');
    setBroadcastImageError('');
    setBroadcastScheduleError(mode === 'duplicate' ? 'Выберите время.' : '');
    setBroadcastCycleError('');
    resetBroadcastPlanner();
    setExpandedSections((current) => ({ ...current, broadcast: true }));
  }

  const openManagedBroadcastEditorMutation = useMutation({
    mutationFn: (broadcastId: string) => getChannelManagedBroadcast(api, chatId ?? '', broadcastId),
    onSuccess: (broadcast) => {
      applyManagedBroadcastToComposer(broadcast, 'edit');
      pushToast({
        tone: 'info',
        title: 'Редактирование автопостинга',
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
        title: 'Не удалось открыть автопостинг',
        description: normalizeApiError(error),
      });
      maxNotify('error');
    },
  });

  const duplicateManagedBroadcastMutation = useMutation({
    mutationFn: (broadcastId: string) => getChannelManagedBroadcast(api, chatId ?? '', broadcastId),
    onSuccess: (broadcast) => {
      applyManagedBroadcastToComposer(broadcast, 'duplicate');
      pushToast({
        tone: 'success',
        title: 'Копия готова',
      });
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Копия не создана',
        description: normalizeApiError(error),
      });
      maxNotify('error');
    },
  });

  useHintPopoverAutoPosition(openHintKey !== null, openHintKey);

  useEffect(() => {
    document.body.classList.add('channel-settings-page-open');

    return () => {
      document.body.classList.remove('channel-settings-page-open');
    };
  }, []);

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

  if (showSettingsHandoffPending) {
    return (
      <div className="page-stack page-enter">
        <Suspense fallback={null}>
          <LazySettingsHandoffState
            entityType="channel"
            mode="loading"
            retryCount={settingsHandoffRetryCount}
          />
        </Suspense>
      </div>
    );
  }

  if (showSettingsHandoffError) {
    return (
      <div className="page-stack page-enter">
        <Suspense fallback={null}>
          <LazySettingsHandoffState
            entityType="channel"
            mode="error"
            onRetry={() => void settingsQuery.refetch()}
          />
        </Suspense>
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
  const broadcastSystemButtons = buildChannelBroadcastSystemButtons({
    commentsEnabled: draft.commentsEnabled,
    postSuggestionsEnabled: draft.postSuggestionsEnabled,
    postSuggestionsButtonText: draft.postSuggestionsButtonText,
  });
  const broadcastHasButton = normalizedBroadcastButtons.length > 0;
  const broadcastVisibleButtons = [...normalizedBroadcastButtons, ...broadcastSystemButtons];
  const broadcastHasVisibleButtons = broadcastVisibleButtons.length > 0;
  const broadcastVisibleButtonStatus = formatBroadcastButtonsStatus(broadcastVisibleButtons);
  const broadcastOccupiedSlots = managedBroadcasts
    .filter((broadcast) => broadcast.id !== editingManagedBroadcast?.id)
    .flatMap((broadcast) => broadcast.scheduledSlots);
  const pendingBroadcastConflictSlots = pendingBroadcastSlotConflict
    ? findBroadcastSlotConflicts(
        pendingBroadcastSlotConflict.payload.scheduledSlots,
        broadcastOccupiedSlots,
      )
    : [];
  const pendingBroadcastConflictPreviewSlot =
    pendingBroadcastConflictSlots[0] ??
    pendingBroadcastSlotConflict?.payload.scheduledSlots[0] ??
    null;
  const pendingBroadcastReviewPayload = pendingBroadcastPublishReview?.payload ?? null;
  const pendingBroadcastReviewFacts = pendingBroadcastReviewPayload
    ? [
        `Время · ${formatBroadcastPayloadScheduleLabel(pendingBroadcastReviewPayload)}`,
        pendingBroadcastReviewPayload.buttonEnabled || broadcastSystemButtons.length > 0
          ? `Кнопки · ${formatBroadcastButtonsStatus([
              ...pendingBroadcastReviewPayload.buttons,
              ...broadcastSystemButtons,
            ])}`
          : 'Кнопки · нет',
        pendingBroadcastReviewPayload.imageEnabled ||
        pendingBroadcastReviewPayload.mediaType === 'video'
          ? pendingBroadcastReviewPayload.images && pendingBroadcastReviewPayload.images.length > 1
            ? `${pendingBroadcastReviewPayload.images.length} фото`
            : 'Медиа'
          : null,
      ].filter((item): item is string => Boolean(item))
    : [];
  const isUpdatingManagedBroadcast = updateManagedBroadcastMutation.isPending;
  const isOpeningManagedBroadcastEditor = openManagedBroadcastEditorMutation.isPending;
  const isBroadcastBusy =
    sendBroadcastMutation.isPending ||
    sendBroadcastTestMutation.isPending ||
    clearBroadcastHandoffMutation.isPending ||
    isOpeningManagedBroadcastEditor ||
    duplicateManagedBroadcastMutation.isPending ||
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
  const broadcastVideoSource = editingManagedBroadcast ?? duplicatedManagedBroadcast;
  const editingBroadcastHasVideo =
    !broadcastVideoCleared &&
    broadcastVideoSource?.mediaType === 'video' &&
    Boolean(broadcastVideoSource.mediaPayload);
  const broadcastImageLabel =
    broadcastImages.length > 1
      ? `${broadcastImages.length} фото`
      : broadcastImageEnabled
        ? 'Фото'
        : null;
  const broadcastMediaSignalLabel =
    broadcastImageLabel ?? (editingBroadcastHasVideo ? 'Видео' : null);
  const broadcastHasDirectContent = Boolean(
    normalizedBroadcastText || broadcastImageEnabled || editingBroadcastHasVideo,
  );
  const broadcastImagesReady = !broadcastImageEnabled || areBroadcastImagesReady(broadcastImages);
  const broadcastMediaReady = broadcastImagesReady && !broadcastImagesPreparing;
  const broadcastHasPublishableContent = broadcastHasDirectContent;
  const broadcastContentReady = broadcastHasPublishableContent && broadcastMediaReady;
  const broadcastButtonDraftValid = !hasBroadcastLinkButtonErrors(
    validateBroadcastLinkButtons(normalizedBroadcastButtons),
  );
  const broadcastNormalizedCycle = normalizeBroadcastCycleDraft(
    broadcastCycleDraft,
    broadcastNowMs,
  );
  const broadcastCycleValidationError =
    broadcastTimingMode === 'cycle'
      ? getBroadcastCycleValidationError(broadcastNormalizedCycle, broadcastNowMs)
      : null;
  const broadcastTimingSummary =
    broadcastTimingMode === 'now'
      ? 'Сейчас'
      : broadcastTimingMode === 'cycle'
        ? formatBroadcastCycleSummary(broadcastNormalizedCycle, broadcastNowMs)
        : broadcastScheduledSlots.length > 0
          ? broadcastSlotsLabel
          : 'Без слотов';
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
  const broadcastPlannerPending = broadcastPlannerState.isDaySheetOpen;
  const broadcastHasFutureSlots =
    broadcastTimingMode === 'now' ||
    (broadcastTimingMode === 'cycle' && !broadcastCycleValidationError) ||
    (broadcastTimingMode === 'scheduled' && broadcastPlannerState.futureSlotCount > 0);
  const broadcastCalendarScheduleReady =
    broadcastTimingMode === 'scheduled' &&
    broadcastScheduledSlots.length > 0 &&
    broadcastPlannerState.futureSlotCount > 0 &&
    !broadcastPlannerPending;
  const broadcastScheduleReady =
    broadcastTimingMode === 'now' ||
    (broadcastTimingMode === 'cycle' && !broadcastCycleValidationError) ||
    broadcastCalendarScheduleReady;
  const broadcastTestReady = broadcastContentReady && broadcastButtonDraftValid;
  const broadcastSendDisabled = isBroadcastBusy;
  const broadcastPublishIssueLabels = [
    !broadcastHasPublishableContent ? 'Нет текста' : null,
    broadcastHasPublishableContent && !broadcastMediaReady ? 'Фото' : null,
    !broadcastScheduleReady || !broadcastHasFutureSlots ? 'Нет времени' : null,
    !broadcastButtonDraftValid ? 'Кнопки' : null,
  ].filter((item): item is string => Boolean(item));
  const broadcastPublishIssueActions = broadcastPublishIssueLabels.map((label) => ({
    label,
    onClick: () => {
      setBroadcastWorkspaceView('compose');

      if (label === 'Нет текста') {
        setBroadcastTextError('Добавьте текст или фото.');
        return;
      }

      if (label === 'Фото') {
        setBroadcastImageError(
          broadcastImagesPreparing ? 'Фото ещё готовится.' : 'Фото не готово.',
        );
        return;
      }

      if (label === 'Нет времени') {
        if (broadcastTimingMode === 'cycle') {
          setBroadcastCycleError(broadcastCycleValidationError ?? 'Проверьте цикл публикаций.');
          return;
        }

        setBroadcastScheduleError('Выберите время публикации.');
        return;
      }

      if (label === 'Кнопки') {
        setBroadcastButtonsSheetOpen(true);
      }
    },
  }));
  const showBroadcastResetAction =
    editingManagedBroadcast !== null ||
    duplicatedManagedBroadcast !== null ||
    broadcastTimingMode !== 'now' ||
    broadcastScheduledSlots.length > 0 ||
    normalizedBroadcastText.length > 0 ||
    broadcastImageEnabled ||
    broadcastHasButton;
  const broadcastHeaderSummary = broadcastTimingSummary;
  const commentsCardSummary = !draft.commentsEnabled
    ? 'Выкл'
    : draft.commentsModerationEnabled
      ? 'Модерация'
      : 'Без модерации';
  const commentsCardStatus = !draft.commentsEnabled
    ? 'Выкл'
    : draft.commentsModerationEnabled
      ? 'Модерация'
      : 'Вкл';
  const postSuggestionsEntryLabel =
    draft.postSuggestionsEntryMode === 'MINIAPP' ? 'Мини-апп' : 'Бот';
  const postSuggestionsCardSummary = draft.postSuggestionsEnabled
    ? `${postSuggestionsEntryLabel} · ${draft.postSuggestionsDailyLimit}/24ч`
    : 'Ручной режим';
  const postSuggestionsCardStatus = draft.postSuggestionsEnabled
    ? postSuggestionsEntryLabel
    : 'Ручной';
  const broadcastCardStatus =
    broadcastTimingMode === 'cycle'
      ? 'Цикл'
      : broadcastTimingMode === 'now'
        ? 'Сейчас'
        : broadcastScheduledSlots.length > 0
          ? 'План'
          : broadcastHasVisibleButtons
            ? broadcastVisibleButtonStatus
            : broadcastHasPublishableContent
              ? 'Контент'
              : 'Пусто';
  const broadcastContentSignalValue = broadcastContentReady
    ? normalizedBroadcastText && broadcastMediaSignalLabel
      ? 'Текст+медиа'
      : normalizedBroadcastText
        ? 'Текст'
        : (broadcastMediaSignalLabel ?? 'Готов')
    : broadcastImagesPreparing
      ? 'Фото...'
      : broadcastHasDirectContent
        ? 'Проверка'
        : 'Пусто';
  const broadcastTimingSignalValue =
    broadcastTimingMode === 'now'
      ? 'Сейчас'
      : broadcastTimingMode === 'cycle'
        ? broadcastCycleValidationError
          ? 'Цикл?'
          : `Цикл ${broadcastNormalizedCycle.count}`
        : broadcastPlannerState.futureSlotCount > 0
          ? `${broadcastPlannerState.futureSlotCount} сл.`
          : 'Без слотов';
  const broadcastButtonsSignalValue = !broadcastButtonDraftValid
    ? 'Ошибка'
    : broadcastHasVisibleButtons
      ? `${broadcastVisibleButtons.length} кноп.`
      : 'Без кнопок';
  const broadcastResetActionLabel = editingManagedBroadcast
    ? 'Сбросить изменения'
    : 'Очистить автопостинг';
  const broadcastFooterTitle = editingManagedBroadcast
    ? 'Сохранить автопостинг'
    : broadcastPublishIssueLabels.length > 0 && !isBroadcastBusy
      ? broadcastPublishIssueLabels.join(' · ')
      : broadcastTimingMode === 'now'
        ? 'Сразу'
        : broadcastTimingMode === 'cycle'
          ? formatBroadcastCycleSummary(broadcastNormalizedCycle, broadcastNowMs)
          : broadcastSelectionSummary || 'Автопостинг';
  const broadcastFooterMeta = [
    broadcastImageLabel,
    editingBroadcastHasVideo ? 'Видео' : null,
    broadcastHasVisibleButtons ? broadcastVisibleButtonStatus : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const broadcastPrimaryActionLabel = editingManagedBroadcast
    ? 'Сохранить'
    : broadcastTimingMode === 'now'
      ? 'Опубликовать'
      : 'В план';
  const broadcastFooterPrimaryActionLabel = editingManagedBroadcast
    ? 'Сохранить'
    : broadcastTimingMode === 'now'
      ? 'Опубликовать'
      : 'В план';
  const showBroadcastWorkspaceTabs = !editingManagedBroadcast && !duplicatedManagedBroadcast;
  const activeBroadcastWorkspaceView = showBroadcastWorkspaceTabs
    ? broadcastWorkspaceView
    : 'compose';
  const broadcastStudioSignals: BroadcastStudioSignal[] = [
    {
      label: 'Контент',
      value: broadcastContentSignalValue,
      tone: broadcastContentReady ? 'ready' : broadcastHasDirectContent ? 'warning' : 'pending',
      icon: 'content',
      onClick: () => setBroadcastWorkspaceView('compose'),
    },
    {
      label: 'Время',
      value: broadcastTimingSignalValue,
      tone: broadcastScheduleReady ? 'ready' : 'pending',
      icon: 'time',
      onClick: () => setBroadcastWorkspaceView('compose'),
    },
    {
      label: 'Кнопки',
      value: broadcastButtonsSignalValue,
      tone: broadcastButtonDraftValid
        ? broadcastHasVisibleButtons
          ? 'ready'
          : 'neutral'
        : 'danger',
      icon: 'button',
      onClick: () => {
        setBroadcastWorkspaceView('compose');
        setBroadcastButtonsSheetOpen(true);
      },
    },
  ];
  const broadcastStudioReadyCount = [
    broadcastContentReady,
    broadcastScheduleReady,
    broadcastButtonDraftValid,
  ].filter(Boolean).length;
  const broadcastDrilldownFooter = (
    <BroadcastPublishBar
      title={broadcastFooterTitle}
      meta={broadcastFooterMeta}
      issues={broadcastPublishIssueActions}
      busy={isBroadcastBusy}
      testLabel={sendBroadcastTestMutation.isPending ? 'Тест...' : 'Тест'}
      testAriaLabel={sendBroadcastTestMutation.isPending ? 'Отправляем тест' : 'Отправить тест'}
      testDisabled={isBroadcastBusy || !broadcastTestReady}
      primaryLabel={
        isUpdatingManagedBroadcast
          ? 'Сохраняем...'
          : sendBroadcastMutation.isPending
            ? broadcastTimingMode === 'now'
              ? 'Публикуем...'
              : 'Планируем...'
            : isOpeningManagedBroadcastEditor
              ? 'Открываем...'
              : broadcastFooterPrimaryActionLabel
      }
      primaryDisabled={broadcastSendDisabled}
      onTest={handleSendChannelBroadcastTest}
      onPrimary={handleSendChannelBroadcast}
    />
  );

  function resetBroadcastPlanner() {
    setBroadcastPlannerState(EMPTY_BROADCAST_PLANNER_STATE);
    setBroadcastPlannerResetKey((current) => current + 1);
  }

  function resetBroadcastComposer() {
    setEditingManagedBroadcast(null);
    setDuplicatedManagedBroadcast(null);
    setBroadcastText('');
    setBroadcastTextError('');
    setBroadcastButtons([]);
    setBroadcastButtonsSheetOpen(false);
    setBroadcastButtonErrors([]);
    setBroadcastImageEnabled(false);
    setBroadcastImageBase64('');
    setBroadcastImageMimeType('');
    setBroadcastImageFileName('');
    setBroadcastImages([]);
    setBroadcastImagesPreparing(false);
    setBroadcastVideoCleared(false);
    setBroadcastTimingMode('now');
    setBroadcastCycleDraft(createDefaultBroadcastCycleDraft());
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
    setPendingBroadcastSlotConflict(null);
    setPendingBroadcastPublishReview(null);
    setBroadcastWorkspaceView('compose');
    resetBroadcastPlanner();
  }

  function handleCancelBroadcastEdit() {
    resetBroadcastComposer();
  }

  function handleClearBroadcastComposer() {
    if (editingManagedBroadcast || duplicatedManagedBroadcast) {
      handleCancelBroadcastEdit();
      return;
    }

    if (!chatId || clearBroadcastHandoffMutation.isPending) {
      resetBroadcastComposer();
      return;
    }

    clearBroadcastHandoffMutation.mutate();
  }

  function handleBroadcastPlannerStateChange(nextState: BroadcastSchedulePlannerSelectionState) {
    setBroadcastPlannerState((current) =>
      areBroadcastPlannerStatesEqual(current, nextState) ? current : nextState,
    );
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

  function handleDuplicateManagedBroadcast(broadcast: ManagedBroadcastListItem) {
    if (!chatId || duplicateManagedBroadcastMutation.isPending) {
      return;
    }

    duplicateManagedBroadcastMutation.mutate(broadcast.id);
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

  function handleBroadcastButtonsEnabledChange(enabled: boolean) {
    if (enabled) {
      if (broadcastButtons.length === 0) {
        setBroadcastButtonRevealSignal((current) => current + 1);
      }
      setBroadcastButtons((current) =>
        current.length > 0 ? current : [createEmptyBroadcastLinkButton()],
      );
      return;
    }

    setBroadcastButtons([]);
    setBroadcastButtonErrors([]);
  }

  function validateBroadcastButtonDraft() {
    const nextErrors = validateBroadcastLinkButtons(normalizedBroadcastButtons);
    setBroadcastButtonErrors(nextErrors);
    return !hasBroadcastLinkButtonErrors(nextErrors);
  }

  function buildBroadcastPublishBasePayload(): BroadcastHandoffPayload {
    const scheduledSlots = sortAndUniqueBroadcastSlots(broadcastScheduledSlots);
    const buttonState = buildBroadcastLinkButtonLegacyFields(normalizedBroadcastButtons);
    const cycleDraft = normalizeBroadcastCycleDraft(broadcastCycleDraft);
    const isCalendarSchedule = broadcastTimingMode === 'scheduled';
    const isCycleSchedule = broadcastTimingMode === 'cycle';

    return {
      targetMode: 'current',
      targetChatIds: chatId ? [chatId] : [],
      applyToAllChats: false,
      buttons: buttonState.buttons,
      buttonEnabled: buttonState.buttonEnabled,
      buttonUrl: buttonState.buttonUrl,
      buttonText: buttonState.buttonText,
      scheduleMode: isCalendarSchedule ? 'calendar' : 'legacy',
      scheduleTimezone: broadcastScheduleTimezone.trim() || resolveBroadcastScheduleTimezone(),
      scheduledSlots: isCalendarSchedule ? scheduledSlots : [],
      sendAt: isCycleSchedule ? resolveBroadcastCycleSendAt(cycleDraft) : null,
      cycleEnabled: isCycleSchedule,
      cycleEveryHours: isCycleSchedule ? cycleDraft.everyHours : 1,
      cycleCount: isCycleSchedule
        ? cycleDraft.count
        : isCalendarSchedule
          ? Math.max(scheduledSlots.length, 1)
          : 1,
    };
  }

  function buildBroadcastTestPayload(): SendBroadcastPayload {
    const buttonState = buildBroadcastLinkButtonLegacyFields(normalizedBroadcastButtons);
    const videoSource = editingManagedBroadcast ?? duplicatedManagedBroadcast;
    const keepVideoMedia =
      !broadcastVideoCleared &&
      !broadcastImageEnabled &&
      videoSource?.mediaType === 'video' &&
      videoSource.mediaPayload;

    return {
      text: normalizedBroadcastText,
      textFormat: 'markdown',
      targetMode: 'current',
      targetChatIds: chatId ? [chatId] : [],
      applyToAllChats: false,
      buttons: buttonState.buttons,
      buttonEnabled: buttonState.buttonEnabled,
      buttonUrl: buttonState.buttonUrl,
      buttonText: buttonState.buttonText,
      imageEnabled: broadcastImageEnabled,
      imageBase64: broadcastImageEnabled ? broadcastImageBase64 : '',
      imageMimeType: broadcastImageEnabled ? broadcastImageMimeType : '',
      imageFileName: broadcastImageEnabled ? broadcastImageFileName : '',
      images: broadcastImageEnabled ? broadcastImages : [],
      mediaType: keepVideoMedia ? 'video' : null,
      mediaPayload: keepVideoMedia ? (videoSource?.mediaPayload ?? null) : null,
      mediaMimeType: keepVideoMedia ? (videoSource?.mediaMimeType ?? '') : '',
      mediaFileName: keepVideoMedia ? (videoSource?.mediaFileName ?? '') : '',
      scheduleMode: 'legacy',
      scheduleTimezone: broadcastScheduleTimezone.trim() || resolveBroadcastScheduleTimezone(),
      scheduledSlots: [],
      sendAt: null,
      cycleEnabled: false,
      cycleEveryHours: 1,
      cycleCount: 1,
    };
  }

  function submitBroadcastPayload(broadcastId: string | null, payload: SendBroadcastPayload) {
    if (broadcastId) {
      updateManagedBroadcastMutation.mutate({
        broadcastId,
        payload,
      });
      return;
    }

    sendBroadcastMutation.mutate(payload);
  }

  function handleCloseBroadcastPublishReview() {
    if (!isBroadcastBusy) {
      setPendingBroadcastPublishReview(null);
    }
  }

  function confirmBroadcastPublishReview() {
    if (!pendingBroadcastPublishReview || isBroadcastBusy) {
      return;
    }

    const { broadcastId, payload } = pendingBroadcastPublishReview;
    setPendingBroadcastPublishReview(null);

    const hasConflictingSlots =
      payload.scheduleMode === 'calendar' &&
      findBroadcastSlotConflicts(payload.scheduledSlots, broadcastOccupiedSlots).length > 0;
    if (hasConflictingSlots) {
      setPendingBroadcastSlotConflict({ broadcastId, payload });
      return;
    }

    submitBroadcastPayload(broadcastId, payload);
  }

  function handleCloseBroadcastSlotConflict() {
    setPendingBroadcastSlotConflict(null);
    setBroadcastScheduleError('Выберите свободное время.');
  }

  function confirmBroadcastSlotReplacement() {
    if (!pendingBroadcastSlotConflict) {
      return;
    }

    const { broadcastId, payload } = pendingBroadcastSlotConflict;
    setPendingBroadcastSlotConflict(null);
    setBroadcastScheduleError('');
    submitBroadcastPayload(broadcastId, {
      ...payload,
      replaceConflictingSlots: true,
    });
  }

  function handleSendChannelBroadcast() {
    if (!chatId) {
      return;
    }

    const scheduledSlots = sortAndUniqueBroadcastSlots(broadcastScheduledSlots);
    const cycleDraft = normalizeBroadcastCycleDraft(broadcastCycleDraft);
    const cycleError =
      broadcastTimingMode === 'cycle'
        ? getBroadcastCycleValidationError(cycleDraft, Date.now())
        : null;
    setBroadcastScheduleError('');
    setBroadcastCycleError('');

    let hasError = false;
    const videoSource = editingManagedBroadcast ?? duplicatedManagedBroadcast;
    const keepVideoMedia =
      !broadcastVideoCleared &&
      !broadcastImageEnabled &&
      videoSource?.mediaType === 'video' &&
      videoSource.mediaPayload;
    const broadcastImagesReady = areBroadcastImagesReady(broadcastImages);
    const hasDirectContent = Boolean(
      normalizedBroadcastText || broadcastImageEnabled || keepVideoMedia,
    );

    if (editingManagedBroadcast) {
      if (!hasDirectContent) {
        setBroadcastTextError('Добавьте текст, фото или видео.');
        hasError = true;
      } else if (normalizedBroadcastText.length > MAX_BROADCAST_TEXT_LENGTH) {
        setBroadcastTextError(`Максимум ${MAX_BROADCAST_TEXT_LENGTH} символов.`);
        hasError = true;
      } else {
        setBroadcastTextError('');
      }
    } else if (!hasDirectContent) {
      setBroadcastTextError('Добавьте текст или фото.');
      hasError = true;
    } else if (normalizedBroadcastText.length > MAX_BROADCAST_TEXT_LENGTH) {
      setBroadcastTextError(`Максимум ${MAX_BROADCAST_TEXT_LENGTH} символов.`);
      hasError = true;
    } else {
      setBroadcastTextError('');
    }

    if (broadcastImageEnabled) {
      if (broadcastImagesPreparing) {
        setBroadcastImageError('Фото ещё готовится.');
        hasError = true;
      } else if (!broadcastImagesReady) {
        setBroadcastImageError('Фото не готово.');
        hasError = true;
      } else {
        setBroadcastImageError('');
      }
    } else {
      setBroadcastImageError('');
    }

    if (!validateBroadcastButtonDraft()) {
      hasError = true;
    }

    if (broadcastTimingMode === 'scheduled' && scheduledSlots.length === 0) {
      setBroadcastScheduleError('Добавьте хотя бы один слот публикации.');
      hasError = true;
    } else if (broadcastTimingMode === 'scheduled' && broadcastPlannerState.futureSlotCount === 0) {
      setBroadcastScheduleError('Добавьте хотя бы один будущий слот публикации.');
      hasError = true;
    } else if (broadcastTimingMode === 'cycle' && cycleError) {
      setBroadcastCycleError(cycleError);
      hasError = true;
    } else {
      setBroadcastScheduleError('');
      setBroadcastCycleError('');
    }

    if (hasError) {
      return;
    }

    const publishBasePayload = {
      ...buildBroadcastPublishBasePayload(),
      replaceConflictingSlots: false,
    };

    const payload: SendBroadcastPayload = {
      text: normalizedBroadcastText,
      textFormat: 'markdown',
      ...publishBasePayload,
      imageEnabled: broadcastImageEnabled,
      imageBase64: broadcastImageEnabled ? broadcastImageBase64 : '',
      imageMimeType: broadcastImageEnabled ? broadcastImageMimeType : '',
      imageFileName: broadcastImageEnabled ? broadcastImageFileName : '',
      images: broadcastImageEnabled ? broadcastImages : [],
      mediaType: keepVideoMedia ? 'video' : null,
      mediaPayload: keepVideoMedia ? (videoSource?.mediaPayload ?? null) : null,
      mediaMimeType: keepVideoMedia ? (videoSource?.mediaMimeType ?? '') : '',
      mediaFileName: keepVideoMedia ? (videoSource?.mediaFileName ?? '') : '',
    };

    setPendingBroadcastPublishReview({
      broadcastId: editingManagedBroadcast?.id ?? null,
      payload,
    });
  }

  function handleSendChannelBroadcastTest() {
    if (!chatId || sendBroadcastTestMutation.isPending) {
      return;
    }

    const videoSource = editingManagedBroadcast ?? duplicatedManagedBroadcast;
    const keepVideoMedia =
      !broadcastVideoCleared &&
      !broadcastImageEnabled &&
      videoSource?.mediaType === 'video' &&
      videoSource.mediaPayload;
    const broadcastImagesReady = areBroadcastImagesReady(broadcastImages);
    let hasError = false;

    if (!normalizedBroadcastText && !broadcastImageEnabled && !keepVideoMedia) {
      setBroadcastTextError('Добавьте текст или фото.');
      hasError = true;
    } else if (normalizedBroadcastText.length > MAX_BROADCAST_TEXT_LENGTH) {
      setBroadcastTextError(`Максимум ${MAX_BROADCAST_TEXT_LENGTH} символов.`);
      hasError = true;
    } else {
      setBroadcastTextError('');
    }

    if (broadcastImageEnabled) {
      if (broadcastImagesPreparing) {
        setBroadcastImageError('Фото ещё готовится.');
        hasError = true;
      } else if (!broadcastImagesReady) {
        setBroadcastImageError('Фото не готово.');
        hasError = true;
      } else {
        setBroadcastImageError('');
      }
    } else {
      setBroadcastImageError('');
    }

    if (!validateBroadcastButtonDraft()) {
      hasError = true;
    }

    if (hasError) {
      return;
    }

    sendBroadcastTestMutation.mutate(buildBroadcastTestPayload());
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
        avatar={
          <EntityAvatar
            title={resolvedTitle || 'Настройки'}
            entityType="channel"
            avatarUrl={channelHeader?.avatarUrl ?? routeAvatarUrl ?? null}
            className="compact-page-header__entity-avatar"
          />
        }
        compact={isHeaderCompact}
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
                  title="Обсуждение"
                  description="Тред под постами через бота. Нативные комментарии MAX не меняются."
                  hintKey="commentsEnabled"
                  openHintKey={openHintKey}
                  onToggleHint={toggleHint}
                  checked={draft.commentsEnabled}
                  onChange={(nextValue) => patchDraft('commentsEnabled', nextValue)}
                />

                {draft.commentsEnabled ? (
                  <div className="channel-settings-stack channel-settings-stack--form">
                    <label className="field channel-settings-field--wide">
                      <span>Текст</span>
                      <textarea
                        rows={3}
                        value={draft.commentsMessageText}
                        onChange={(event) => patchDraft('commentsMessageText', event.target.value)}
                        placeholder="О чём оставить комментарий"
                      />
                    </label>

                    <ChannelSettingsToggleCard
                      title="Модерация"
                      description="Проверка комментариев перед публикацией."
                      hintKey="commentsModerationEnabled"
                      openHintKey={openHintKey}
                      onToggleHint={toggleHint}
                      checked={draft.commentsModerationEnabled}
                      onChange={(nextValue) => patchDraft('commentsModerationEnabled', nextValue)}
                    />

                    {draft.commentsModerationEnabled ? (
                      <div className="channel-settings-stack channel-settings-toggle-grid">
                        <ChannelSettingsToggleCard
                          title="Без ссылок"
                          description="Комментарии со ссылками блокируются."
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
                          description="Блокирует частые повторы."
                          hintKey="commentsAntiSpamEnabled"
                          openHintKey={openHintKey}
                          onToggleHint={toggleHint}
                          checked={draft.commentsAntiSpamEnabled}
                          onChange={(nextValue) => patchDraft('commentsAntiSpamEnabled', nextValue)}
                        />

                        <ChannelSettingsToggleCard
                          title="Два подряд"
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

      {shouldShowVkParsingSection ? (
        <GlassCard className="channel-settings-card" elevated>
          <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
            <SettingsSectionToggle
              title="ВК-парсинг"
              summary=""
              status="Импорт"
              icon="links"
              tone="ink"
              open={expandedSections.vkParsing}
              controls="channel-settings-vk-parsing"
              onClick={() => toggleSection('vkParsing')}
            />
          </div>

          <SettingsDrilldownPanel
            id="channel-settings-vk-parsing"
            open={expandedSections.vkParsing}
            title="ВК-парсинг"
            tone="ink"
            className="settings-drilldown__panel--campaign settings-drilldown__panel--vk-parsing"
            onClose={() => toggleSection('vkParsing')}
          >
            <div
              id="channel-settings-vk-parsing"
              className={cn('settings-section__collapse', expandedSections.vkParsing && 'is-open')}
            >
              {expandedSections.vkParsing ? (
                <div className="settings-section__collapse-inner">
                  {canAccessVkParsing ? (
                    <Suspense fallback={null}>
                      <LazyVkParsingCard
                        api={api}
                        chatId={chatId}
                        active={expandedSections.vkParsing}
                      />
                    </Suspense>
                  ) : vkParsingCapability ? (
                    <StatusState
                      tone="warning"
                      title="VK-парсинг не настроен"
                      description={
                        vkParsingCapability.reason ??
                        'Сервер не подключён к VK API: нужен VK_SERVICE_TOKEN в окружении API.'
                      }
                      action={
                        <button
                          type="button"
                          className="button button--ghost"
                          disabled={vkParsingCapabilityQuery.isFetching}
                          onClick={() => void vkParsingCapabilityQuery.refetch()}
                        >
                          Проверить снова
                        </button>
                      }
                    />
                  ) : null}
                </div>
              ) : null}
            </div>
          </SettingsDrilldownPanel>
        </GlassCard>
      ) : null}

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
          variant="screen"
          tone="mint"
          className="settings-drilldown__panel--notice settings-drilldown__panel--post-suggestions settings-drilldown__panel--post-suggestions-screen"
          overlayClassName="settings-drilldown--post-suggestions-screen"
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
                  title="Приём предложек"
                  description="Кнопка предложки под новыми постами."
                  hintKey="postSuggestionsEnabled"
                  openHintKey={openHintKey}
                  onToggleHint={toggleHint}
                  checked={draft.postSuggestionsEnabled}
                  onChange={(nextValue) => patchDraft('postSuggestionsEnabled', nextValue)}
                />

                <div className="channel-settings-mode-card channel-settings-mode-card--suggestion">
                  <span className="channel-settings-mode-card__label">Отправка</span>
                  <SegmentedControl<ChannelSuggestionEntryMode>
                    value={draft.postSuggestionsEntryMode}
                    options={CHANNEL_SUGGESTION_ENTRY_MODE_OPTIONS}
                    onChange={(value) => patchDraft('postSuggestionsEntryMode', value)}
                    className="channel-settings-mode-card__control"
                    ariaLabel="Способ отправки предложки"
                  />
                </div>

                <div className="channel-settings-stack channel-settings-form-grid">
                  <label className="field">
                    <span>Кнопка</span>
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

                  <label className="field channel-settings-field--wide">
                    <span>Требования</span>
                    <textarea
                      rows={4}
                      value={draft.postSuggestionsText}
                      onChange={(event) => patchDraft('postSuggestionsText', event.target.value)}
                      placeholder="Опишите, что пользователь должен прислать боту после нажатия кнопки."
                    />
                  </label>

                  <label className="field channel-settings-field--wide">
                    <span>Пост с кнопками</span>
                    <textarea
                      rows={3}
                      value={draft.engagementMessageText}
                      onChange={(event) => patchDraft('engagementMessageText', event.target.value)}
                      placeholder="Есть идея или обратная связь? Нажмите кнопку ниже."
                    />
                  </label>

                  <label className="field">
                    <span>Лимит</span>
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
            title="Автопостинг"
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
          title="Автопостинг"
          summary={broadcastHeaderSummary}
          variant="screen"
          tone="sky"
          className="settings-drilldown__panel--campaign settings-drilldown__panel--broadcast settings-drilldown__panel--broadcast-screen"
          onClose={() => toggleSection('broadcast')}
          footer={activeBroadcastWorkspaceView === 'compose' ? broadcastDrilldownFooter : null}
        >
          <div
            id="channel-settings-broadcast"
            className={cn('settings-section__collapse', expandedSections.broadcast && 'is-open')}
          >
            {expandedSections.broadcast ? (
              <div className="settings-section__collapse-inner">
                <div className="channel-broadcast-studio broadcast-studio-screen broadcast-studio-screen--channel">
                  <div className="broadcast-studio-screen__chrome">
                    <BroadcastStudioHeader
                      title={
                        editingManagedBroadcast
                          ? 'Редактирование'
                          : duplicatedManagedBroadcast
                            ? 'Копия автопостинга'
                            : 'Автопостинг'
                      }
                      subtitle={broadcastFooterTitle}
                      readyCount={broadcastStudioReadyCount}
                      totalCount={3}
                      signals={broadcastStudioSignals}
                      busy={isBroadcastBusy}
                      editing={Boolean(editingManagedBroadcast)}
                    />

                    <BroadcastWorkspaceChrome
                      showTabs={showBroadcastWorkspaceTabs}
                      value={activeBroadcastWorkspaceView}
                      historyCount={orderedManagedBroadcasts.length}
                      disabled={isBroadcastBusy}
                      showReset={showBroadcastResetAction}
                      resetLabel={broadcastResetActionLabel}
                      resetPending={clearBroadcastHandoffMutation.isPending}
                      onChange={setBroadcastWorkspaceView}
                      onReset={handleClearBroadcastComposer}
                    />
                  </div>

                  {activeBroadcastWorkspaceView === 'compose' ? (
                    <div className="broadcast-compose-flow broadcast-compose-flow--screen">
                      <div className="broadcast-stage-card broadcast-stage-card--message broadcast-stage-card--primary">
                        <div className="broadcast-stage-card__head">
                          <div className="broadcast-stage-card__title-wrap">
                            <strong>Сообщение</strong>
                          </div>
                          <span
                            className={cn(
                              'broadcast-stage-card__status',
                              broadcastContentReady ? 'is-ready' : 'is-pending',
                            )}
                          >
                            {broadcastContentReady
                              ? 'Готов'
                              : broadcastImagesPreparing
                                ? 'Фото...'
                                : broadcastHasDirectContent
                                  ? 'Проверка'
                                  : 'Пусто'}
                          </span>
                        </div>

                        <div className="broadcast-stage-card__body">
                          <Suspense fallback={null}>
                            <LazyBroadcastContentComposer
                              text={broadcastText}
                              maxLength={MAX_BROADCAST_TEXT_LENGTH}
                              images={broadcastImages}
                              videoLabel={editingBroadcastHasVideo ? 'Видео' : null}
                              disabled={isBroadcastBusy}
                              textError={broadcastTextError}
                              imageError={broadcastImageError}
                              onTextChange={(nextText) => {
                                setBroadcastText(nextText);
                                if (broadcastTextError) {
                                  setBroadcastTextError('');
                                }
                              }}
                              onImagesChange={(nextImages) => {
                                applyBroadcastImages(nextImages);
                                if (nextImages.length > 0) {
                                  setBroadcastVideoCleared(true);
                                }
                                setBroadcastImageError('');
                                if (broadcastTextError) {
                                  setBroadcastTextError('');
                                }
                              }}
                              onImagePreparationChange={setBroadcastImagesPreparing}
                              onClearVideo={() => {
                                setBroadcastVideoCleared(true);
                              }}
                              onError={(message) => {
                                setBroadcastImageError(message);
                                pushToast({
                                  tone: 'danger',
                                  title: 'Фото не добавлено',
                                  description: message,
                                });
                                maxNotify('error');
                              }}
                              buttons={normalizedBroadcastButtons}
                              systemButtons={broadcastSystemButtons}
                              buttonsStatusLabel={broadcastVisibleButtonStatus}
                              buttonsActive={broadcastHasVisibleButtons}
                              buttonsError={!broadcastButtonDraftValid}
                              onOpenButtons={() => setBroadcastButtonsSheetOpen(true)}
                            />
                          </Suspense>
                        </div>
                      </div>

                      <div className="broadcast-stage-card broadcast-stage-card--planner">
                        <div className="broadcast-stage-card__head">
                          <div className="broadcast-stage-card__title-wrap">
                            <strong>Когда</strong>
                          </div>
                        </div>

                        <div className="broadcast-stage-card__body">
                          <Suspense fallback={null}>
                            <LazyBroadcastSchedulePlanner
                              resetKey={broadcastPlannerResetKey}
                              value={broadcastScheduledSlots}
                              occupiedSlots={broadcastOccupiedSlots}
                              error={broadcastScheduleError || broadcastCycleError}
                              disabled={isBroadcastBusy}
                              managedBroadcasts={managedBroadcasts}
                              calendarSlots={broadcastCalendarQuery.data?.slots ?? []}
                              targetAwareAvailability
                              sourceChatId={chatId}
                              managedBroadcastsLoading={
                                settingsScreenQuery.isLoading ||
                                settingsScreenQuery.isFetching ||
                                broadcastCalendarQuery.isFetching
                              }
                              currentTargetLabel={broadcastTargetContextLabel}
                              targetContextLabel={broadcastTargetContextLabel}
                              calendarRefreshing={broadcastCalendarQuery.isFetching}
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
                              timingMode={broadcastTimingMode}
                              cycle={broadcastCycleDraft}
                              onTimingModeChange={(nextMode) => {
                                setBroadcastTimingMode(nextMode);
                                setBroadcastScheduleError('');
                                setBroadcastCycleError('');
                              }}
                              onCycleChange={(nextCycle) => {
                                setBroadcastCycleDraft(nextCycle);
                                setBroadcastCycleError('');
                              }}
                              onSelectionStateChange={handleBroadcastPlannerStateChange}
                              onChange={(nextValue) => {
                                setBroadcastScheduledSlots(nextValue);
                                if (broadcastScheduleError) {
                                  setBroadcastScheduleError('');
                                }
                              }}
                            />
                          </Suspense>
                        </div>
                      </div>
                    </div>
                  ) : activeBroadcastWorkspaceView === 'calendar' ? (
                    <div className="broadcast-stage-card broadcast-stage-card--planner broadcast-stage-card--calendar">
                      <div className="broadcast-stage-card__head">
                        <div className="broadcast-stage-card__title-wrap">
                          <strong>Календарь</strong>
                        </div>
                      </div>

                      <div className="broadcast-stage-card__body">
                        <Suspense fallback={null}>
                          <LazyBroadcastSchedulePlanner
                            resetKey={`calendar-${broadcastPlannerResetKey}`}
                            value={[]}
                            occupiedSlots={broadcastOccupiedSlots}
                            disabled={isBroadcastBusy}
                            managedBroadcasts={managedBroadcasts}
                            calendarSlots={broadcastCalendarQuery.data?.slots ?? []}
                            sourceChatId={chatId}
                            managedBroadcastsLoading={
                              settingsScreenQuery.isLoading ||
                              settingsScreenQuery.isFetching ||
                              broadcastCalendarQuery.isFetching
                            }
                            currentTargetLabel={broadcastTargetContextLabel}
                            targetContextLabel={broadcastTargetContextLabel}
                            calendarRefreshing={broadcastCalendarQuery.isFetching}
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
                            viewMode="calendar"
                            onSelectionStateChange={handleBroadcastPlannerStateChange}
                            onChange={(nextValue) => {
                              setBroadcastTimingMode('scheduled');
                              setBroadcastScheduledSlots(nextValue);
                              setBroadcastScheduleError('');
                              setBroadcastWorkspaceView('compose');
                            }}
                          />
                        </Suspense>
                      </div>
                    </div>
                  ) : (
                    <div className="broadcast-stage-card broadcast-stage-card--feed">
                      <div className="broadcast-stage-card__head">
                        <div className="broadcast-stage-card__title-wrap">
                          <strong>История</strong>
                          <small>
                            {filteredBroadcasts.length > 0
                              ? `${filteredBroadcasts.length} записей`
                              : 'Пусто'}
                          </small>
                        </div>
                      </div>

                      <div className="broadcast-stage-card__body">
                        <BroadcastHistoryFilterTabs
                          value={broadcastHistoryFilter}
                          counts={broadcastHistoryCounts}
                          onChange={setBroadcastHistoryFilter}
                        />

                        {editingManagedBroadcast ? (
                          <div className={cn('managed-broadcast-card', 'is-active')}>
                            <div className="managed-broadcast-card__top">
                              <span className="managed-broadcast-card__main">
                                <span className={cn('managed-broadcast-card__badge', 'is-active')}>
                                  Черновик
                                </span>
                                <strong>Редактирование автопостинга</strong>
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
                                broadcastHasVisibleButtons ? broadcastVisibleButtonStatus : null,
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
                            {filteredBroadcasts.length === 0 ? (
                              <div className="managed-broadcasts-list__empty">Пусто</div>
                            ) : null}

                            {filteredBroadcasts.map((broadcast) => {
                              const cardTone = resolveManagedBroadcastCardTone(broadcast);
                              const cardMetric = resolveManagedBroadcastMetric(
                                broadcast,
                                broadcastNowMs,
                              );
                              const cardFacts = buildManagedBroadcastFactChips(broadcast);
                              const canEditBroadcastSchedule =
                                broadcast.scheduleMode === 'calendar' &&
                                broadcast.status !== 'COMPLETED' &&
                                broadcast.status !== 'CANCELED';
                              const canCancelBroadcast =
                                broadcast.status !== 'COMPLETED' && broadcast.status !== 'CANCELED';
                              const isDeletingBroadcast =
                                cancelManagedBroadcastMutation.isPending &&
                                cancelManagedBroadcastMutation.variables === broadcast.id;
                              const isOpeningBroadcastEditor =
                                openManagedBroadcastEditorMutation.isPending &&
                                openManagedBroadcastEditorMutation.variables === broadcast.id;
                              const isDuplicatingBroadcast =
                                duplicateManagedBroadcastMutation.isPending &&
                                duplicateManagedBroadcastMutation.variables === broadcast.id;
                              const isRetryingBroadcast =
                                retryManagedBroadcastMutation.isPending &&
                                retryManagedBroadcastMutation.variables === broadcast.id;
                              const cardBadge = isOpeningBroadcastEditor
                                ? 'Открываем'
                                : resolveManagedBroadcastCardBadge(broadcast);

                              return (
                                <ManagedBroadcastHistoryCard
                                  key={broadcast.id}
                                  broadcast={broadcast}
                                  tone={cardTone}
                                  badge={cardBadge}
                                  title={resolveManagedBroadcastCardTitle(broadcast)}
                                  metric={cardMetric}
                                  facts={cardFacts}
                                  canEdit={canEditBroadcastSchedule}
                                  canCancel={canCancelBroadcast}
                                  isBusy={isBroadcastBusy}
                                  isDeleting={isDeletingBroadcast}
                                  isDuplicating={isDuplicatingBroadcast}
                                  isRetrying={isRetryingBroadcast}
                                  onEdit={() => handleEditManagedBroadcast(broadcast)}
                                  onDuplicate={() => handleDuplicateManagedBroadcast(broadcast)}
                                  onRetry={() => retryManagedBroadcastMutation.mutate(broadcast.id)}
                                  onDelete={() => handleDeleteManagedBroadcast(broadcast)}
                                />
                              );
                            })}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
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
            summary="Пост с голосованием"
            tone="ink"
            className="settings-drilldown__panel--campaign settings-drilldown__panel--poll settings-drilldown__panel--channel-poll"
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
              status="Мини"
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
            summary="Запуск и итоги"
            tone="amber"
            className="settings-drilldown__panel--campaign settings-drilldown__panel--giveaway settings-drilldown__panel--channel-giveaway"
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

      <Suspense fallback={null}>
        <LazyBroadcastButtonsSheet
          open={broadcastButtonsSheetOpen}
          api={api}
          enabled={broadcastHasButton}
          buttons={broadcastButtons}
          errors={broadcastButtonErrors}
          revealNextStepSignal={broadcastButtonRevealSignal}
          contextEntityType="channel"
          disabled={isBroadcastBusy}
          urlPlaceholder="https://max.ru/channel/..."
          textPlaceholder="Открыть"
          onEnabledChange={handleBroadcastButtonsEnabledChange}
          onChange={(nextButtons) => {
            setBroadcastButtons(nextButtons);
            if (broadcastButtonErrors.length > 0) {
              setBroadcastButtonErrors([]);
            }
          }}
          onClose={() => setBroadcastButtonsSheetOpen(false)}
        />
      </Suspense>

      <Suspense fallback={null}>
        <LazyBroadcastPublishReviewSheet
          id="channel-broadcast-publish-review"
          open={pendingBroadcastPublishReview !== null}
          text={pendingBroadcastReviewPayload?.text ?? ''}
          hasMedia={Boolean(
            pendingBroadcastReviewPayload?.imageEnabled ||
            pendingBroadcastReviewPayload?.mediaType === 'video',
          )}
          facts={pendingBroadcastReviewFacts}
          confirmLabel={broadcastPrimaryActionLabel}
          confirmBusyLabel={
            updateManagedBroadcastMutation.isPending
              ? 'Сохраняем...'
              : sendBroadcastMutation.isPending
                ? broadcastTimingMode === 'now'
                  ? 'Публикуем...'
                  : 'Планируем...'
                : '...'
          }
          isBusy={sendBroadcastMutation.isPending || updateManagedBroadcastMutation.isPending}
          extraActionBusy={sendBroadcastTestMutation.isPending}
          extraActionDisabled={!broadcastTestReady}
          onExtraAction={handleSendChannelBroadcastTest}
          onClose={handleCloseBroadcastPublishReview}
          onConfirm={confirmBroadcastPublishReview}
        />
      </Suspense>

      <ActionConfirmSheet
        id="channel-broadcast-slot-conflict"
        open={pendingBroadcastSlotConflict !== null}
        title="Заменить слот?"
        summary="На это время уже есть автопостинг."
        previewTitle={
          pendingBroadcastConflictPreviewSlot
            ? formatCompactManagedBroadcastDateTime(
                pendingBroadcastConflictPreviewSlot,
                pendingBroadcastSlotConflict?.payload.scheduleTimezone,
              )
            : 'Занятый слот'
        }
        previewMeta={
          pendingBroadcastConflictSlots.length > 1
            ? formatChannelCountLabel(
                pendingBroadcastConflictSlots.length,
                'занятый слот',
                'занятых слота',
                'занятых слотов',
              )
            : 'Текущий автопостинг на это время будет заменён.'
        }
        confirmLabel="Заменить"
        cancelLabel="Другое время"
        tone="accent"
        onClose={handleCloseBroadcastSlotConflict}
        onConfirm={confirmBroadcastSlotReplacement}
      />

      <ActionConfirmSheet
        id="channel-managed-broadcast-delete"
        open={managedBroadcastDeleteTarget !== null}
        title="Удалить автопостинг?"
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
