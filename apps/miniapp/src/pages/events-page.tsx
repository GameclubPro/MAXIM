import type {
  LogsDashboardRange,
  LogsDashboardViolation,
  ManualModerationAction,
  ManualModerationActionRequest,
  ChatParticipantItem,
  ModerationFeedFilter,
  MembershipActivityItem,
} from '@maxim/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import '../styles/lazy-pages.css';
import {
  startTransition,
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
import { Spinner } from '../components/ui/spinner';
import { StatusState } from '../components/ui/status-state';
import { useToast } from '../components/ui/toast';
import {
  applyManualModerationAction,
  getChatActivityFeed,
  getChatParticipantsPage,
  getChatModerationFeed,
  getLogsDashboard,
  handoffChatMemberProfile,
  handoffChatMemberProfileKeepalive,
  updateChatParticipantImmunity,
} from '../lib/api/events-client';
import type { ApiTransport } from '../lib/api/transport';
import { readChatTitle, saveChatTitle } from '../lib/chat-titles';
import { buildManagedEntitiesRoute, saveLastEntityId } from '../lib/last-chat';
import { openMaxBotLinkAndClose } from '../lib/max-bridge';
import { useChatParticipantsFeed } from '../lib/use-chat-participants-feed';
import { useMembershipActivityFeed } from '../lib/use-membership-activity-feed';
import { useModerationFeed } from '../lib/use-moderation-feed';

type ViolationItem = LogsDashboardViolation;
type DisplayAction = 'WARN' | 'DELETE_MESSAGE' | 'MUTE' | 'BAN' | 'UNMUTE' | 'UNBAN';
type EventsFilter = ModerationFeedFilter;
type EventsSection = 'activity' | 'moderation' | 'participants';

const MUTE_DURATION_MIN_HOURS = 1;
const MUTE_DURATION_MAX_HOURS = 336;

const actionLabelMap: Record<DisplayAction, string> = {
  DELETE_MESSAGE: 'Удаление',
  WARN: 'Предупреждение',
  MUTE: 'Мут',
  BAN: 'Бан',
  UNMUTE: 'Снять мут',
  UNBAN: 'Разбан',
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
    VIDEO_BLOCKED: 'Видео запрещено',
    FILE_BLOCKED: 'Файлы запрещены',
    VOICE_BLOCKED: 'Голосовые запрещены',
    PHOTO_RATE_LIMIT: 'Слишком много фото',
    DUPLICATE_WARN: 'Повторяющиеся сообщения',
    DUPLICATE_DELETE: 'Повторяющиеся сообщения',
    DUPLICATE_MUTE: 'Повторяющиеся сообщения',
    DUPLICATE_KICK: 'Повторяющиеся сообщения',
    DUPLICATE_BAN: 'Повторяющиеся сообщения',
    MANUAL_MUTE: 'Ручной мут',
    MANUAL_UNMUTE: 'Ручное снятие мута',
    MANUAL_KICK: 'Ручной бан',
    MANUAL_BAN: 'Ручной бан',
    MANUAL_UNBAN: 'Ручной разбан',
    THEMATIC_FILTER: 'Объявления по теме',
    GLOBAL_USER_BLACKLIST_KICK: 'Глобальный черный список',
    GLOBAL_CROSS_CHAT_SPAM: 'Кросс-чат спам',
    GLOBAL_CROSS_CHAT_SPAM_DELETE: 'Кросс-чат спам',
    GLOBAL_SPAMMER_BAN: 'Глобальная база спаммеров',
    GLOBAL_SPAMMER_KICK: 'Глобальная база спаммеров',
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

  return ruleCode.replaceAll('_', ' ').toLowerCase();
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
    return 'Модератор снял мут вручную';
  }

  if (violation.ruleCode === 'MANUAL_UNBAN') {
    return 'Модератор снял блокировку вручную';
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

    return muteDurationHours ? `Ручной мут на ${muteDurationHours}ч` : 'Модератор выдал ручной мут';
  }

  if (violation.ruleCode === 'MANUAL_KICK') {
    return 'Модератор выдал ручной бан';
  }

  if (violation.ruleCode === 'MANUAL_BAN') {
    return 'Модератор выдал ручной бан';
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
    return `Замьютить на ${formatMuteDurationCompact(muteDurationHours)}`;
  }

  if (action === 'UNMUTE') {
    return 'Снять мут';
  }

  if (action === 'UNBAN') {
    return 'Разбанить участника';
  }

  return 'Забанить';
}

