import type {
  LogsDashboardRange,
  LogsDashboardResponse,
  LogsDashboardViolation,
  ManualModerationAction,
  ManualModerationActionRequest,
  ChatParticipantItem,
  GlobalSpammerReviewAction,
  GlobalSpammerReviewCandidate,
  GlobalSpammerUserDiagnostics,
  ModerationFeedFilter,
  MembershipActivityItem,
} from '@maxim/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import '../styles/settings-drilldown-core.css';
import '../styles/dashboard-events.css';
import {
  startTransition,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { ChatParticipantSheet } from '../components/dashboard/chat-participant-sheet';
import { ChatParticipantsRoster } from '../components/dashboard/chat-participants-roster';
import { MembershipActivityFeed } from '../components/dashboard/membership-activity-feed';
import { EntityAvatar } from '../components/ui/entity-avatar';
import { PersonAvatar } from '../components/ui/person-avatar';
import { BackChevronIcon } from '../components/ui/entity-header-icons';
import { GlassCard } from '../components/ui/glass-card';
import { SegmentedControl } from '../components/ui/segmented-control';
import { SettingsDrilldownPanel } from '../components/ui/settings-drilldown-panel';
import { Spinner } from '../components/ui/spinner';
import { StatusState } from '../components/ui/status-state';
import { useToast } from '../components/ui/toast';
import {
  applyManualModerationAction,
  getChatActivityDashboard,
  getChatActivityFeed,
  getChatModerationDashboard,
  getChatParticipantsPage,
  getChatModerationFeed,
  getGlobalSpammerReviewQueue,
  getGlobalSpammerUserDiagnostics,
  getLogsDashboard,
  handoffChatMemberProfile,
  handoffChatMemberProfileKeepalive,
  reviewGlobalSpammerCandidate,
  updateChatParticipantImmunity,
} from '../lib/api/events-client';
import type { ApiTransport } from '../lib/api/transport';
import { readChatTitle, saveChatTitle } from '../lib/chat-titles';
import { buildManagedEntitiesRoute, saveLastEntityId } from '../lib/last-chat';
import { openMaxBotLinkAndClose } from '../lib/max-bridge';
import { resolveModerationFeedReason } from '../lib/moderation-feed-reason';
import { queryKeys } from '../lib/query-keys';
import { readStatsSnapshot, saveStatsSnapshot } from '../lib/stats-snapshot-cache';
import { useChatParticipantsFeed } from '../lib/use-chat-participants-feed';
import { useMembershipActivityFeed } from '../lib/use-membership-activity-feed';
import { useModerationFeed } from '../lib/use-moderation-feed';

type ViolationItem = LogsDashboardViolation;
type DisplayAction = 'WARN' | 'DELETE_MESSAGE' | 'MUTE' | 'BAN' | 'UNMUTE' | 'UNBAN';
type EventsFilter = ModerationFeedFilter;
type EventsSection = 'activity' | 'moderation' | 'participants';
type SpammerDiagnosticsTarget = {
  userId: string;
  displayName: string;
  avatarUrl?: string | null;
  profileUrl?: string | null;
  profileHandoffUrl?: string | null;
};
type ScoreMeterStyle = CSSProperties & { '--spammer-score': string };

const MUTE_DURATION_MIN_HOURS = 1;
const MUTE_DURATION_MAX_HOURS = 336;
const PARTICIPANTS_SEARCH_DEBOUNCE_MS = 350;
const IDLE_PREFETCH_DELAY_MS = 700;

const actionLabelMap: Record<DisplayAction, string> = {
  DELETE_MESSAGE: 'Удаление',
  WARN: 'Предупреждение',
  MUTE: 'Мут',
  BAN: 'Бан',
  UNMUTE: 'Мут снят',
  UNBAN: 'Возврат',
};

const actionToneMap: Record<DisplayAction, 'neutral' | 'warning' | 'danger' | 'success'> = {
  WARN: 'warning',
  DELETE_MESSAGE: 'neutral',
  MUTE: 'warning',
  BAN: 'danger',
  UNMUTE: 'success',
  UNBAN: 'success',
};

const periodOptions: Array<{ value: LogsDashboardRange; label: string }> = [
  { value: '24h', label: '24ч' },
  { value: '7d', label: '7д' },
  { value: '30d', label: '30д' },
];

function ModerationTabIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden focusable="false">
      <path
        d="M10 2.7 15.8 5v4.1c0 3.4-2 6.1-5.8 8.2-3.8-2.1-5.8-4.8-5.8-8.2V5L10 2.7Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="m7.7 10 1.4 1.4 3.3-3.3"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ActivityTabIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden focusable="false">
      <path
        d="M3.4 13.8h2.3l1.9-3.5 2.4 5.2 2.1-6 1.2 2.2h3.3"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M3.3 4.8h13.4"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.42"
      />
    </svg>
  );
}

function ParticipantsTabIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden focusable="false">
      <path
        d="M6.3 9.2a2.6 2.6 0 1 0 0-5.2 2.6 2.6 0 0 0 0 5.2Z"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <path d="M13.9 8.2a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M3.8 15.7c.2-2.3 2-3.8 4.5-3.8s4.3 1.5 4.5 3.8"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path
        d="M12.1 12.6c.6-.4 1.2-.6 2-.6 1.8 0 3 .9 3.3 2.4"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <circle cx="12" cy="12" r="8.25" />
      <path d="M12 7.75v4.8l3.45 1.95" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function EventsDashboardSkeleton({ section }: { section: Exclude<EventsSection, 'participants'> }) {
  if (section === 'activity') {
    return (
      <div
        className="events-dashboard__activity events-dashboard__activity--loading"
        role="status"
        aria-label="Загружаем сводку"
      >
        <article className="events-dashboard__activity-balance events-dashboard__activity-balance--loading">
          <span className="events-dashboard__skeleton-line events-dashboard__skeleton-line--label" />
          <span className="events-dashboard__skeleton-line events-dashboard__skeleton-line--value" />
          <span className="events-dashboard__skeleton-line events-dashboard__skeleton-line--short" />
        </article>

        <div className="events-dashboard__activity-ledger">
          <article className="events-dashboard__flow-card events-dashboard__flow-card--loading">
            <span className="events-dashboard__skeleton-line events-dashboard__skeleton-line--label" />
            <span className="events-dashboard__skeleton-line events-dashboard__skeleton-line--metric" />
          </article>
          <article className="events-dashboard__flow-card events-dashboard__flow-card--loading">
            <span className="events-dashboard__skeleton-line events-dashboard__skeleton-line--label" />
            <span className="events-dashboard__skeleton-line events-dashboard__skeleton-line--metric" />
          </article>
          <div className="events-dashboard__flow-bar events-dashboard__flow-bar--loading" />
        </div>
      </div>
    );
  }

  return (
    <div
      className="events-dashboard__body events-dashboard__body--moderation events-dashboard__body--loading"
      role="status"
      aria-label="Загружаем сводку"
    >
      <article className="events-dashboard__hero events-dashboard__hero--loading">
        <span className="events-dashboard__skeleton-line events-dashboard__skeleton-line--label" />
        <span className="events-dashboard__skeleton-line events-dashboard__skeleton-line--value" />
      </article>

      <div className="events-dashboard__stack">
        <article className="events-dashboard__metric events-dashboard__metric--loading">
          <span className="events-dashboard__skeleton-line events-dashboard__skeleton-line--label" />
          <span className="events-dashboard__skeleton-line events-dashboard__skeleton-line--metric" />
        </article>
        <article className="events-dashboard__metric events-dashboard__metric--loading">
          <span className="events-dashboard__skeleton-line events-dashboard__skeleton-line--label" />
          <span className="events-dashboard__skeleton-line events-dashboard__skeleton-line--metric" />
        </article>
      </div>
    </div>
  );
}

function getRouteChatTitle(state: unknown): string {
  if (
    typeof state === 'object' &&
    state &&
    'chatTitle' in state &&
    typeof state.chatTitle === 'string'
  ) {
    return state.chatTitle.trim();
  }

  return '';
}

function getRouteChatAvatarUrl(state: unknown): string | null {
  if (
    typeof state === 'object' &&
    state &&
    'avatarUrl' in state &&
    typeof state.avatarUrl === 'string'
  ) {
    const normalized = state.avatarUrl.trim();
    return normalized || null;
  }

  return null;
}

function formatViolationRule(ruleCode: string): string {
  const labels: Record<string, string> = {
    LINK_BLOCKED: 'Ссылки запрещены',
    PROFANITY: 'Нецензурная лексика',
    COMMERCIAL_AD: 'Коммерция',
    MESSAGE_TOO_LONG: 'Слишком длинное сообщение',
    MESSAGE_RATE_LIMIT: 'Флуд сообщениями',
    MESSAGE_COUNT_LIMIT: 'Лимит сообщений',
    PHOTO_BLOCKED: 'Фото запрещены',
    VIDEO_BLOCKED: 'Видео запрещено',
    FILE_BLOCKED: 'Файлы запрещены',
    VOICE_BLOCKED: 'Голосовые запрещены',
    PHOTO_RATE_LIMIT: 'Слишком много фото',
    STICKER_RATE_LIMIT: 'Слишком много стикеров',
    DUPLICATE_WARN: 'Повторяющиеся сообщения',
    DUPLICATE_DELETE: 'Повторяющиеся сообщения',
    DUPLICATE_MUTE: 'Повторяющиеся сообщения',
    DUPLICATE_KICK: 'Повторяющиеся сообщения',
    DUPLICATE_BAN: 'Повторяющиеся сообщения',
    MANUAL_MUTE: 'Мут вручную',
    MANUAL_UNMUTE: 'Мут снят',
    MANUAL_KICK: 'Удаление вручную',
    MANUAL_BAN: 'Бан вручную',
    MANUAL_UNBAN: 'Возврат в чат',
    THEMATIC_FILTER: 'Объявления по теме',
    GLOBAL_USER_BLACKLIST_KICK: 'Запрет по базе',
    GLOBAL_CROSS_CHAT_SPAM: 'Рассылка по чатам',
    GLOBAL_CROSS_CHAT_SPAM_DELETE: 'Рассылка по чатам',
    GLOBAL_SPAMMER_BAN: 'База спама',
    GLOBAL_SPAMMER_KICK: 'База спама',
    MUTE_ACTIVE_DELETE: 'Активный мут',
    NIGHT_MODE_DELETE: 'Ночной режим',
    REQUIRED_SUBSCRIPTION: 'Обязательная подписка',
  };

  if (ruleCode in labels) {
    return labels[ruleCode];
  }

  if (ruleCode.endsWith('_DELETE')) {
    return formatViolationRule(ruleCode.replace(/_DELETE$/, ''));
  }

  return resolveModerationCodeLabel(ruleCode);
}

function resolveModerationCodeLabel(code: string): string {
  const normalized = code.trim().toUpperCase();
  if (!normalized) {
    return 'Нарушение';
  }
  if (normalized.includes('SPAM') || normalized.includes('FANOUT')) {
    return 'Массовая рассылка';
  }
  if (normalized.includes('COMMERCIAL')) {
    return 'Коммерция';
  }
  if (normalized.includes('LINK')) {
    return 'Ссылка';
  }
  if (normalized.includes('PHONE')) {
    return 'Телефон';
  }
  if (normalized.includes('MUTE')) {
    return 'Мут';
  }
  if (normalized.includes('BAN') || normalized.includes('KICK')) {
    return 'Бан';
  }
  if (normalized.includes('PHOTO')) {
    return 'Фото';
  }
  if (normalized.includes('VIDEO')) {
    return 'Видео';
  }
  if (normalized.includes('VOICE')) {
    return 'Голосовое';
  }
  if (normalized.includes('FILE')) {
    return 'Файл';
  }
  return 'Нарушение';
}

function resolveOffenderName(violation: ViolationItem): string {
  const fromPayload = violation.userDisplayName?.trim();
  if (fromPayload) {
    return fromPayload;
  }

  return 'Неизвестный участник';
}

function resolveOffenderInitial(name: string): string {
  const matched = name.match(/[A-Za-zА-Яа-яЁё0-9]/);
  return matched ? matched[0]!.toUpperCase() : '•';
}

function resolveOffenderAvatarUrl(violation: ViolationItem): string | null {
  const normalized = violation.avatarUrl?.trim() ?? '';
  return normalized || null;
}

function handleProfileLinkClick(
  event: MouseEvent<HTMLAnchorElement>,
  onActivate: () => void,
): void {
  event.preventDefault();
  event.stopPropagation();
  onActivate();
}

function handleExpandableCardKeyDown(
  event: KeyboardEvent<HTMLDivElement>,
  onToggle: () => void,
): void {
  if (event.key !== 'Enter' && event.key !== ' ') {
    return;
  }

  if ((event.target as HTMLElement | null)?.closest('a')) {
    return;
  }

  event.preventDefault();
  onToggle();
}

function isManualUnban(violation: ViolationItem): boolean {
  return violation.ruleCode === 'MANUAL_UNBAN';
}

function isManualUnmute(violation: ViolationItem): boolean {
  return violation.ruleCode === 'MANUAL_UNMUTE';
}

function resolveDisplayAction(violation: ViolationItem): DisplayAction {
  if (isManualUnmute(violation)) {
    return 'UNMUTE';
  }

  if (isManualUnban(violation)) {
    return 'UNBAN';
  }

  if (violation.action === 'NONE') {
    return 'DELETE_MESSAGE';
  }

  if (violation.action === 'KICK') {
    return 'BAN';
  }

  return violation.action;
}

function resolveViolationBlurb(violation: ViolationItem): string {
  if (violation.ruleCode === 'MANUAL_UNMUTE') {
    return 'Модератор снял ограничение вручную';
  }

  if (violation.ruleCode === 'MANUAL_UNBAN') {
    return 'Модератор снял бан вручную';
  }

  if (violation.ruleCode === 'MANUAL_MUTE') {
    const metadata =
      violation.metadata &&
      typeof violation.metadata === 'object' &&
      !Array.isArray(violation.metadata)
        ? violation.metadata
        : null;
    const muteDurationHours =
      metadata &&
      typeof metadata.muteDurationHours === 'number' &&
      Number.isFinite(metadata.muteDurationHours)
        ? metadata.muteDurationHours
        : null;

    return muteDurationHours ? `Мут на ${muteDurationHours}ч` : 'Модератор выдал мут';
  }

  if (violation.ruleCode === 'MANUAL_KICK') {
    return 'Модератор удалил участника';
  }

  if (violation.ruleCode === 'MANUAL_BAN') {
    return 'Модератор выдал бан';
  }

  return formatViolationRule(violation.ruleCode);
}

function formatSignedCount(value: number): string {
  if (value > 0) {
    return `+${value}`;
  }

  return String(value);
}

function clampMuteDurationHours(value: number): number {
  const normalized = Number.isFinite(value) ? Math.trunc(value) : MUTE_DURATION_MIN_HOURS;
  return Math.max(MUTE_DURATION_MIN_HOURS, Math.min(MUTE_DURATION_MAX_HOURS, normalized));
}

function formatMuteDurationCompact(hours: number): string {
  return hours >= 24 && hours % 24 === 0 ? `${hours / 24}д` : `${hours}ч`;
}

function resolveApplyActionLabel(
  action: ManualModerationAction,
  muteDurationHours: number,
): string {
  if (action === 'MUTE') {
    return `Мут на ${formatMuteDurationCompact(muteDurationHours)}`;
  }

  if (action === 'UNMUTE') {
    return 'Снять мут';
  }

  if (action === 'UNBAN') {
    return 'Вернуть участника';
  }

  return 'Бан';
}

function resolveConfirmMessage(
  action: ManualModerationAction,
  muteDurationHours: number,
  violation?: ViolationItem,
): string {
  if (action === 'MUTE') {
    return `Выдать мут на ${muteDurationHours}ч? Новые сообщения будут удаляться до конца срока.`;
  }

  if (action === 'UNMUTE') {
    return 'Снять мут у участника?';
  }

  if (action === 'UNBAN') {
    if (violation && isBanActiveFromViolation(violation)) {
      return 'Снять блокировку и вернуть участника в чат?';
    }

    if (
      violation?.ruleCode === 'GLOBAL_SPAMMER_BAN' ||
      violation?.ruleCode === 'GLOBAL_SPAMMER_KICK'
    ) {
      return 'Вернуть участника в чат и отключить удаление по базе спама?';
    }

    return 'Вернуть участника в чат?';
  }

  return 'Выдать бан в чате MAX, пока модератор не вернет участника вручную?';
}

function isMuteActiveFromViolation(violation: ViolationItem): boolean {
  const metadata =
    violation.metadata &&
    typeof violation.metadata === 'object' &&
    !Array.isArray(violation.metadata)
      ? violation.metadata
      : null;
  const now = Date.now();

  const readFutureIso = (key: string): boolean => {
    if (!metadata || !(key in metadata) || typeof metadata[key] !== 'string') {
      return false;
    }
    const timestamp = new Date(metadata[key] as string).getTime();
    return Number.isFinite(timestamp) && timestamp > now;
  };

  if (
    readFutureIso('muteExpiresAt') ||
    readFutureIso('banExpiresAt') ||
    readFutureIso('unbanScheduledAt')
  ) {
    return true;
  }

  if (violation.action !== 'MUTE') {
    return false;
  }

  const createdAtMs = new Date(violation.createdAt).getTime();
  if (!Number.isFinite(createdAtMs)) {
    return false;
  }

  const muteDurationHours =
    metadata && 'muteDurationHours' in metadata && typeof metadata.muteDurationHours === 'number'
      ? metadata.muteDurationHours
      : null;
  if (muteDurationHours === null || !Number.isFinite(muteDurationHours) || muteDurationHours <= 0) {
    return false;
  }

  return createdAtMs + muteDurationHours * 60 * 60 * 1000 > now;
}

function isBanActiveFromViolation(violation: ViolationItem): boolean {
  const metadata =
    violation.metadata &&
    typeof violation.metadata === 'object' &&
    !Array.isArray(violation.metadata)
      ? violation.metadata
      : null;

  if (violation.action !== 'BAN') {
    return false;
  }

  return !metadata || !('muteDurationHours' in metadata);
}

function resolveReleaseAction(
  violation: ViolationItem,
): Extract<ManualModerationAction, 'UNMUTE' | 'UNBAN'> | null {
  if (isMuteActiveFromViolation(violation)) {
    return 'UNMUTE';
  }

  if (isBanActiveFromViolation(violation)) {
    return 'UNBAN';
  }

  return null;
}

function resolveReleaseLabel(action: Extract<ManualModerationAction, 'UNMUTE' | 'UNBAN'>): string {
  return action === 'UNMUTE' ? 'Снять мут' : 'Вернуть';
}

function normalizeActionErrorMessage(error: unknown): string {
  const fallback = 'Не удалось выполнить действие. Проверьте права бота и повторите.';
  if (!(error instanceof Error)) {
    return fallback;
  }

  const raw = error.message.trim();
  if (!raw) {
    return fallback;
  }

  if (raw.startsWith('API request failed:')) {
    const tail = raw.replace(/^API request failed:\s*\d+\s*/u, '').trim();
    if (!tail) {
      return fallback;
    }
    if (/[A-Za-z]/.test(tail) && !/[А-Яа-яЁё]/.test(tail)) {
      return fallback;
    }
    return tail;
  }

  if (/[A-Za-z]/.test(raw) && !/[А-Яа-яЁё]/.test(raw)) {
    return fallback;
  }

  return raw;
}

function normalizeLoadErrorMessage(error: unknown): string {
  const fallback = 'Не удалось загрузить данные. Попробуйте ещё раз.';
  const normalizeRaw = (value: string): string => {
    const raw = value.trim();
    if (!raw) {
      return fallback;
    }

    if (raw.startsWith('API request failed:')) {
      const tail = raw.replace(/^API request failed:\s*\d+\s*/u, '').trim();
      if (!tail || (/[A-Za-z]/.test(tail) && !/[А-Яа-яЁё]/.test(tail))) {
        return fallback;
      }
      return tail;
    }

    if (/[A-Za-z]/.test(raw) && !/[А-Яа-яЁё]/.test(raw)) {
      return fallback;
    }

    return raw;
  };

  if (!(error instanceof Error)) {
    return typeof error === 'string' ? normalizeRaw(error) : fallback;
  }

  return normalizeRaw(error.message);
}

function formatRussianCountLabel(count: number, one: string, few: string, many: string): string {
  const abs = Math.abs(Math.trunc(count));
  const mod10 = abs % 10;
  const mod100 = abs % 100;
  if (mod10 === 1 && mod100 !== 11) {
    return one;
  }
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return few;
  }
  return many;
}

function resolveSpammerReasonLabel(reason: string | null | undefined): string {
  const raw = reason?.trim() ?? '';
  if (!raw) {
    return 'другой сигнал';
  }

  const normalized = raw.toUpperCase();
  if (normalized.includes('EXEMPT')) {
    return 'исключение админа';
  }
  if (
    normalized.includes('ALLOW') ||
    normalized.includes('SUPPRESS') ||
    normalized.includes('UNBAN') ||
    normalized.includes('FALSE')
  ) {
    return 'исключено вручную';
  }
  if (normalized.includes('NO_ACTIVE') || normalized.includes('USER_ID_REQUIRED')) {
    return 'нет активной записи';
  }
  if (
    /[А-Яа-яЁё]/.test(raw) &&
    !normalized.includes('СХЕМ') &&
    !normalized.includes('РАССЫЛ') &&
    !normalized.includes('БАН') &&
    !normalized.includes('ЖАЛОБ') &&
    !normalized.includes('РЕКЛАМ') &&
    !normalized.includes('ПОВТОР')
  ) {
    return raw;
  }
  return DIAGNOSTICS_SIGNAL_CATEGORIES[resolveSpammerSignalCategory(raw)].reasonLabel;
}

function readUserFacingName(value: string | null | undefined, userId: string | null | undefined) {
  const normalized = value?.trim() ?? '';
  if (!normalized) {
    return '';
  }

  const normalizedUserId = userId?.trim() ?? '';
  if (normalizedUserId && normalized === normalizedUserId) {
    return '';
  }

  return normalized;
}

function resolveSpammerCandidateName(candidate: GlobalSpammerReviewCandidate): string {
  return (
    readUserFacingName(candidate.displayName, candidate.userId) ||
    readUserFacingName(candidate.lastUserLabel, candidate.userId) ||
    formatUserReference()
  );
}

function formatUserReference(): string {
  return 'Пользователь';
}

function resolveSpammerCandidateInitial(candidate: GlobalSpammerReviewCandidate): string {
  const name = resolveSpammerCandidateName(candidate);
  const matched = name.match(/[A-Za-zА-Яа-яЁё0-9]/);
  return matched ? matched[0]!.toUpperCase() : 'S';
}

function resolveSpammerCandidateAvatarUrl(candidate: GlobalSpammerReviewCandidate): string | null {
  const normalized = candidate.avatarUrl?.trim() ?? '';
  return normalized || null;
}

function resolveSpammerDiagnosticsName(
  target: SpammerDiagnosticsTarget | null,
  diagnostics: GlobalSpammerUserDiagnostics | null,
): string {
  const userId = diagnostics?.userId ?? target?.userId ?? '';
  return (
    readUserFacingName(diagnostics?.displayName, userId) ||
    readUserFacingName(target?.displayName, userId) ||
    formatUserReference()
  );
}

function resolveSpammerDiagnosticsInitial(
  target: SpammerDiagnosticsTarget | null,
  diagnostics: GlobalSpammerUserDiagnostics | null,
): string {
  const matched = resolveSpammerDiagnosticsName(target, diagnostics).match(/[A-Za-zА-Яа-яЁё0-9]/);
  return matched ? matched[0]!.toUpperCase() : 'S';
}

function resolveSpammerDiagnosticsAvatarUrl(
  target: SpammerDiagnosticsTarget | null,
  diagnostics: GlobalSpammerUserDiagnostics | null,
): string | null {
  const normalized = diagnostics?.avatarUrl?.trim() || target?.avatarUrl?.trim() || '';
  return normalized || null;
}