function resolveConfirmMessage(
  action: ManualModerationAction,
  muteDurationHours: number,
  violation?: ViolationItem,
): string {
  if (action === 'MUTE') {
    return `Замьютить участника на ${muteDurationHours}ч? Новые сообщения будут удаляться до конца срока.`;
  }

  if (action === 'UNMUTE') {
    return 'Снять мут у участника?';
  }

  if (action === 'UNBAN') {
    if (violation && isBanActiveFromViolation(violation)) {
      return 'Снять бан и вернуть участника в чат?';
    }

    if (
      violation?.ruleCode === 'GLOBAL_SPAMMER_BAN' ||
      violation?.ruleCode === 'GLOBAL_SPAMMER_KICK'
    ) {
      return 'Вернуть участника в чат и снять удаление по базе спаммеров?';
    }

    return 'Вернуть участника в чат?';
  }

  return 'Забанить участника в чате MAX до ручного разбана?';
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
  return action === 'UNMUTE' ? 'Снять мут' : 'Разбан';
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

function ViolationModerationControls({
  api,
  chatId,
  violation,
  onApplied,
}: {
  api: ApiTransport;
  chatId: string;
  violation: ViolationItem;
  onApplied: () => void;
}) {
  const releaseAction = resolveReleaseAction(violation);
  const [muteDurationHours, setMuteDurationHours] = useState(6);
  const [muteExpanded, setMuteExpanded] = useState(false);
  const [pendingAction, setPendingAction] = useState<
    Extract<ManualModerationAction, 'BAN' | 'UNMUTE' | 'UNBAN'> | null
  >(null);
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
      <div className="logs-violation-item__quick-actions">
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
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 10,
              padding: '10px 12px',
              borderRadius: 14,
              border: '1px solid rgba(62, 96, 127, 0.18)',
            }}
          >
            <div
              style={{
                minWidth: 0,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                color: 'var(--text-primary)',
                fontSize: '0.82rem',
                fontWeight: 700,
              }}
            >
              <ClockIcon />
              <span>Срок мута</span>
            </div>
            <output
              aria-live="polite"
              style={{
                padding: 0,
                color: 'var(--text-primary)',
                fontSize: '0.82rem',
                fontWeight: 800,
              }}
            >
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
                aria-label="Уменьшить длительность мута"
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
                aria-label="Увеличить длительность мута"
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
          <p
            className="settings-native-toggle__hint settings-native-toggle__hint--inline"
            style={{ margin: 0 }}
          >
            {resolveConfirmMessage(pendingAction, muteDurationHours, violation)}
          </p>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-end',
              gap: 10,
              flexWrap: 'wrap',
              width: '100%',
            }}
          >
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
  if (value === 'activity' || value === 'participants') {
    return value;
  }

  return 'moderation';
}