function resolveSpammerDiagnosticsProfileUrl(
  target: SpammerDiagnosticsTarget | null,
  diagnostics: GlobalSpammerUserDiagnostics | null,
): string {
  return diagnostics?.profileUrl?.trim() || target?.profileUrl?.trim() || '';
}

function resolveSpammerDiagnosticsProfileHandoffUrl(
  target: SpammerDiagnosticsTarget | null,
  diagnostics: GlobalSpammerUserDiagnostics | null,
): string {
  return diagnostics?.profileHandoffUrl?.trim() || target?.profileHandoffUrl?.trim() || '';
}

function formatOptionalDate(value: string | null | undefined): string | null {
  return value ? formatViolationDate(value) : null;
}

function resolveDiagnosticsHeadline(diagnostics: GlobalSpammerUserDiagnostics): string {
  const status = diagnostics.policy.registryStatus;
  if (status === 'ACTIVE_CONFIRMED') {
    return 'В базе спама';
  }
  if (status === 'LOCAL_BLOCKED') {
    return 'Отмечен спамером';
  }
  if (status === 'MEDIUM_REVIEW') {
    return 'На проверке';
  }
  if (status === 'SUPPRESSED' || status === 'ADMIN_EXEMPT') {
    return 'Не учитывается в базе';
  }
  if (status === 'EXPIRED') {
    return 'Нет активной записи';
  }
  return 'Нет активной записи';
}

function resolveDiagnosticsAutoAction(diagnostics: GlobalSpammerUserDiagnostics): string {
  const { policy } = diagnostics;
  if (policy.registryStatus === 'ACTIVE_CONFIRMED' && !policy.deleteSpammersEnabled) {
    return 'Автобан выключен';
  }
  if (policy.registryStatus === 'LOCAL_BLOCKED') {
    return policy.action === 'NONE' ? 'Отметка сохранена' : 'Автобан при сообщении';
  }
  if (policy.action === 'DELETE_AND_KICK') {
    return 'Забанит в чате';
  }
  if (policy.action === 'SHADOW_DELETE_AND_KICK') {
    return 'Ждёт решения админа';
  }
  if (policy.registryStatus === 'ADMIN_EXEMPT') {
    return 'Не будет банить';
  }
  if (policy.registryStatus === 'SUPPRESSED') {
    return 'Не будет банить';
  }
  if (policy.registryStatus === 'MEDIUM_REVIEW') {
    return 'Ждёт решения админа';
  }
  if (policy.registryStatus === 'EXPIRED') {
    return 'Ничего не делает';
  }
  return 'Ничего не делает';
}

function normalizeDiagnosticsScore(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  return Math.max(0, Math.min(1, value));
}

function resolveDiagnosticsConfidenceScore(
  diagnostics: GlobalSpammerUserDiagnostics,
): number | null {
  return normalizeDiagnosticsScore(
    diagnostics.policy.confidenceScore ??
      diagnostics.registry.confidenceScore ??
      diagnostics.candidate?.confidenceScore ??
      diagnostics.policy.shadowScore ??
      null,
  );
}

function formatDiagnosticsScorePercent(score: number): string {
  return `${Math.round(score * 100)}%`;
}

function buildScoreMeterStyle(score: number): ScoreMeterStyle {
  return { '--spammer-score': `${Math.round(score * 100)}%` };
}

function resolveDiagnosticsVerdictTone(
  diagnostics: GlobalSpammerUserDiagnostics,
): 'danger' | 'warning' | 'success' | 'neutral' {
  const { policy } = diagnostics;
  if (policy.registryStatus === 'LOCAL_BLOCKED') {
    return policy.action === 'NONE' ? 'warning' : 'danger';
  }
  if (policy.registryStatus === 'ACTIVE_CONFIRMED' && !policy.deleteSpammersEnabled) {
    return 'warning';
  }
  if (policy.action === 'DELETE_AND_KICK') {
    return 'danger';
  }
  if (
    policy.registryStatus === 'ACTIVE_CONFIRMED' ||
    policy.registryStatus === 'MEDIUM_REVIEW' ||
    policy.action === 'SHADOW_DELETE_AND_KICK'
  ) {
    return 'warning';
  }
  if (policy.registryStatus === 'SUPPRESSED' || policy.registryStatus === 'ADMIN_EXEMPT') {
    return 'success';
  }
  return 'neutral';
}

type DiagnosticsSignalCategoryKey = 'fanout' | 'bans' | 'ads' | 'system';

const DIAGNOSTICS_SIGNAL_CATEGORIES: Record<
  DiagnosticsSignalCategoryKey,
  { label: string; reasonLabel: string }
> = {
  fanout: { label: 'Массовая рассылка', reasonLabel: 'массовая рассылка' },
  bans: { label: 'Баны в других чатах', reasonLabel: 'баны в других чатах' },
  ads: { label: 'Реклама и повторы', reasonLabel: 'реклама и повторы' },
  system: { label: 'Алгоритмы системы', reasonLabel: 'алгоритмы системы' },
};

function resolveSpammerSignalCategory(
  value: string | null | undefined,
  fallback: DiagnosticsSignalCategoryKey = 'system',
): DiagnosticsSignalCategoryKey {
  const normalized = value?.trim().toUpperCase() ?? '';
  if (!normalized) {
    return fallback;
  }

  if (
    normalized.includes('MANUAL_BAN') ||
    normalized.includes('SANCTION_BAN') ||
    normalized.includes('SANCTION_KICK') ||
    normalized.includes('LOCAL_ADMIN_BLOCK') ||
    normalized.includes('REVIEW_APPROVED') ||
    normalized.includes('БАН') ||
    normalized.includes('ЖАЛОБ')
  ) {
    return 'bans';
  }
  if (
    normalized.includes('COMMERCIAL') ||
    normalized.includes('REPEATED_LINK') ||
    normalized.includes('REPEATED_PHONE') ||
    normalized.includes('РЕКЛАМ') ||
    normalized.includes('ПОВТОР')
  ) {
    return 'ads';
  }
  if (
    normalized.includes('FANOUT') ||
    normalized.includes('GRAPH') ||
    normalized.includes('CAMPAIGN') ||
    normalized.includes('SCHEME') ||
    normalized.includes('СХЕМ') ||
    normalized.includes('РАССЫЛ')
  ) {
    return 'fanout';
  }
  if (normalized.includes('BAN') || normalized.includes('KICK')) {
    return 'bans';
  }
  if (
    normalized.includes('LINK') ||
    normalized.includes('PHONE') ||
    normalized.includes('URL') ||
    normalized.includes('DOMAIN')
  ) {
    return 'ads';
  }
  return fallback;
}

type DiagnosticsSignalGroup = {
  key: DiagnosticsSignalCategoryKey;
  label: string;
  userSignalCount: number;
  campaignUserSignalCount: number;
  maxScore: number;
};

function formatDisplaySentence(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }
  return `${trimmed.charAt(0).toLocaleUpperCase('ru-RU')}${trimmed.slice(1)}`;
}

function buildDiagnosticsSignalGroups(
  diagnostics: GlobalSpammerUserDiagnostics,
): DiagnosticsSignalGroup[] {
  const groups = new Map<DiagnosticsSignalCategoryKey, DiagnosticsSignalGroup>();
  const ensureGroup = (category: DiagnosticsSignalCategoryKey, score: number) => {
    const meta = DIAGNOSTICS_SIGNAL_CATEGORIES[category];
    const current = groups.get(category);
    if (current) {
      current.maxScore = Math.max(current.maxScore, score);
      return current;
    }
    const group: DiagnosticsSignalGroup = {
      key: category,
      label: meta.label,
      userSignalCount: 0,
      campaignUserSignalCount: 0,
      maxScore: score,
    };
    groups.set(category, group);
    return group;
  };
  const addUserSignal = (category: DiagnosticsSignalCategoryKey, score: number, count = 1) => {
    const group = ensureGroup(category, score);
    group.userSignalCount += Math.max(1, Math.trunc(count));
  };

  diagnostics.observations.forEach((item) => {
    addUserSignal(resolveSpammerSignalCategory(item.source), item.score);
  });
  diagnostics.graphSignals.forEach((item) => {
    addUserSignal(resolveSpammerSignalCategory(item.source), item.score);
  });
  diagnostics.campaigns.forEach((item) => {
    const category = resolveSpammerSignalCategory(item.signalType, 'fanout');
    const userObservationsCount = item.userObservationsCount;
    const hasUserCampaignSignals =
      typeof userObservationsCount === 'number' && userObservationsCount > 0;
    const group = hasUserCampaignSignals
      ? ensureGroup(category, item.confidenceScore)
      : groups.get(category);
    if (group) {
      group.maxScore = Math.max(group.maxScore, item.confidenceScore);
      if (hasUserCampaignSignals) {
        group.campaignUserSignalCount += Math.trunc(userObservationsCount);
      }
    }
  });

  if (diagnostics.reputationSummary.naturalBanSignals > 0 && !groups.has('bans')) {
    addUserSignal('bans', 0.34, diagnostics.reputationSummary.naturalBanSignals);
  }

  const signalGroups = [...groups.values()];
  signalGroups.forEach((group) => {
    if (group.campaignUserSignalCount > 0) {
      group.userSignalCount = Math.max(group.userSignalCount, group.campaignUserSignalCount);
    }
  });

  return signalGroups
    .filter((group) => group.userSignalCount > 0)
    .sort(
      (left, right) =>
        right.maxScore - left.maxScore || right.userSignalCount - left.userSignalCount,
    )
    .slice(0, 5);
}

function formatDiagnosticsSignalCount(count: number): string {
  return `${count} ${formatRussianCountLabel(count, 'сигнал', 'сигнала', 'сигналов')}`;
}

function resolveDiagnosticsActiveUntil(diagnostics: GlobalSpammerUserDiagnostics): string | null {
  if (diagnostics.activeSuppression?.suppressedUntil) {
    return formatOptionalDate(diagnostics.activeSuppression.suppressedUntil);
  }
  return formatOptionalDate(diagnostics.policy.expiresAt ?? diagnostics.registry.expiresAt);
}

function buildDiagnosticsFacts(
  diagnostics: GlobalSpammerUserDiagnostics,
): Array<{ label: string; value: string }> {
  const activeUntil = resolveDiagnosticsActiveUntil(diagnostics);
  const facts: Array<{ label: string; value: string }> = [];

  if (activeUntil) {
    facts.push({
      label:
        diagnostics.policy.registryStatus === 'SUPPRESSED' || diagnostics.activeSuppression
          ? 'Не учитывать в спам-базе до'
          : 'Действует до',
      value: activeUntil,
    });
  }
  if (diagnostics.localAdminDecision) {
    const decisionLabels: Record<string, string> = {
      ALLOW: 'Не спамер',
      BLOCK: 'Подтверждён в спам-базе',
      REVIEW: 'Отправить на проверку',
    };
    facts.push({
      label: 'Решение по спам-базе',
      value:
        decisionLabels[diagnostics.localAdminDecision.decision] ??
        'Локальное решение для этого чата',
    });
  }

  return facts;
}

function GlobalSpammerReviewPanel({
  candidates,
  isLoading,
  error,
  onOpen,
}: {
  candidates: GlobalSpammerReviewCandidate[];
  isLoading: boolean;
  error: unknown;
  onOpen: () => void;
}) {
  const errorMessage = error ? normalizeLoadErrorMessage(error) : null;
  const visibleCandidates = candidates.slice(0, 3);
  const hiddenCandidateCount = Math.max(0, candidates.length - visibleCandidates.length);
  const pendingLabel = `${candidates.length} ${formatRussianCountLabel(
    candidates.length,
    'кандидат',
    'кандидата',
    'кандидатов',
  )} на проверке`;
  const statusLabel = errorMessage ? 'Ошибка загрузки' : isLoading ? 'Обновляем' : pendingLabel;
  const shouldHide = !isLoading && !errorMessage && candidates.length === 0;
  if (shouldHide) {
    return null;
  }

  return (
    <section className="spammer-review" aria-label="Очередь базы спама">
      <button type="button" className="spammer-review__entry" onClick={onOpen}>
        <span className="spammer-review__mark" aria-hidden="true">
          !
        </span>

        <span className="spammer-review__copy">
          <span className="spammer-review__label">База спама</span>
          <strong>{statusLabel}</strong>
        </span>

        <span className="spammer-review__side" aria-hidden="true">
          {visibleCandidates.length > 0 ? (
            <span className="spammer-review__avatars">
              {visibleCandidates.map((candidate) => (
                <PersonAvatar
                  key={candidate.userId}
                  avatarUrl={resolveSpammerCandidateAvatarUrl(candidate)}
                  fallback={resolveSpammerCandidateInitial(candidate)}
                  className="spammer-review__avatar"
                />
              ))}
              {hiddenCandidateCount > 0 ? (
                <span className="spammer-review__avatar spammer-review__avatar--more">
                  +{hiddenCandidateCount}
                </span>
              ) : null}
            </span>
          ) : null}
          <span className="spammer-review__chevron">›</span>
        </span>
      </button>
    </section>
  );
}

function SpammerReviewSheet({
  open,
  candidates,
  isLoading,
  error,
  onClose,
  onRetry,
  onOpenDiagnostics,
}: {
  open: boolean;
  candidates: GlobalSpammerReviewCandidate[];
  isLoading: boolean;
  error: unknown;
  onClose: () => void;
  onRetry: () => void;
  onOpenDiagnostics: (candidate: GlobalSpammerReviewCandidate) => void;
}) {
  const errorMessage = error ? normalizeLoadErrorMessage(error) : null;
  const summary =
    candidates.length > 0
      ? `${candidates.length} ${formatRussianCountLabel(
          candidates.length,
          'кандидат',
          'кандидата',
          'кандидатов',
        )} на проверке`
      : undefined;

  return (
    <SettingsDrilldownPanel
      id="spammer-review-sheet"
      open={open}
      title="База спама"
      summary={summary}
      tone="rose"
      onClose={onClose}
      className="spammer-review-sheet"
    >
      {isLoading ? (
        <div className="spammer-review-sheet__state">
          <Spinner size="sm" label="Загружаем список" />
        </div>
      ) : errorMessage ? (
        <div className="spammer-review-sheet__state">
          <span>{errorMessage}</span>
          <button type="button" className="button button--ghost" onClick={onRetry}>
            Обновить
          </button>
        </div>
      ) : candidates.length === 0 ? (
        <div className="spammer-review-sheet__state">
          <span>На проверке никого нет</span>
        </div>
      ) : (
        <div className="spammer-review-sheet__list">
          {candidates.map((candidate) => {
            const label = resolveSpammerCandidateName(candidate);
            const reason = formatDisplaySentence(resolveSpammerReasonLabel(candidate.lastReason));
            const chatsCount = candidate.chats.length;
            const chatsLabel =
              chatsCount > 0
                ? `${chatsCount} ${formatRussianCountLabel(chatsCount, 'чат', 'чата', 'чатов')}`
                : null;

            return (
              <button
                key={candidate.userId}
                type="button"
                className="spammer-review-sheet__row"
                onClick={() => onOpenDiagnostics(candidate)}
              >
                <PersonAvatar
                  avatarUrl={resolveSpammerCandidateAvatarUrl(candidate)}
                  fallback={resolveSpammerCandidateInitial(candidate)}
                  className="spammer-review-sheet__avatar"
                />

                <span className="spammer-review-sheet__person">
                  <strong>{label}</strong>
                  <span>{[reason, chatsLabel].filter(Boolean).join(' · ')}</span>
                </span>

                <span className="spammer-review-sheet__chevron" aria-hidden="true">
                  ›
                </span>
              </button>
            );
          })}
        </div>
      )}
    </SettingsDrilldownPanel>
  );
}