export function EventsPage({ api }: { api: ApiTransport }) {
  const { chatId } = useParams();
  const location = useLocation();
  const { pushToast } = useToast();
  const [range, setRange] = useState<LogsDashboardRange>('24h');
  const [section, setSection] = useState<EventsSection>(() => getInitialSection(location.search));
  const [eventsFilter, setEventsFilter] = useState<EventsFilter>('ALL');
  const [expandedViolationId, setExpandedViolationId] = useState<string | null>(null);
  const [selectedParticipantId, setSelectedParticipantId] = useState<string | null>(null);
  const [participantsSearch, setParticipantsSearch] = useState('');
  const deferredParticipantsSearch = useDeferredValue(participantsSearch);

  const routeChatTitle = getRouteChatTitle(location.state);
  const routeChatAvatarUrl = getRouteChatAvatarUrl(location.state);

  useEffect(() => {
    if (chatId) {
      saveLastEntityId('chat', chatId);
    }
  }, [chatId]);

  const dashboardQuery = useQuery({
    queryKey: ['logs-dashboard', chatId, range],
    queryFn: ({ signal }) =>
      getLogsDashboard(
        api,
        chatId ?? '',
        range,
        {
          includeActivityPreview: false,
          includeModerationPreview: false,
        },
        { signal },
      ),
    enabled: Boolean(chatId),
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
  });

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
    initialPage: null,
    loadPage: (query, request) => getChatActivityFeed(api, chatId ?? '', query, request),
  });
  const moderationFeed = useModerationFeed({
    enabled: Boolean(chatId) && section === 'moderation',
    range,
    filter: eventsFilter,
    initialPage: null,
    loadPage: (query, request) => getChatModerationFeed(api, chatId ?? '', query, request),
  });
  const participantsFeed = useChatParticipantsFeed({
    enabled: Boolean(chatId) && section === 'participants',
    range,
    search: deferredParticipantsSearch,
    initialPage: null,
    loadPage: (query, request) => getChatParticipantsPage(api, chatId ?? '', query, request),
  });
  const profileHandoffMutation = useMutation({
    mutationFn: ({ userId, displayName }: { userId: string; displayName: string }) =>
      handoffChatMemberProfile(api, chatId ?? '', userId, { displayName }),
    onSuccess: (result) => {
      if (!openMaxBotLinkAndClose(result.botUrl)) {
        pushToast({
          tone: 'danger',
          title: 'Не удалось открыть бота',
          description: 'Ссылка на handoff вернулась пустой.',
        });
      }
    },
    onError: (error: unknown) => {
      const description = error instanceof Error ? error.message : 'Попробуйте ещё раз.';
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
      { value: 'UNMUTE', label: 'Снятия мута', count: violationsSummary.unmute },
      { value: 'UNBAN', label: 'Разбаны', count: violationsSummary.unban },
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
  const participantsTotal = participantsFeed.totalCount ?? participantsFeed.items.length;
  const participantsHeroMetric = {
    label: 'Сейчас в чате',
    value: String(participantsTotal),
    tone: 'accent' as const,
  };
  const moderationHeroMetric = {
    label: 'События',
    value: String(violationsSummary.total),
    note:
      violationsSummary.total > 0 ? 'Зафиксировано за период' : 'За период нарушений не найдено',
    tone: 'accent' as const,
  };
  const moderationSecondaryMetrics = [
    {
      label: 'Люди',
      value: String(violationsSummary.affectedUsers),
      note: 'Участников затронуто',
      tone: 'neutral' as const,
    },
    {
      label: 'Мут + бан',
      value: String(hardMeasures),
      note: 'Жёсткие меры',
      tone: hardMeasures > 0 ? ('danger' as const) : ('neutral' as const),
    },
  ];
  const dashboardTitle =
    section === 'activity'
      ? 'Входы и выходы'
      : section === 'participants'
        ? 'Участники'
        : 'Модерация';
  const dashboardSubtitle =
    section === 'activity'
      ? 'Баланс и движение участников'
      : section === 'participants'
        ? ''
        : 'Люди и меры за выбранный период';
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
                <strong>События</strong>
                <span className="events-stage__appbar-label">{chatTitle}</span>
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
          <div className="events-primary-tabs" role="tablist" aria-label="Раздел событий">
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
                <span className="events-primary-tab__label">Входы и выходы</span>
              </button>
            </div>
          </div>

          <section
            className={`events-dashboard events-dashboard--${section}`}
            aria-label={
              section === 'activity'
                ? 'Сводка по входам и выходам'
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
              <GlassCard className="events-inline-state">
                <div className="events-loading-state">
                  <Spinner
                    size="lg"
                    label={
                      section === 'activity'
                        ? 'Загружаем сводку по входам и выходам'
                        : 'Загружаем сводку по модерации'
                    }
                  />
                </div>
              </GlassCard>
            ) : section !== 'participants' && hasBlockingDashboardError ? (
              <GlassCard className="events-inline-state">
                <StatusState
                  tone="danger"
                  title="Не удалось загрузить статистику"
                  description={(dashboardQuery.error as Error).message}
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
                  <strong>{participantsHeroMetric.value}</strong>
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
                  <span>{moderationHeroMetric.note}</span>
                </article>

                <div className="events-dashboard__stack">
                  {moderationSecondaryMetrics.map((item) => (
                    <article
                      key={item.label}
                      className={`events-dashboard__metric events-dashboard__metric--${item.tone}`}
                    >
                      <small>{item.label}</small>
                      <strong>{item.value}</strong>
                      <span>{item.note}</span>
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
          {dashboardQuery.error && dashboard ? (
            <GlassCard className="events-inline-state">
              <StatusState
                tone="warning"
                title="Данные могли устареть"
                description={(dashboardQuery.error as Error).message}
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
                description="За выбранный период действий модерации и ручных разбанов не было."
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
                description={moderationFeed.error}
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
                            {resolveViolationBlurb(violation)}
                          </p>
                        </div>
                      </div>

                      {isExpanded ? (
                        <div className="event-feed-item__details">
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