function SpammerDiagnosticsSheet({
  open,
  target,
  diagnostics,
  isLoading,
  error,
  reviewingAction,
  isBanning,
  onClose,
  onRetry,
  onReview,
  onBan,
  onProfileActivate,
}: {
  open: boolean;
  target: SpammerDiagnosticsTarget | null;
  diagnostics: GlobalSpammerUserDiagnostics | null;
  isLoading: boolean;
  error: unknown;
  reviewingAction: GlobalSpammerReviewAction | null;
  isBanning: boolean;
  onClose: () => void;
  onRetry: () => void;
  onReview: (userId: string, action: GlobalSpammerReviewAction) => void;
  onBan: (userId: string) => void;
  onProfileActivate: (
    userId: string,
    displayName: string,
    profileHandoffUrl: string | null | undefined,
  ) => void;
}) {
  const errorMessage = error ? normalizeLoadErrorMessage(error) : null;
  const signalGroups = diagnostics ? buildDiagnosticsSignalGroups(diagnostics) : [];
  const facts = diagnostics ? buildDiagnosticsFacts(diagnostics) : [];
  const signalCount = signalGroups.reduce((sum, group) => sum + group.userSignalCount, 0);
  const confidenceScore = diagnostics ? resolveDiagnosticsConfidenceScore(diagnostics) : null;
  const confidencePercent = confidenceScore === null ? null : Math.round(confidenceScore * 100);
  const profileUserId = diagnostics?.userId.trim() || target?.userId.trim() || '';
  const profileDisplayName = resolveSpammerDiagnosticsName(target, diagnostics);
  const profileAvatarUrl = resolveSpammerDiagnosticsAvatarUrl(target, diagnostics);
  const profileUrl = resolveSpammerDiagnosticsProfileUrl(target, diagnostics);
  const profileHandoffUrl = resolveSpammerDiagnosticsProfileHandoffUrl(target, diagnostics);
  const profileHref = profileHandoffUrl || profileUrl || '#';
  const canOpenProfile = profileUserId.length > 0;
  const verdictTone = diagnostics ? resolveDiagnosticsVerdictTone(diagnostics) : 'neutral';
  const isReviewing = Boolean(reviewingAction);
  const isActionBusy = isReviewing || isBanning;
  const footer = diagnostics ? (
    <div className="spammer-diagnostics__footer">
      <div
        className="spammer-diagnostics__actions spammer-diagnostics__actions--registry"
        aria-label="Решение по базе спама"
      >
        <button
          type="button"
          className="spammer-diagnostics__action spammer-diagnostics__action--muted"
          disabled={isActionBusy}
          onClick={() => onReview(diagnostics.userId, 'SUPPRESS')}
          aria-label="Не учитывать пользователя в спам-базе, из чата не исключать"
        >
          <span>{reviewingAction === 'SUPPRESS' ? 'Сохраняем...' : 'Не добавлять в базу'}</span>
          {reviewingAction === 'SUPPRESS' ? null : <small>без действий в чате</small>}
        </button>
        <button
          type="button"
          className="spammer-diagnostics__action spammer-diagnostics__action--accent"
          disabled={isActionBusy}
          onClick={() => onReview(diagnostics.userId, 'APPROVE')}
          aria-label="Подтвердить пользователя как спамера в спам-базе"
        >
          <span>{reviewingAction === 'APPROVE' ? 'Сохраняем...' : 'Подтвердить в базе'}</span>
          {reviewingAction === 'APPROVE' ? null : <small>без бана сейчас</small>}
        </button>
      </div>
      <div
        className="spammer-diagnostics__actions spammer-diagnostics__actions--chat"
        aria-label="Действие в текущем чате"
      >
        <button
          type="button"
          className="spammer-diagnostics__action spammer-diagnostics__action--danger"
          disabled={isActionBusy}
          onClick={() => onBan(diagnostics.userId)}
          aria-label="Забанить пользователя в текущем чате сейчас"
        >
          <span>{isBanning ? 'Баним...' : 'Забанить в этом чате'}</span>
          {isBanning ? null : <small>применить сейчас</small>}
        </button>
      </div>
    </div>
  ) : undefined;

  return (
    <SettingsDrilldownPanel
      id="spammer-diagnostics-sheet"
      open={open}
      title="Досье спамера"
      summary=""
      tone="sky"
      onClose={onClose}
      className="spammer-diagnostics-sheet"
      overlayClassName="spammer-diagnostics-overlay"
      footer={footer}
      keepFooterVisibleWhenKeyboardOpen
    >
      {isLoading ? (
        <div className="spammer-diagnostics__state">
          <Spinner size="sm" label="Загружаем диагностику" />
        </div>
      ) : errorMessage ? (
        <div className="spammer-diagnostics__state">
          <span>{errorMessage}</span>
          <button type="button" className="button button--ghost" onClick={onRetry}>
            Обновить
          </button>
        </div>
      ) : diagnostics ? (
        <section className="spammer-diagnostics">
          <div className="spammer-diagnostics__profile">
            {canOpenProfile ? (
              <a
                href={profileHref}
                className="spammer-diagnostics__profile-avatar-link"
                aria-label={`Открыть профиль ${profileDisplayName} в MAX`}
                onClick={(event) =>
                  handleProfileLinkClick(event, () =>
                    onProfileActivate(profileUserId, profileDisplayName, profileHandoffUrl),
                  )
                }
              >
                <PersonAvatar
                  avatarUrl={profileAvatarUrl}
                  fallback={resolveSpammerDiagnosticsInitial(target, diagnostics)}
                  className="spammer-diagnostics__profile-avatar"
                />
              </a>
            ) : (
              <PersonAvatar
                avatarUrl={profileAvatarUrl}
                fallback={resolveSpammerDiagnosticsInitial(target, diagnostics)}
                className="spammer-diagnostics__profile-avatar"
              />
            )}

            <div className="spammer-diagnostics__profile-copy">
              {canOpenProfile ? (
                <a
                  href={profileHref}
                  className="spammer-diagnostics__profile-name"
                  onClick={(event) =>
                    handleProfileLinkClick(event, () =>
                      onProfileActivate(profileUserId, profileDisplayName, profileHandoffUrl),
                    )
                  }
                >
                  {profileDisplayName}
                </a>
              ) : (
                <strong>{profileDisplayName}</strong>
              )}
              {profileUserId ? <span>ID {profileUserId}</span> : null}
            </div>
          </div>

          <article
            className={`spammer-diagnostics__hero spammer-diagnostics__hero--${verdictTone}`}
          >
            <div className="spammer-diagnostics__hero-top">
              <span>Статус</span>
              <strong>{resolveDiagnosticsHeadline(diagnostics)}</strong>
            </div>

            <div className="spammer-diagnostics__hero-main">
              <div className="spammer-diagnostics__verdict-copy">
                <h4>{resolveDiagnosticsAutoAction(diagnostics)}</h4>
              </div>

              {confidenceScore !== null && confidencePercent !== null ? (
                <div
                  className="spammer-diagnostics__confidence"
                  role="progressbar"
                  aria-label="Уверенность"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={confidencePercent}
                  style={buildScoreMeterStyle(confidenceScore)}
                >
                  <span className="spammer-diagnostics__confidence-head">
                    <span>Уверенность</span>
                    <strong>{formatDiagnosticsScorePercent(confidenceScore)}</strong>
                  </span>
                  <span className="spammer-diagnostics__confidence-track" aria-hidden="true">
                    <span className="spammer-diagnostics__confidence-fill" />
                  </span>
                </div>
              ) : null}
            </div>
          </article>

          {facts.length > 0 ? (
            <dl className="spammer-diagnostics__facts" aria-label="Сводка по пользователю">
              {facts.map((item) => (
                <div key={`${item.label}:${item.value}`}>
                  <dt>{item.label}</dt>
                  <dd>{item.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}

          <section className="spammer-diagnostics__signals" aria-label="Сигналы по пользователю">
            <div className="spammer-diagnostics__section-head">
              <span>Сигналы</span>
              <strong>
                {signalCount > 0 ? formatDiagnosticsSignalCount(signalCount) : 'Сигналов нет'}
              </strong>
            </div>
            {signalGroups.length > 0 ? (
              <div className="spammer-diagnostics__signal-list">
                {signalGroups.map((group) => {
                  return (
                    <article key={group.key} className="spammer-diagnostics__signal-card">
                      <div className="spammer-diagnostics__signal-copy">
                        <strong>
                          {group.label}: {formatDiagnosticsSignalCount(group.userSignalCount)}
                        </strong>
                      </div>
                    </article>
                  );
                })}
              </div>
            ) : (
              <div className="spammer-diagnostics__empty">
                <strong>Пока нет сигналов</strong>
                <span>Можно внести пользователя вручную или закрыть досье.</span>
              </div>
            )}
          </section>
        </section>
      ) : null}
    </SettingsDrilldownPanel>
  );
}

function ViolationModerationControls({
  api,
  chatId,
  violation,
  onOpenDiagnostics,
  onApplied,
}: {
  api: ApiTransport;
  chatId: string;
  violation: ViolationItem;
  onOpenDiagnostics: () => void;
  onApplied: () => void;
}) {
  const releaseAction = resolveReleaseAction(violation);
  const [muteDurationHours, setMuteDurationHours] = useState(6);
  const [muteExpanded, setMuteExpanded] = useState(false);
  const [pendingAction, setPendingAction] = useState<Extract<
    ManualModerationAction,
    'BAN' | 'UNMUTE' | 'UNBAN'
  > | null>(null);
  const [status, setStatus] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const mutePresets = [1, 6, 24, 168];

  const applyMutation = useMutation({
    mutationFn: async (payload: ManualModerationActionRequest) =>
      applyManualModerationAction(api, chatId, violation.userId, payload),
    onSuccess: (result) => {
      setStatus({ tone: 'success', text: result.message });
      setMuteExpanded(false);
      setPendingAction(null);
      onApplied();
    },
    onError: (error: unknown) => {
      const message = normalizeActionErrorMessage(error);
      setStatus({ tone: 'danger', text: message });
    },
  });

  const applyAction = (action: ManualModerationAction, hours?: number) => {
    const normalizedHours =
      action === 'MUTE' ? clampMuteDurationHours(hours ?? muteDurationHours) : null;
    setStatus(null);
    if (action !== 'MUTE') {
      setPendingAction(null);
    }
    applyMutation.mutate({
      action,
      ...(action === 'MUTE' ? { muteDurationHours: normalizedHours ?? muteDurationHours } : {}),
    });
  };

  return (
    <section className="logs-violation-item__moderation" aria-label="Действия модератора">
      <div
        className={`logs-violation-item__quick-actions ${
          releaseAction ? 'logs-violation-item__quick-actions--single' : ''
        }`}
      >
        <button
          type="button"
          className="logs-violation-item__quick-button logs-violation-item__quick-button--neutral"
          disabled={applyMutation.isPending}
          onClick={() => {
            setStatus(null);
            setMuteExpanded(false);
            setPendingAction(null);
            onOpenDiagnostics();
          }}
        >
          База спама
        </button>
        {!releaseAction ? (
          <button
            type="button"
            className={`logs-violation-item__quick-button logs-violation-item__quick-button--warning ${
              muteExpanded ? 'is-active' : ''
            }`}
            disabled={applyMutation.isPending}
            onClick={() => {
              setStatus(null);
              setPendingAction(null);
              setMuteExpanded((current) => !current);
            }}
          >
            Мут
          </button>
        ) : null}
        {!releaseAction ? (
          <button
            type="button"
            className="logs-violation-item__quick-button logs-violation-item__quick-button--danger"
            disabled={applyMutation.isPending}
            onClick={() => {
              setStatus(null);
              setMuteExpanded(false);
              setPendingAction((current) => (current === 'BAN' ? null : 'BAN'));
            }}
          >
            Бан
          </button>
        ) : null}
        {releaseAction ? (
          <button
            type="button"
            className="logs-violation-item__quick-button logs-violation-item__quick-button--success"
            disabled={applyMutation.isPending}
            onClick={() => {
              setStatus(null);
              setMuteExpanded(false);
              setPendingAction((current) => (current === releaseAction ? null : releaseAction));
            }}
          >
            {resolveReleaseLabel(releaseAction)}
          </button>
        ) : null}
      </div>

      {!releaseAction && muteExpanded ? (
        <div className="logs-violation-item__ban-config">
          <div className="logs-violation-item__duration-summary">
            <div className="logs-violation-item__duration-label">
              <ClockIcon />
              <span>Срок мута</span>
            </div>
            <output className="logs-violation-item__duration-output" aria-live="polite">
              {formatMuteDurationCompact(muteDurationHours)}
            </output>
          </div>

          <div className="logs-violation-item__ban-presets">
            {mutePresets.map((hours) => (
              <button
                key={hours}
                type="button"
                className={`logs-violation-item__ban-preset ${
                  muteDurationHours === hours ? 'is-active' : ''
                }`}
                disabled={applyMutation.isPending}
                onClick={() => setMuteDurationHours(hours)}
              >
                {formatMuteDurationCompact(hours)}
              </button>
            ))}
          </div>

          <div className="logs-violation-item__ban-config-controls">
            <div className="ban-duration-stepper">
              <button
                type="button"
                className="ban-duration-stepper__button"
                onClick={() => setMuteDurationHours((prev) => clampMuteDurationHours(prev - 1))}
                disabled={applyMutation.isPending || muteDurationHours <= MUTE_DURATION_MIN_HOURS}
                aria-label="Уменьшить срок мута"
              >
                -
              </button>
              <div className="ban-duration-stepper__value">
                {formatMuteDurationCompact(muteDurationHours)}
              </div>
              <button
                type="button"
                className="ban-duration-stepper__button"
                onClick={() => setMuteDurationHours((prev) => clampMuteDurationHours(prev + 1))}
                disabled={applyMutation.isPending || muteDurationHours >= MUTE_DURATION_MAX_HOURS}
                aria-label="Увеличить срок мута"
              >
                +
              </button>
            </div>

            <label className="logs-violation-item__hours-input">
              <span>Часы</span>
              <input
                type="number"
                min={MUTE_DURATION_MIN_HOURS}
                max={MUTE_DURATION_MAX_HOURS}
                step={1}
                value={muteDurationHours}
                disabled={applyMutation.isPending}
                onChange={(event) =>
                  setMuteDurationHours(clampMuteDurationHours(Number(event.target.value)))
                }
              />
              <small>1–336ч</small>
            </label>
          </div>

          <button
            type="button"
            className="button button--accent logs-violation-item__apply-button"
            disabled={applyMutation.isPending}
            onClick={() => applyAction('MUTE', muteDurationHours)}
          >
            {applyMutation.isPending
              ? 'Применяем…'
              : resolveApplyActionLabel('MUTE', muteDurationHours)}
          </button>
        </div>
      ) : null}

      {pendingAction ? (
        <div className="logs-violation-item__ban-config">
          <p className="settings-native-toggle__hint settings-native-toggle__hint--inline">
            {resolveConfirmMessage(pendingAction, muteDurationHours, violation)}
          </p>
          <div className="logs-violation-item__confirm-actions">
            <button
              type="button"
              className="button button--ghost"
              disabled={applyMutation.isPending}
              onClick={() => setPendingAction(null)}
            >
              Отмена
            </button>
            <button
              type="button"
              className={`button ${pendingAction === 'BAN' ? 'button--danger' : 'button--accent'}`}
              disabled={applyMutation.isPending}
              onClick={() => applyAction(pendingAction)}
            >
              {applyMutation.isPending
                ? 'Применяем…'
                : resolveApplyActionLabel(pendingAction, muteDurationHours)}
            </button>
          </div>
        </div>
      ) : null}

      {status ? (
        <p className={`logs-violation-item__action-status is-${status.tone}`}>{status.text}</p>
      ) : null}
    </section>
  );
}

function formatViolationDate(value: string): string {
  return new Date(value).toLocaleString('ru-RU', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function getInitialSection(search: string): EventsSection {
  const value = new URLSearchParams(search).get('section');
  if (value === 'events' || value === 'activity') {
    return 'activity';
  }
  if (value === 'participants') {
    return 'participants';
  }

  return 'moderation';
}

function useDebouncedValue(value: string, delayMs: number): string {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setDebouncedValue(value);
    }, delayMs);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [delayMs, value]);

  return debouncedValue;
}

async function measureDashboardRequest<T>(label: string, task: () => Promise<T>): Promise<T> {
  if (typeof performance === 'undefined' || typeof performance.mark !== 'function') {
    return task();
  }

  const started = `events-dashboard:${label}:start`;
  const finished = `events-dashboard:${label}:end`;
  const measured = `events-dashboard:${label}`;
  performance.mark(started);
  try {
    return await task();
  } finally {
    performance.mark(finished);
    performance.measure(measured, started, finished);
    performance.clearMarks(started);
    performance.clearMarks(finished);
  }
}

export function EventsPage({ api }: { api: ApiTransport }) {
  const { chatId } = useParams();
  const location = useLocation();
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [range, setRange] = useState<LogsDashboardRange>('24h');
  const [section, setSection] = useState<EventsSection>(() => getInitialSection(location.search));
  const [eventsFilter, setEventsFilter] = useState<EventsFilter>('ALL');
  const [expandedViolationId, setExpandedViolationId] = useState<string | null>(null);
  const [spammerReviewOpen, setSpammerReviewOpen] = useState(false);
  const [selectedParticipantId, setSelectedParticipantId] = useState<string | null>(null);
  const [spammerDiagnosticsTarget, setSpammerDiagnosticsTarget] =
    useState<SpammerDiagnosticsTarget | null>(null);
  const [participantsSearch, setParticipantsSearch] = useState('');
  const [lastKnownParticipantsTotal, setLastKnownParticipantsTotal] = useState<{
    chatId: string | null;
    total: number;
  } | null>(null);
  const deferredParticipantsSearch = useDeferredValue(participantsSearch);
  const debouncedParticipantsSearch = useDebouncedValue(
    deferredParticipantsSearch.trim(),
    PARTICIPANTS_SEARCH_DEBOUNCE_MS,
  );

  const routeChatTitle = getRouteChatTitle(location.state);
  const routeChatAvatarUrl = getRouteChatAvatarUrl(location.state);
  const includeActivityPreview = section === 'activity';
  const includeModerationPreview = section === 'moderation';

  useEffect(() => {
    if (chatId) {
      saveLastEntityId('chat', chatId);
    }
  }, [chatId]);

  useEffect(() => {
    document.body.classList.add('events-page-open');

    return () => {
      document.body.classList.remove('events-page-open');
    };
  }, []);

  const dashboardQuery = useQuery({
    queryKey: queryKeys.logsDashboard(
      chatId ?? '',
      range,
      includeActivityPreview,
      includeModerationPreview,
    ),
    queryFn: ({ signal }) => {
      const targetChatId = chatId ?? '';
      if (section === 'activity') {
        return measureDashboardRequest('activity', () =>
          getChatActivityDashboard(api, targetChatId, range, { signal }),
        );
      }

      if (section === 'moderation') {
        return measureDashboardRequest('moderation', () =>
          getChatModerationDashboard(api, targetChatId, range, { signal }),
        );
      }

      return measureDashboardRequest('legacy', () =>
        getLogsDashboard(
          api,
          targetChatId,
          range,
          {
            includeActivityPreview,
            includeModerationPreview,
          },
          { signal },
        ),
      );
    },
    enabled: Boolean(chatId) && section !== 'participants',
    staleTime: 30_000,
    placeholderData: (previousData) => previousData,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (!chatId || section === 'participants') {
      return undefined;
    }

    let cancelled = false;
    void readStatsSnapshot<LogsDashboardResponse>('chat', [
      chatId,
      range,
      includeActivityPreview ? 'activity' : 'no-activity',
      includeModerationPreview ? 'moderation' : 'no-moderation',
    ]).then((snapshot) => {
      if (cancelled || !snapshot) {
        return;
      }

      const queryKey = queryKeys.logsDashboard(
        chatId,
        range,
        includeActivityPreview,
        includeModerationPreview,
      );
      if (!queryClient.getQueryData(queryKey)) {
        queryClient.setQueryData(queryKey, snapshot);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [chatId, includeActivityPreview, includeModerationPreview, queryClient, range, section]);

  useEffect(() => {
    if (!chatId || !dashboardQuery.data) {
      return;
    }

    saveStatsSnapshot(
      'chat',
      [
        chatId,
        range,
        includeActivityPreview ? 'activity' : 'no-activity',
        includeModerationPreview ? 'moderation' : 'no-moderation',
      ],
      dashboardQuery.data,
    );
  }, [chatId, dashboardQuery.data, includeActivityPreview, includeModerationPreview, range]);

  useEffect(() => {
    if (!chatId || section === 'participants' || !dashboardQuery.data) {
      return undefined;
    }

    const targetSection: Extract<EventsSection, 'activity' | 'moderation'> =
      section === 'moderation' ? 'activity' : 'moderation';
    const prefetch = () => {
      const isActivity = targetSection === 'activity';
      void queryClient
        .prefetchQuery({
          queryKey: queryKeys.logsDashboard(chatId, range, isActivity, !isActivity),
          queryFn: ({ signal }) =>
            isActivity
              ? getChatActivityDashboard(api, chatId, range, { signal })
              : getChatModerationDashboard(api, chatId, range, { signal }),
          staleTime: 30_000,
        })
        .catch(() => undefined);
    };

    if ('requestIdleCallback' in window && typeof window.requestIdleCallback === 'function') {
      const idleId = window.requestIdleCallback(prefetch, { timeout: 2_000 });
      return () => window.cancelIdleCallback?.(idleId);
    }

    const timeoutId = window.setTimeout(prefetch, IDLE_PREFETCH_DELAY_MS);
    return () => window.clearTimeout(timeoutId);
  }, [api, chatId, dashboardQuery.data, queryClient, range, section]);

  const chatTitle = useMemo(() => {
    if (!chatId) {
      return '';
    }

    if (routeChatTitle) {
      return routeChatTitle;
    }

    const fromStorage = readChatTitle(chatId);
    if (fromStorage) {
      return fromStorage;
    }

    const fromDashboard = dashboardQuery.data?.chat.title?.trim();
    if (fromDashboard) {
      return fromDashboard;
    }

    return 'Чат без названия';
  }, [chatId, dashboardQuery.data?.chat.title, routeChatTitle]);

  const chatAvatarUrl = useMemo(() => {
    if (!chatId) {
      return null;
    }

    if (routeChatAvatarUrl) {
      return routeChatAvatarUrl;
    }

    const fromDashboard = dashboardQuery.data?.chat.avatarUrl;
    if (typeof fromDashboard === 'string' && fromDashboard.trim()) {
      return fromDashboard.trim();
    }

    return null;
  }, [chatId, dashboardQuery.data?.chat.avatarUrl, routeChatAvatarUrl]);

  useEffect(() => {
    if (!chatId || !chatTitle) {
      return;
    }

    saveChatTitle(chatId, chatTitle);
  }, [chatId, chatTitle]);

  const dashboard = dashboardQuery.data ?? null;
  const isDashboardPending = dashboardQuery.isLoading && !dashboard;
  const hasBlockingDashboardError = Boolean(dashboardQuery.error) && !dashboard;
  const membershipSummary = dashboard?.membership ?? {
    joinedUsers: 0,
    leftUsers: 0,
    netUsers: 0,
  };
  const violationsSummary = dashboard?.violationsSummary ?? {
    warn: 0,
    deleteMessage: 0,
    mute: 0,
    ban: 0,
    unmute: 0,
    unban: 0,
    affectedUsers: 0,
    total: 0,
  };
  const activityFeed = useMembershipActivityFeed({
    enabled: Boolean(chatId) && section === 'activity',
    range,
    initialPage: includeActivityPreview ? (dashboard?.activityFeed ?? null) : null,
    loadPage: (query, request) => getChatActivityFeed(api, chatId ?? '', query, request),
  });
  const moderationFeed = useModerationFeed({
    enabled:
      Boolean(chatId) &&
      section === 'moderation' &&
      (!includeModerationPreview || Boolean(dashboard) || hasBlockingDashboardError),
    range,
    filter: eventsFilter,
    initialPage: includeModerationPreview ? (dashboard?.moderationFeed ?? null) : null,
    loadPage: (query, request) => getChatModerationFeed(api, chatId ?? '', query, request),
  });
  const spammerReviewQueueQuery = useQuery({
    queryKey: queryKeys.globalSpammerReviewQueue(chatId, 'PENDING', 20, 'local-profile'),
    queryFn: ({ signal }) =>
      getGlobalSpammerReviewQueue(
        api,
        chatId ?? '',
        {
          status: 'PENDING',
          limit: 20,
          includeProfiles: true,
          includeObservations: false,
          profileMode: 'local',
        },
        { signal },
      ),
    enabled: Boolean(chatId) && section === 'moderation',
    staleTime: 60_000,
    placeholderData: (previousData) => previousData,
    refetchOnWindowFocus: false,
  });
  const spammerDiagnosticsQuery = useQuery({
    queryKey: queryKeys.globalSpammerUserDiagnostics(
      chatId,
      spammerDiagnosticsTarget?.userId ?? null,
    ),
    queryFn: ({ signal }) =>
      getGlobalSpammerUserDiagnostics(
        api,
        chatId ?? '',
        spammerDiagnosticsTarget?.userId ?? '',
        {
          includeProfile: false,
        },
        {
          signal,
        },
      ),
    enabled: Boolean(chatId && spammerDiagnosticsTarget?.userId),
    staleTime: 20_000,
    refetchOnWindowFocus: false,
  });
  const participantsFeed = useChatParticipantsFeed({
    enabled: Boolean(chatId) && section === 'participants',
    range,
    search: debouncedParticipantsSearch,
    initialPage: null,
    loadPage: (query, request) => getChatParticipantsPage(api, chatId ?? '', query, request),
  });
  const fullParticipantsTotal = dashboard?.chat.participantsCount ?? participantsFeed.totalCount;

  useEffect(() => {
    if (typeof fullParticipantsTotal === 'number') {
      setLastKnownParticipantsTotal({ chatId: chatId ?? null, total: fullParticipantsTotal });
    }
  }, [chatId, fullParticipantsTotal]);
  const profileHandoffMutation = useMutation({
    mutationFn: ({ userId, displayName }: { userId: string; displayName: string }) =>
      handoffChatMemberProfile(api, chatId ?? '', userId, { displayName }),
    onSuccess: (result) => {
      if (!openMaxBotLinkAndClose(result.botUrl)) {
        pushToast({
          tone: 'danger',
          title: 'Не удалось открыть бота',
          description: 'Ссылка на профиль пустая.',
        });
      }
    },
    onError: (error: unknown) => {
      const description = normalizeLoadErrorMessage(error);
      pushToast({
        tone: 'danger',
        title: 'Не удалось открыть профиль',
        description,
      });
    },
  });
  const participantImmunityMutation = useMutation({
    mutationFn: ({
      userId,
      durationHours,
      dailyViolationLimit,
    }: {
      userId: string;
      durationHours: number;
      dailyViolationLimit: number;
    }) =>
      updateChatParticipantImmunity(api, chatId ?? '', userId, {
        enabled: true,
        durationHours,
        dailyViolationLimit,
      }),
    onSuccess: (result) => {
      setSelectedParticipantId(null);
      pushToast({
        tone: 'success',
        title: result.message,
      });
      void participantsFeed.retry();
    },
    onError: (error: unknown) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось сохранить',
        description: normalizeActionErrorMessage(error),
      });
    },
  });
  const participantImmunityClearMutation = useMutation({
    mutationFn: ({ userId }: { userId: string }) =>
      updateChatParticipantImmunity(api, chatId ?? '', userId, {
        enabled: false,
      }),
    onSuccess: (result) => {
      setSelectedParticipantId(null);
      pushToast({
        tone: 'success',
        title: result.message,
      });
      void participantsFeed.retry();
    },
    onError: (error: unknown) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось снять',
        description: normalizeActionErrorMessage(error),
      });
    },
  });
  const participantModerationMutation = useMutation({
    mutationFn: ({ userId, payload }: { userId: string; payload: ManualModerationActionRequest }) =>
      applyManualModerationAction(api, chatId ?? '', userId, payload),
    onSuccess: (result) => {
      setSelectedParticipantId(null);
      pushToast({
        tone: 'success',
        title: result.message,
      });
      void dashboardQuery.refetch();
      void participantsFeed.retry();
    },
    onError: (error: unknown) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось применить',
        description: normalizeActionErrorMessage(error),
      });
    },
  });
  const spammerDiagnosticsBanMutation = useMutation({
    mutationFn: ({ userId }: { userId: string }) =>
      applyManualModerationAction(api, chatId ?? '', userId, { action: 'BAN' }),
    onSuccess: (result) => {
      setSpammerDiagnosticsTarget(null);
      pushToast({
        tone: 'success',
        title: result.message,
      });
      void dashboardQuery.refetch();
      void moderationFeed.retry();
      void participantsFeed.retry();
      void queryClient.invalidateQueries({
        queryKey: queryKeys.globalSpammerUserDiagnostics(chatId, result.userId),
      });
    },
    onError: (error: unknown) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось забанить',
        description: normalizeActionErrorMessage(error),
      });
    },
  });
  const spammerReviewMutation = useMutation({
    mutationFn: ({
      userId,
      action,
      reason,
    }: {
      userId: string;
      action: GlobalSpammerReviewAction;
      reason?: string;
    }) =>
      reviewGlobalSpammerCandidate(api, chatId ?? '', userId, {
        action,
        ...(reason ? { reason } : {}),
      }),
    onSuccess: (result) => {
      if (spammerDiagnosticsTarget?.userId === result.userId) {
        setSpammerDiagnosticsTarget(null);
      }
      pushToast({
        tone: 'success',
        title:
          result.status === 'SUPPRESSED' ? 'Не учитывается в спам-базе' : 'Подтверждён в спам-базе',
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.globalSpammerReviewQueue(chatId),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.globalSpammerUserDiagnostics(chatId, result.userId),
      });
    },
    onError: (error: unknown) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось сохранить решение',
        description: normalizeActionErrorMessage(error),
      });
    },
  });
  const filterOptions = useMemo<
    Array<{ value: EventsFilter; label: string; count: number }>
  >(() => {
    if (!dashboard) {
      return [{ value: 'ALL', label: 'Все', count: 0 }];
    }

    const options: Array<{ value: EventsFilter; label: string; count: number }> = [
      { value: 'ALL', label: 'Все', count: violationsSummary.total },
      { value: 'WARN', label: 'Предупр.', count: violationsSummary.warn },
      {
        value: 'DELETE_MESSAGE',
        label: 'Удаления',
        count: violationsSummary.deleteMessage,
      },
      { value: 'MUTE', label: 'Муты', count: violationsSummary.mute },
      { value: 'BAN', label: 'Баны', count: violationsSummary.ban },
      { value: 'UNMUTE', label: 'Мут снят', count: violationsSummary.unmute },
      { value: 'UNBAN', label: 'Возвраты', count: violationsSummary.unban },
    ];

    return options.filter((option) => option.value === 'ALL' || option.count > 0);
  }, [dashboard]);

  useEffect(() => {
    if (!filterOptions.some((option) => option.value === eventsFilter)) {
      setEventsFilter('ALL');
    }
  }, [eventsFilter, filterOptions]);

  useEffect(() => {
    setExpandedViolationId(null);
    setSpammerReviewOpen(false);
  }, [eventsFilter, range, section]);

  useEffect(() => {
    if (section !== 'participants') {
      setSelectedParticipantId(null);
    }
  }, [section]);

  const selectedParticipant = useMemo(
    () =>
      selectedParticipantId
        ? (participantsFeed.items.find((item) => item.userId === selectedParticipantId) ?? null)
        : null,
    [participantsFeed.items, selectedParticipantId],
  );

  useEffect(() => {
    if (selectedParticipantId && participantsFeed.items.length > 0 && !selectedParticipant) {
      setSelectedParticipantId(null);
    }
  }, [participantsFeed.items.length, selectedParticipant, selectedParticipantId]);

  const selectedFilterCount = useMemo(
    () => filterOptions.find((option) => option.value === eventsFilter)?.count ?? 0,
    [eventsFilter, filterOptions],
  );
  const isModerationInitialLoading =
    moderationFeed.isReloading && moderationFeed.items.length === 0;
  const handleSectionChange = (nextSection: EventsSection) => {
    if (nextSection === section) {
      return;
    }

    startTransition(() => {
      setSection(nextSection);
    });
  };
  const handleRangeChange = (nextRange: LogsDashboardRange) => {
    if (nextRange === range) {
      return;
    }

    startTransition(() => {
      setRange(nextRange);
    });
  };
  const handleEventsFilterChange = (nextFilter: EventsFilter) => {
    if (nextFilter === eventsFilter) {
      return;
    }

    startTransition(() => {
      setEventsFilter(nextFilter);
    });
  };
  const handleSpammerDiagnosticsReview = (userId: string, action: GlobalSpammerReviewAction) => {
    const normalizedUserId = userId.trim();
    if (!normalizedUserId) {
      return;
    }

    spammerReviewMutation.mutate({
      userId: normalizedUserId,
      action,
    });
  };
  const handleSpammerDiagnosticsBan = (userId: string) => {
    const normalizedUserId = userId.trim();
    if (!normalizedUserId) {
      return;
    }

    spammerDiagnosticsBanMutation.mutate({
      userId: normalizedUserId,
    });
  };
  const handleSpammerReviewRetry = () => {
    void spammerReviewQueueQuery.refetch();
  };
  const openSpammerDiagnostics = (target: SpammerDiagnosticsTarget) => {
    if (!target.userId.trim()) {
      return;
    }
    setSpammerDiagnosticsTarget(target);
  };
  const handleSpammerCandidateDiagnostics = (candidate: GlobalSpammerReviewCandidate) => {
    setSpammerReviewOpen(false);
    openSpammerDiagnostics({
      userId: candidate.userId,
      displayName: resolveSpammerCandidateName(candidate),
      avatarUrl: candidate.avatarUrl ?? null,
      profileUrl: candidate.profileUrl ?? null,
      profileHandoffUrl: candidate.profileHandoffUrl ?? null,
    });
  };
  const handleActivityFilterChange = (nextFilter: Parameters<typeof activityFeed.setFilter>[0]) => {
    if (nextFilter === activityFeed.filter) {
      return;
    }

    startTransition(() => {
      activityFeed.setFilter(nextFilter);
    });
  };

  const hardMeasures = violationsSummary.mute + violationsSummary.ban;

  if (!chatId) {
    return (
      <GlassCard>
        <StatusState
          tone="warning"
          title="Чат не выбран"
          description="Выберите чат в разделе «Чаты»."
          action={
            <Link to={buildManagedEntitiesRoute('chat')} className="button button--accent">
              К списку чатов
            </Link>
          }
        />
      </GlassCard>
    );
  }

  const activityBalanceTone =
    membershipSummary.netUsers > 0
      ? 'success'
      : membershipSummary.netUsers < 0
        ? 'danger'
        : 'neutral';
  const activityMovementsTotal = membershipSummary.joinedUsers + membershipSummary.leftUsers;
  const joinedShare = activityMovementsTotal
    ? Math.round((membershipSummary.joinedUsers / activityMovementsTotal) * 100)
    : 50;
  const leftShare = activityMovementsTotal ? 100 - joinedShare : 50;
  const activityBalanceLabel =
    membershipSummary.netUsers > 0
      ? 'Рост участников'
      : membershipSummary.netUsers < 0
        ? 'Отток участников'
        : 'Баланс без изменений';
  const participantsTotal =
    fullParticipantsTotal ??
    (lastKnownParticipantsTotal?.chatId === (chatId ?? null)
      ? lastKnownParticipantsTotal.total
      : null);
  const participantsHeroMetric = {
    label: 'Сейчас в чате',
    value: typeof participantsTotal === 'number' ? String(participantsTotal) : null,
    tone: 'accent' as const,
  };
  const moderationHeroMetric = {
    label: 'Нарушения',
    value: String(violationsSummary.total),
    note: '',
    tone: 'accent' as const,
  };
  const moderationSecondaryMetrics = [
    {
      label: 'Затронуто',
      value: String(violationsSummary.affectedUsers),
      note: '',
      tone: 'neutral' as const,
    },
    {
      label: 'Муты и баны',
      value: String(hardMeasures),
      note: '',
      tone: hardMeasures > 0 ? ('danger' as const) : ('neutral' as const),
    },
  ];
  const dashboardTitle =
    section === 'activity' ? 'События' : section === 'participants' ? 'Участники' : 'Модерация';
  const dashboardSubtitle = '';
  const activateProfile = (
    userId: string,
    displayName: string,
    handoffUrl: string | null | undefined,
  ) => {
    const normalizedUserId = userId.trim();
    if (!normalizedUserId || !chatId) {
      return;
    }

    const normalizedDisplayName = displayName.trim() || 'Пользователь';
    const normalizedHandoffUrl = handoffUrl?.trim() ?? '';
    if (normalizedHandoffUrl) {
      handoffChatMemberProfileKeepalive(api, chatId, normalizedUserId, {
        displayName: normalizedDisplayName,
      });
      if (openMaxBotLinkAndClose(normalizedHandoffUrl)) {
        return;
      }
    }

    profileHandoffMutation.mutate({
      userId: normalizedUserId,
      displayName: normalizedDisplayName,
    });
  };
  const isAppbarBusy =
    dashboardQuery.isFetching ||
    (section === 'participants' &&
      (participantsFeed.isReloading || participantsFeed.isLoadingMore));

  return (
    <div className="events-screen page-enter">
      <section className={`events-stage events-stage--${section}`}>
        <header className="events-stage__appbar">
          <div className="events-stage__appbar-bar">
            <Link
              to={buildManagedEntitiesRoute('chat')}
              className="events-stage__back"
              aria-label="К списку чатов"
            >
              <BackChevronIcon />
            </Link>

            <div className="events-stage__appbar-identity">
              <EntityAvatar
                title={chatTitle}
                entityType="chat"
                avatarUrl={chatAvatarUrl}
                className="events-stage__entity-avatar"
              />
              <div className="events-stage__appbar-copy">
                <strong>{chatTitle}</strong>
                <span className="events-stage__appbar-label">{dashboardTitle}</span>
              </div>
            </div>

            <div className="events-stage__appbar-side">
              {isAppbarBusy ? (
                <span className="events-stage__pulse" aria-label="Обновляем" title="Обновляем" />
              ) : (
                <span
                  className="events-stage__pulse events-stage__pulse--idle"
                  aria-hidden="true"
                />
              )}
            </div>
          </div>
        </header>

        <div className="events-stage__panel stagger-in">
          <div className="events-primary-tabs" role="tablist" aria-label="Раздел статистики">
            <div className="events-primary-tabs__track">
              <button
                type="button"
                role="tab"
                aria-selected={section === 'moderation'}
                className={`events-primary-tab ${section === 'moderation' ? 'is-active' : ''}`}
                onClick={() => handleSectionChange('moderation')}
              >
                <span className="events-primary-tab__icon" aria-hidden="true">
                  <ModerationTabIcon />
                </span>
                <span className="events-primary-tab__label">Модерация</span>
              </button>

              <button
                type="button"
                role="tab"
                aria-selected={section === 'participants'}
                className={`events-primary-tab ${section === 'participants' ? 'is-active' : ''}`}
                onClick={() => handleSectionChange('participants')}
              >
                <span className="events-primary-tab__icon" aria-hidden="true">
                  <ParticipantsTabIcon />
                </span>
                <span className="events-primary-tab__label">Участники</span>
              </button>

              <button
                type="button"
                role="tab"
                aria-selected={section === 'activity'}
                className={`events-primary-tab ${section === 'activity' ? 'is-active' : ''}`}
                onClick={() => handleSectionChange('activity')}
              >
                <span className="events-primary-tab__icon" aria-hidden="true">
                  <ActivityTabIcon />
                </span>
                <span className="events-primary-tab__label">События</span>
              </button>
            </div>
          </div>

          <section
            className={`events-dashboard events-dashboard--${section}`}
            aria-label={
              section === 'activity'
                ? 'Сводка по событиям'
                : section === 'participants'
                  ? 'Сводка по участникам'
                  : 'Сводка по модерации'
            }
          >
            <div className="events-dashboard__head">
              <div className="events-dashboard__head-copy">
                <strong>{dashboardTitle}</strong>
                {dashboardSubtitle ? (
                  <span className="events-dashboard__eyebrow">{dashboardSubtitle}</span>
                ) : null}
              </div>

              {section !== 'participants' ? (
                <SegmentedControl
                  value={range}
                  options={periodOptions}
                  onChange={(next) => handleRangeChange(next as LogsDashboardRange)}
                  className="events-dashboard__range"
                />
              ) : null}
            </div>

            {section !== 'participants' && isDashboardPending ? (
              <EventsDashboardSkeleton section={section} />
            ) : section !== 'participants' && hasBlockingDashboardError ? (
              <GlassCard className="events-inline-state">
                <StatusState
                  tone="danger"
                  title="Не удалось загрузить статистику"
                  description={normalizeLoadErrorMessage(dashboardQuery.error)}
                  action={
                    <button
                      type="button"
                      className="button button--danger"
                      onClick={() => void dashboardQuery.refetch()}
                    >
                      Повторить
                    </button>
                  }
                />
              </GlassCard>
            ) : section === 'participants' ? (
              <div className="events-dashboard__body events-dashboard__body--participants">
                <article
                  className={`events-dashboard__hero events-dashboard__hero--${participantsHeroMetric.tone}`}
                >
                  <small>{participantsHeroMetric.label}</small>
                  <strong className="events-dashboard__hero-value">
                    {participantsHeroMetric.value ?? (
                      <span
                        className="events-dashboard__hero-spinner"
                        role="status"
                        aria-label="Загружаем количество участников"
                      />
                    )}
                  </strong>
                </article>
              </div>
            ) : section === 'activity' ? (
              <div className="events-dashboard__activity">
                <article
                  className={`events-dashboard__activity-balance events-dashboard__activity-balance--${activityBalanceTone}`}
                >
                  <small>Баланс</small>
                  <strong>{formatSignedCount(membershipSummary.netUsers)}</strong>
                  <span>{activityBalanceLabel}</span>
                </article>

                <div className="events-dashboard__activity-ledger">
                  <article className="events-dashboard__flow-card events-dashboard__flow-card--joined">
                    <small>Вошли</small>
                    <strong>{membershipSummary.joinedUsers}</strong>
                    <span>{joinedShare}% всего движения</span>
                  </article>

                  <article className="events-dashboard__flow-card events-dashboard__flow-card--left">
                    <small>Вышли</small>
                    <strong>{membershipSummary.leftUsers}</strong>
                    <span>{leftShare}% всего движения</span>
                  </article>

                  <div className="events-dashboard__flow-bar" aria-hidden="true">
                    <span style={{ width: `${joinedShare}%` }} />
                  </div>

                  <div className="events-dashboard__flow-meta">
                    <small>Вошли {joinedShare}%</small>
                    <small>Вышли {leftShare}%</small>
                  </div>
                </div>
              </div>
            ) : (
              <div className="events-dashboard__body events-dashboard__body--moderation">
                <article
                  className={`events-dashboard__hero events-dashboard__hero--${moderationHeroMetric.tone}`}
                >
                  <small>{moderationHeroMetric.label}</small>
                  <strong>{moderationHeroMetric.value}</strong>
                  {moderationHeroMetric.note ? <span>{moderationHeroMetric.note}</span> : null}
                </article>

                <div className="events-dashboard__stack">
                  {moderationSecondaryMetrics.map((item) => (
                    <article
                      key={item.label}
                      className={`events-dashboard__metric events-dashboard__metric--${item.tone}`}
                    >
                      <small>{item.label}</small>
                      <strong>{item.value}</strong>
                      {item.note ? <span>{item.note}</span> : null}
                    </article>
                  ))}
                </div>
              </div>
            )}
          </section>

          {section === 'moderation' && dashboard ? (
            <div className="events-screen__filters" role="tablist" aria-label="Фильтр модерации">
              {filterOptions.map((option) => {
                const active = option.value === eventsFilter;

                return (
                  <button
                    key={option.value}
                    type="button"
                    className={`events-filter-chip ${active ? 'is-active' : ''}`}
                    onClick={() => handleEventsFilterChange(option.value)}
                    role="tab"
                    aria-selected={active}
                  >
                    <span>{option.label}</span>
                    <small>{option.count}</small>
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
      </section>

      {section === 'activity' ? (
        <MembershipActivityFeed
          joinedLabel="чату"
          leftLabel="чат"
          variant="immersive"
          filter={activityFeed.filter}
          onFilterChange={handleActivityFilterChange}
          items={activityFeed.items}
          hasMore={activityFeed.hasMore}
          isReloading={activityFeed.isReloading}
          isLoadingMore={activityFeed.isLoadingMore}
          error={activityFeed.error}
          onLoadMore={() => void activityFeed.loadMore()}
          onRetry={() => void activityFeed.retry()}
          onProfileActivate={(item: MembershipActivityItem) =>
            activateProfile(item.userId, item.userDisplayName, item.profileHandoffUrl)
          }
        />
      ) : null}

      {section === 'participants' ? (
        <ChatParticipantsRoster
          items={participantsFeed.items}
          search={participantsSearch}
          hasMore={participantsFeed.hasMore}
          isReloading={participantsFeed.isReloading}
          isLoadingMore={participantsFeed.isLoadingMore}
          error={participantsFeed.error}
          onSearchChange={setParticipantsSearch}
          onLoadMore={() => void participantsFeed.loadMore()}
          onRetry={() => void participantsFeed.retry()}
          onParticipantActivate={(item: ChatParticipantItem) =>
            setSelectedParticipantId(item.userId)
          }
        />
      ) : null}

      {section === 'moderation' ? (
        <>
          <GlobalSpammerReviewPanel
            candidates={spammerReviewQueueQuery.data?.items ?? []}
            isLoading={spammerReviewQueueQuery.isLoading && !spammerReviewQueueQuery.data}
            error={spammerReviewQueueQuery.error}
            onOpen={() => setSpammerReviewOpen(true)}
          />

          {dashboardQuery.error && dashboard ? (
            <GlassCard className="events-inline-state">
              <StatusState
                tone="warning"
                title="Данные могли устареть"
                description={normalizeLoadErrorMessage(dashboardQuery.error)}
                action={
                  <button
                    type="button"
                    className="button button--ghost"
                    onClick={() => void dashboardQuery.refetch()}
                  >
                    Обновить
                  </button>
                }
              />
            </GlassCard>
          ) : null}

          {dashboard && violationsSummary.total === 0 ? (
            <GlassCard className="events-inline-state">
              <StatusState
                tone="neutral"
                title="Нарушений не найдено"
                description="За выбранный период действий модерации и ручных возвратов не было."
              />
            </GlassCard>
          ) : null}

          {dashboard && violationsSummary.total > 0 && selectedFilterCount === 0 ? (
            <GlassCard className="events-inline-state">
              <StatusState
                tone="neutral"
                title="По этому фильтру пусто"
                description="Попробуйте переключить тип события или расширить период."
              />
            </GlassCard>
          ) : null}

          {moderationFeed.error ? (
            <GlassCard className="events-inline-state">
              <StatusState
                tone="warning"
                title="Не удалось загрузить список"
                description={normalizeLoadErrorMessage(moderationFeed.error)}
                action={
                  <button
                    type="button"
                    className="button button--ghost"
                    onClick={() => void moderationFeed.retry()}
                  >
                    Повторить
                  </button>
                }
              />
            </GlassCard>
          ) : null}

          {isModerationInitialLoading ? (
            <GlassCard className="events-inline-state">
              <div className="events-loading-state">
                <Spinner size="lg" label="Загружаем список событий модерации" />
              </div>
            </GlassCard>
          ) : null}

          {moderationFeed.items.length > 0 ? (
            <>
              <section className="events-feed" aria-label="Список нарушений">
                {moderationFeed.items.map((violation) => {
                  const displayAction = resolveDisplayAction(violation);
                  const isExpanded = expandedViolationId === violation.id;
                  const displayName = resolveOffenderName(violation);
                  const avatarUrl = resolveOffenderAvatarUrl(violation);
                  const violationReason = resolveModerationFeedReason(violation);
                  const profileHandoffUrl = violation.profileHandoffUrl?.trim() ?? '';
                  const profileUrl = violation.profileUrl?.trim() ?? '';
                  const canOpenProfile = violation.userId.trim().length > 0;
                  const toggleExpanded = () =>
                    setExpandedViolationId((current) =>
                      current === violation.id ? null : violation.id,
                    );

                  return (
                    <article
                      key={violation.id}
                      className={`event-feed-item event-feed-item--${actionToneMap[displayAction]} ${
                        isExpanded ? 'is-expanded' : ''
                      }`}
                    >
                      <div
                        className="event-feed-item__trigger"
                        role="button"
                        tabIndex={0}
                        onClick={(event) => {
                          if ((event.target as HTMLElement | null)?.closest('a')) {
                            return;
                          }
                          toggleExpanded();
                        }}
                        onKeyDown={(event) => handleExpandableCardKeyDown(event, toggleExpanded)}
                        aria-expanded={isExpanded}
                      >
                        {canOpenProfile ? (
                          <a
                            href={profileHandoffUrl || profileUrl || '#'}
                            className="event-feed-item__avatar-link"
                            aria-label={`Открыть профиль ${displayName} в MAX`}
                            onClick={(event) =>
                              handleProfileLinkClick(event, () =>
                                activateProfile(violation.userId, displayName, profileHandoffUrl),
                              )
                            }
                          >
                            <PersonAvatar
                              avatarUrl={avatarUrl}
                              fallback={resolveOffenderInitial(displayName)}
                              className="event-feed-item__avatar"
                            />
                          </a>
                        ) : (
                          <PersonAvatar
                            avatarUrl={avatarUrl}
                            fallback={resolveOffenderInitial(displayName)}
                            className="event-feed-item__avatar"
                          />
                        )}

                        <div className="event-feed-item__body">
                          <div className="event-feed-item__headline">
                            <div className="event-feed-item__identity">
                              {canOpenProfile ? (
                                <a
                                  href={profileHandoffUrl || profileUrl || '#'}
                                  className="event-feed-item__name-link"
                                  onClick={(event) =>
                                    handleProfileLinkClick(event, () =>
                                      activateProfile(
                                        violation.userId,
                                        displayName,
                                        profileHandoffUrl,
                                      ),
                                    )
                                  }
                                >
                                  {displayName}
                                </a>
                              ) : (
                                <strong>{displayName}</strong>
                              )}
                              <div className="event-feed-item__stamp">
                                <span
                                  className={`event-feed-item__action event-feed-item__action--${actionToneMap[displayAction]}`}
                                >
                                  {actionLabelMap[displayAction]}
                                </span>
                                <time dateTime={violation.createdAt}>
                                  {formatViolationDate(violation.createdAt)}
                                </time>
                              </div>
                            </div>

                            <span className="event-feed-item__toggle" aria-hidden="true">
                              {isExpanded ? '−' : '+'}
                            </span>
                          </div>

                          <p className="event-feed-item__summary">
                            {violationReason || resolveViolationBlurb(violation)}
                          </p>
                        </div>
                      </div>

                      {isExpanded ? (
                        <div className="event-feed-item__details">
                          <div className="event-feed-item__reason">
                            <span>Причина</span>
                            <p>{violationReason || resolveViolationBlurb(violation)}</p>
                          </div>

                          {violation.maskedExcerpt ? (
                            <div className="event-feed-item__excerpt">
                              <span>Фрагмент сообщения</span>
                              <p>{violation.maskedExcerpt}</p>
                            </div>
                          ) : null}

                          <ViolationModerationControls
                            api={api}
                            chatId={chatId}
                            violation={violation}
                            onOpenDiagnostics={() =>
                              openSpammerDiagnostics({
                                userId: violation.userId,
                                displayName,
                                avatarUrl,
                                profileUrl,
                                profileHandoffUrl,
                              })
                            }
                            onApplied={() => {
                              void dashboardQuery.refetch();
                              void moderationFeed.retry();
                            }}
                          />
                        </div>
                      ) : null}
                    </article>
                  );
                })}
              </section>

              {moderationFeed.hasMore ? (
                <button
                  type="button"
                  className="button button--ghost membership-feed__load-more"
                  onClick={() => void moderationFeed.loadMore()}
                  disabled={moderationFeed.isLoadingMore || moderationFeed.isReloading}
                >
                  {moderationFeed.isLoadingMore ? 'Загружаем...' : 'Показать ещё'}
                </button>
              ) : null}
            </>
          ) : null}
        </>
      ) : null}

      <SpammerReviewSheet
        open={spammerReviewOpen}
        candidates={spammerReviewQueueQuery.data?.items ?? []}
        isLoading={spammerReviewQueueQuery.isLoading && !spammerReviewQueueQuery.data}
        error={spammerReviewQueueQuery.error}
        onClose={() => setSpammerReviewOpen(false)}
        onRetry={handleSpammerReviewRetry}
        onOpenDiagnostics={handleSpammerCandidateDiagnostics}
      />

      <SpammerDiagnosticsSheet
        open={Boolean(spammerDiagnosticsTarget)}
        target={spammerDiagnosticsTarget}
        diagnostics={spammerDiagnosticsQuery.data ?? null}
        isLoading={spammerDiagnosticsQuery.isLoading && !spammerDiagnosticsQuery.data}
        error={spammerDiagnosticsQuery.error}
        reviewingAction={
          spammerReviewMutation.isPending &&
          spammerReviewMutation.variables?.userId === spammerDiagnosticsTarget?.userId
            ? (spammerReviewMutation.variables.action ?? null)
            : null
        }
        isBanning={
          spammerDiagnosticsBanMutation.isPending &&
          spammerDiagnosticsBanMutation.variables?.userId === spammerDiagnosticsTarget?.userId
        }
        onClose={() => setSpammerDiagnosticsTarget(null)}
        onRetry={() => void spammerDiagnosticsQuery.refetch()}
        onReview={handleSpammerDiagnosticsReview}
        onBan={handleSpammerDiagnosticsBan}
        onProfileActivate={activateProfile}
      />

      <ChatParticipantSheet
        open={Boolean(selectedParticipant)}
        item={selectedParticipant}
        rangeLabel={periodOptions.find((option) => option.value === range)?.label ?? range}
        isSavingImmunity={
          participantImmunityMutation.isPending || participantImmunityClearMutation.isPending
        }
        isApplyingModeration={participantModerationMutation.isPending}
        onClose={() => setSelectedParticipantId(null)}
        onSaveImmunity={({ durationHours, dailyViolationLimit }) => {
          if (!selectedParticipant) {
            return;
          }

          participantImmunityMutation.mutate({
            userId: selectedParticipant.userId,
            durationHours,
            dailyViolationLimit,
          });
        }}
        onClearImmunity={() => {
          if (!selectedParticipant) {
            return;
          }

          participantImmunityClearMutation.mutate({
            userId: selectedParticipant.userId,
          });
        }}
        onProfileActivate={() => {
          if (!selectedParticipant) {
            return;
          }

          activateProfile(
            selectedParticipant.userId,
            selectedParticipant.userDisplayName,
            selectedParticipant.profileHandoffUrl,
          );
        }}
        onSpammerDiagnostics={() => {
          if (!selectedParticipant) {
            return;
          }

          openSpammerDiagnostics({
            userId: selectedParticipant.userId,
            displayName: selectedParticipant.userDisplayName || selectedParticipant.username || '',
            avatarUrl: selectedParticipant.avatarUrl,
            profileUrl: selectedParticipant.profileUrl,
            profileHandoffUrl: selectedParticipant.profileHandoffUrl,
          });
        }}
        onMute={(durationHours) => {
          if (!selectedParticipant) {
            return;
          }

          participantModerationMutation.mutate({
            userId: selectedParticipant.userId,
            payload: {
              action: 'MUTE',
              muteDurationHours: clampMuteDurationHours(durationHours),
            },
          });
        }}
        onBan={() => {
          if (!selectedParticipant) {
            return;
          }

          participantModerationMutation.mutate({
            userId: selectedParticipant.userId,
            payload: {
              action: 'BAN',
            },
          });
        }}
      />
    </div>
  );
}
