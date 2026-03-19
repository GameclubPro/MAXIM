import type {
  LogsDashboardRange,
  LogsDashboardResponse,
  ManualModerationAction,
  ManualModerationActionRequest,
  MembershipActivityPage,
  SpammerCandidate,
  SpammerCandidateDecision,
} from '@maxim/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { MembershipActivityFeed } from '../components/dashboard/membership-activity-feed';
import { BackChevronIcon } from '../components/ui/entity-header-icons';
import { GlassCard } from '../components/ui/glass-card';
import { SegmentedControl } from '../components/ui/segmented-control';
import { SkeletonCard } from '../components/ui/skeleton';
import { StatusState } from '../components/ui/status-state';
import {
  applyManualModerationAction,
  getChatActivityFeed,
  getLogsDashboard,
  getSpammerCandidates,
  reviewSpammerCandidates,
} from '../lib/api/events-client';
import { getChats } from '../lib/api/root-client';
import type { ApiTransport } from '../lib/api/transport';
import { readChatTitle, saveChatTitle } from '../lib/chat-titles';
import { buildManagedEntitiesRoute, saveLastEntityId } from '../lib/last-chat';
import { useAutoHideHeader } from '../lib/use-auto-hide-header';
import { useMembershipActivityFeed } from '../lib/use-membership-activity-feed';

type ViolationAction = LogsDashboardResponse['violations'][number]['action'];
type ViolationItem = LogsDashboardResponse['violations'][number];
type CandidateItem = SpammerCandidate;
type DisplayAction = Exclude<ViolationAction, 'NONE'> | 'UNBAN';
type EventsFilter = 'ALL' | DisplayAction;
type EventsSection = 'activity' | 'moderation' | 'candidates';
type CandidateReviewStatus = { tone: 'success' | 'danger'; text: string } | null;

const BAN_DURATION_MIN_HOURS = 1;
const BAN_DURATION_MAX_HOURS = 336;

const actionLabelMap: Record<DisplayAction, string> = {
  DELETE_MESSAGE: 'Удаление',
  WARN: 'Предупреждение',
  KICK: 'Исключение',
  BAN: 'Бан',
  UNBAN: 'Разбан',
};

const actionToneMap: Record<DisplayAction, 'neutral' | 'warning' | 'danger' | 'success'> = {
  WARN: 'warning',
  DELETE_MESSAGE: 'neutral',
  KICK: 'danger',
  BAN: 'danger',
  UNBAN: 'success',
};

const periodOptions: Array<{ value: LogsDashboardRange; label: string }> = [
  { value: '24h', label: '24ч' },
  { value: '7d', label: '7д' },
  { value: '30d', label: '30д' },
];

const EMPTY_ACTIVITY_PAGE: MembershipActivityPage = {
  items: [],
  hasMore: false,
  nextCursor: null,
};

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

function CandidatesTabIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden focusable="false">
      <path
        d="M4 5.2h12"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M4 10h12"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M4 14.8h7.6"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="m13.8 14.2 1.3 1.3 2.3-2.7"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
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
    DUPLICATE_KICK: 'Повторяющиеся сообщения',
    DUPLICATE_BAN: 'Повторяющиеся сообщения',
    MANUAL_KICK: 'Ручное удаление',
    MANUAL_BAN: 'Ручной бан',
    MANUAL_UNBAN: 'Ручной разбан',
    THEMATIC_FILTER: 'Объявления по теме',
    GLOBAL_USER_BLACKLIST_KICK: 'Глобальный черный список',
    GLOBAL_CROSS_CHAT_SPAM: 'Кросс-чат спам',
    GLOBAL_CROSS_CHAT_SPAM_DELETE: 'Кросс-чат спам',
    GLOBAL_SPAMMER_KICK: 'Глобальная база спаммеров',
    GLOBAL_SPAMMER_CANDIDATE_DELETE: 'Кандидат на удаление',
    BAN_ACTIVE_DELETE: 'Активный бан',
    NIGHT_MODE_DELETE: 'Ночной режим',
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

function isManualUnban(violation: ViolationItem): boolean {
  return violation.ruleCode === 'MANUAL_UNBAN';
}

function resolveDisplayAction(violation: ViolationItem): DisplayAction {
  if (isManualUnban(violation)) {
    return 'UNBAN';
  }

  return violation.action === 'NONE' ? 'DELETE_MESSAGE' : violation.action;
}

function resolveViolationBlurb(violation: LogsDashboardResponse['violations'][number]): string {
  if (violation.ruleCode === 'MANUAL_UNBAN') {
    return 'Модератор снял блокировку вручную';
  }

  if (violation.ruleCode === 'MANUAL_KICK') {
    return 'Модератор удалил участника вручную';
  }

  if (violation.ruleCode === 'MANUAL_BAN') {
    const metadata =
      violation.metadata &&
      typeof violation.metadata === 'object' &&
      !Array.isArray(violation.metadata)
        ? violation.metadata
        : null;
    const banDurationHours =
      metadata &&
      typeof metadata.banDurationHours === 'number' &&
      Number.isFinite(metadata.banDurationHours)
        ? metadata.banDurationHours
        : null;

    return banDurationHours ? `Ручной бан на ${banDurationHours}ч` : 'Модератор выдал ручной бан';
  }

  return formatViolationRule(violation.ruleCode);
}

function formatSignedCount(value: number): string {
  if (value > 0) {
    return `+${value}`;
  }

  return String(value);
}

function clampBanDurationHours(value: number): number {
  const normalized = Number.isFinite(value) ? Math.trunc(value) : BAN_DURATION_MIN_HOURS;
  return Math.max(BAN_DURATION_MIN_HOURS, Math.min(BAN_DURATION_MAX_HOURS, normalized));
}

function resolveApplyActionLabel(action: ManualModerationAction, banDurationHours: number): string {
  if (action === 'KICK') {
    return 'Удалить участника';
  }

  if (action === 'UNBAN') {
    return 'Разбанить участника';
  }

  return `Забанить на ${banDurationHours}ч`;
}

function resolveConfirmMessage(action: ManualModerationAction, banDurationHours: number): string {
  if (action === 'KICK') {
    return 'Удалить участника из чата?';
  }

  if (action === 'UNBAN') {
    return 'Снять бан и вернуть участника в чат?';
  }

  return `Забанить участника на ${banDurationHours}ч с авторазбаном?`;
}

function isBanActiveFromViolation(violation: ViolationItem): boolean {
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

  if (readFutureIso('banExpiresAt') || readFutureIso('unbanScheduledAt')) {
    return true;
  }

  if (violation.action !== 'BAN') {
    return false;
  }

  const createdAtMs = new Date(violation.createdAt).getTime();
  if (!Number.isFinite(createdAtMs)) {
    return false;
  }

  const banDurationHours =
    metadata && 'banDurationHours' in metadata && typeof metadata.banDurationHours === 'number'
      ? metadata.banDurationHours
      : null;
  if (banDurationHours === null || !Number.isFinite(banDurationHours) || banDurationHours <= 0) {
    return false;
  }

  return createdAtMs + banDurationHours * 60 * 60 * 1000 > now;
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

function pluralize(value: number, one: string, few: string, many: string): string {
  const mod10 = value % 10;
  const mod100 = value % 100;

  if (mod10 === 1 && mod100 !== 11) {
    return one;
  }

  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return few;
  }

  return many;
}

function formatChatsCount(value: number): string {
  return `${value} ${pluralize(value, 'чат', 'чата', 'чатов')}`;
}

function formatDetectionsCount(value: number): string {
  return `${value} ${pluralize(value, 'сигнал', 'сигнала', 'сигналов')}`;
}

function formatCandidateReason(reason: string): string {
  const labels: Record<string, string> = {
    HIGH_FANOUT_5_CHATS_2M: 'Массовая рассылка по чатам за 2 минуты',
    HIGH_FANOUT_4_CHATS_WARN_THRESHOLD: 'Повторный кросс-чат спам после предупреждений',
    PENDING_REVIEW_ACTIVITY: 'Новая активность во время ожидания согласования',
  };

  return labels[reason] ?? reason.replaceAll('_', ' ').toLowerCase();
}

function resolveCandidateName(candidate: CandidateItem): string {
  const fromPayload = candidate.userDisplayName?.trim();
  if (fromPayload) {
    return fromPayload;
  }

  return `Пользователь ${candidate.userId}`;
}

function resolveCandidatePrimaryChat(candidate: CandidateItem, chatId: string) {
  return (
    candidate.visibleChats.find((item) => item.chatId === chatId) ??
    candidate.visibleChats[0] ??
    null
  );
}

function buildCandidateConfirmMessage(decision: SpammerCandidateDecision, count: number): string {
  if (decision === 'APPROVE') {
    return count === 1
      ? 'Добавить кандидата в глобальную базу спаммеров и кикнуть из доступных чатов?'
      : `Добавить в глобальную базу спаммеров и кикнуть ${count} кандидатов из доступных чатов?`;
  }

  return count === 1
    ? 'Оставить кандидата и скрыть его из очереди на 30 дней?'
    : `Оставить ${count} кандидатов и скрыть их из очереди на 30 дней?`;
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
  const canUnban = isBanActiveFromViolation(violation);
  const [banDurationHours, setBanDurationHours] = useState(6);
  const [banExpanded, setBanExpanded] = useState(false);
  const [status, setStatus] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const banPresets = [1, 6, 24, 168];

  const applyMutation = useMutation({
    mutationFn: async (payload: ManualModerationActionRequest) =>
      applyManualModerationAction(api, chatId, violation.userId, payload),
    onSuccess: (result) => {
      setStatus({ tone: 'success', text: result.message });
      setBanExpanded(false);
      onApplied();
    },
    onError: (error: unknown) => {
      const message = normalizeActionErrorMessage(error);
      setStatus({ tone: 'danger', text: message });
    },
  });

  const confirmAndApply = (action: ManualModerationAction, hours?: number) => {
    const normalizedHours =
      action === 'BAN' ? clampBanDurationHours(hours ?? banDurationHours) : null;
    const confirmed = window.confirm(
      resolveConfirmMessage(action, normalizedHours ?? banDurationHours),
    );
    if (!confirmed) {
      return;
    }

    setStatus(null);
    applyMutation.mutate({
      action,
      ...(action === 'BAN' ? { banDurationHours: normalizedHours ?? banDurationHours } : {}),
    });
  };

  return (
    <section className="logs-violation-item__moderation" aria-label="Действия модератора">
      <div className="logs-violation-item__quick-actions">
        <button
          type="button"
          className="logs-violation-item__quick-button logs-violation-item__quick-button--danger"
          disabled={applyMutation.isPending}
          onClick={() => confirmAndApply('KICK')}
        >
          Кик
        </button>
        {!canUnban ? (
          <button
            type="button"
            className={`logs-violation-item__quick-button logs-violation-item__quick-button--warning ${
              banExpanded ? 'is-active' : ''
            }`}
            disabled={applyMutation.isPending}
            onClick={() => {
              setStatus(null);
              setBanExpanded((current) => !current);
            }}
          >
            Бан
          </button>
        ) : null}
        {canUnban ? (
          <button
            type="button"
            className="logs-violation-item__quick-button logs-violation-item__quick-button--success"
            disabled={applyMutation.isPending}
            onClick={() => confirmAndApply('UNBAN')}
          >
            Разбан
          </button>
        ) : null}
      </div>

      {!canUnban && banExpanded ? (
        <div className="logs-violation-item__ban-config">
          <small className="logs-violation-item__ban-caption">Срок бана</small>
          <div className="logs-violation-item__ban-presets">
            {banPresets.map((hours) => (
              <button
                key={hours}
                type="button"
                className={`logs-violation-item__ban-preset ${
                  banDurationHours === hours ? 'is-active' : ''
                }`}
                disabled={applyMutation.isPending}
                onClick={() => setBanDurationHours(hours)}
              >
                {hours >= 24 && hours % 24 === 0 ? `${hours / 24}д` : `${hours}ч`}
              </button>
            ))}
          </div>

          <div className="logs-violation-item__ban-config-controls">
            <div className="ban-duration-stepper">
              <button
                type="button"
                className="ban-duration-stepper__button"
                onClick={() => setBanDurationHours((prev) => clampBanDurationHours(prev - 1))}
                disabled={applyMutation.isPending || banDurationHours <= BAN_DURATION_MIN_HOURS}
                aria-label="Уменьшить длительность бана"
              >
                -
              </button>
              <div className="ban-duration-stepper__value">{banDurationHours}ч</div>
              <button
                type="button"
                className="ban-duration-stepper__button"
                onClick={() => setBanDurationHours((prev) => clampBanDurationHours(prev + 1))}
                disabled={applyMutation.isPending || banDurationHours >= BAN_DURATION_MAX_HOURS}
                aria-label="Увеличить длительность бана"
              >
                +
              </button>
            </div>

            <label className="logs-violation-item__hours-input">
              <input
                type="number"
                min={BAN_DURATION_MIN_HOURS}
                max={BAN_DURATION_MAX_HOURS}
                step={1}
                value={banDurationHours}
                disabled={applyMutation.isPending}
                onChange={(event) =>
                  setBanDurationHours(clampBanDurationHours(Number(event.target.value)))
                }
              />
              <small>1–336ч</small>
            </label>
          </div>

          <button
            type="button"
            className="button button--accent logs-violation-item__apply-button"
            disabled={applyMutation.isPending}
            onClick={() => confirmAndApply('BAN', banDurationHours)}
          >
            {applyMutation.isPending
              ? 'Применяем…'
              : resolveApplyActionLabel('BAN', banDurationHours)}
          </button>
        </div>
      ) : null}

      {status ? (
        <p className={`logs-violation-item__action-status is-${status.tone}`}>{status.text}</p>
      ) : null}
    </section>
  );
}

function SpammerCandidateCard({
  candidate,
  chatId,
  isExpanded,
  isSelected,
  isBusy,
  onToggleExpand,
  onToggleSelect,
  onApplyDecision,
}: {
  candidate: CandidateItem;
  chatId: string;
  isExpanded: boolean;
  isSelected: boolean;
  isBusy: boolean;
  onToggleExpand: (userId: string) => void;
  onToggleSelect: (userId: string) => void;
  onApplyDecision: (decision: SpammerCandidateDecision, userIds: string[]) => void;
}) {
  const displayName = resolveCandidateName(candidate);
  const primaryChat = resolveCandidatePrimaryChat(candidate, chatId);

  return (
    <article className={`candidate-review-card ${isExpanded ? 'is-expanded' : ''} stagger-in`}>
      <div className="candidate-review-card__shell">
        <button
          type="button"
          role="checkbox"
          aria-checked={isSelected}
          className="candidate-review-card__select"
          disabled={isBusy}
          onClick={(event) => {
            event.stopPropagation();
            onToggleSelect(candidate.userId);
          }}
          aria-label={`Выбрать ${displayName}`}
        >
          <span
            className={`candidate-review-card__select-indicator ${isSelected ? 'is-selected' : ''}`}
            aria-hidden="true"
          />
        </button>

        <button
          type="button"
          className="candidate-review-card__trigger"
          onClick={() => onToggleExpand(candidate.userId)}
          disabled={isBusy}
          aria-expanded={isExpanded}
        >
          <span className="candidate-review-card__avatar">
            {resolveOffenderInitial(displayName)}
          </span>

          <div className="candidate-review-card__body">
            <div className="candidate-review-card__headline">
              <div className="candidate-review-card__identity">
                <strong>{displayName}</strong>
                <span>{candidate.userId}</span>
              </div>

              <span className="candidate-review-card__toggle" aria-hidden="true">
                {isExpanded ? '−' : '+'}
              </span>
            </div>

            <div className="candidate-review-card__meta">
              <span className="candidate-review-card__pill candidate-review-card__pill--danger">
                {formatChatsCount(candidate.totalAffectedChats)}
              </span>
              <span className="candidate-review-card__pill">
                {formatDetectionsCount(candidate.detectionsCount)}
              </span>
              <time dateTime={candidate.lastDetectedAt}>
                {formatViolationDate(candidate.lastDetectedAt)}
              </time>
            </div>

            <p className="candidate-review-card__summary">
              {formatCandidateReason(candidate.lastReason)}
            </p>
          </div>
        </button>
      </div>

      {isExpanded ? (
        <div className="candidate-review-card__details">
          {primaryChat?.excerpt || candidate.excerpt ? (
            <div className="candidate-review-card__excerpt">
              <span>Последний фрагмент</span>
              <p>{primaryChat?.excerpt ?? candidate.excerpt}</p>
            </div>
          ) : null}

          {candidate.visibleChats.length > 0 ? (
            <div className="candidate-review-card__visible">
              <span className="candidate-review-card__visible-title">Затронутые чаты</span>
              <div className="candidate-review-card__visible-list">
                {candidate.visibleChats.map((item) => (
                  <div key={item.chatId} className="candidate-review-card__visible-chip">
                    <strong>{item.title}</strong>
                    <span>{formatDetectionsCount(item.detectionsCount)}</span>
                    <small>{formatViolationDate(item.lastDetectedAt)}</small>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <div className="candidate-review-card__actions">
            <button
              type="button"
              className="button button--danger"
              disabled={isBusy}
              onClick={() => onApplyDecision('APPROVE', [candidate.userId])}
            >
              Удалить
            </button>
            <button
              type="button"
              className="button button--ghost"
              disabled={isBusy}
              onClick={() => onApplyDecision('REJECT', [candidate.userId])}
            >
              Оставить
            </button>
          </div>
        </div>
      ) : null}
    </article>
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
  if (value === 'activity') {
    return 'activity';
  }

  if (value === 'candidates') {
    return 'candidates';
  }

  return 'moderation';
}

export function EventsPage({ api }: { api: ApiTransport }) {
  const { chatId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [range, setRange] = useState<LogsDashboardRange>('7d');
  const [section, setSection] = useState<EventsSection>(() => getInitialSection(location.search));
  const [eventsFilter, setEventsFilter] = useState<EventsFilter>('ALL');
  const [expandedViolationId, setExpandedViolationId] = useState<string | null>(null);
  const [expandedCandidateId, setExpandedCandidateId] = useState<string | null>(null);
  const [selectedCandidateIds, setSelectedCandidateIds] = useState<string[]>([]);
  const [candidateStatus, setCandidateStatus] = useState<CandidateReviewStatus>(null);
  const { isCompact: isHeaderCompact, isHidden: isHeaderHidden } = useAutoHideHeader();

  const routeChatTitle = getRouteChatTitle(location.state);

  useEffect(() => {
    if (chatId) {
      saveLastEntityId('chat', chatId);
    }
  }, [chatId]);

  const chatsQuery = useQuery({
    queryKey: ['chats'],
    queryFn: () => getChats(api),
    enabled: Boolean(chatId),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  const dashboardQuery = useQuery({
    queryKey: ['logs-dashboard', chatId, range],
    queryFn: () => getLogsDashboard(api, chatId ?? '', range),
    enabled: Boolean(chatId),
    refetchInterval: () => (document.hidden ? false : 10_000),
    refetchOnWindowFocus: true,
  });
  const candidatesQuery = useQuery({
    queryKey: ['spammer-candidates', chatId],
    queryFn: () => getSpammerCandidates(api, chatId ?? ''),
    enabled: Boolean(chatId) && section === 'candidates',
    refetchInterval: () => (section === 'candidates' && !document.hidden ? 10_000 : false),
    refetchOnWindowFocus: section === 'candidates',
  });
  const reviewCandidatesMutation = useMutation({
    mutationFn: (payload: { decision: SpammerCandidateDecision; userIds: string[] }) =>
      reviewSpammerCandidates(api, chatId ?? '', payload),
    onSuccess: (result, variables) => {
      setCandidateStatus({ tone: 'success', text: result.message });
      setSelectedCandidateIds((current) =>
        current.filter((item) => !variables.userIds.includes(item)),
      );
      setExpandedCandidateId((current) =>
        current && variables.userIds.includes(current) ? null : current,
      );
      void queryClient.invalidateQueries({ queryKey: ['spammer-candidates', chatId] });
      void queryClient.invalidateQueries({ queryKey: ['logs-dashboard', chatId] });
    },
    onError: (error: unknown) => {
      setCandidateStatus({ tone: 'danger', text: normalizeActionErrorMessage(error) });
    },
  });

  const chatTitle = useMemo(() => {
    if (!chatId) {
      return '';
    }

    const fromList = chatsQuery.data?.find((chat) => chat.id === chatId)?.title?.trim();
    if (fromList) {
      return fromList;
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
  }, [chatId, chatsQuery.data, dashboardQuery.data?.chat.title, routeChatTitle]);

  useEffect(() => {
    if (!chatId || !chatTitle) {
      return;
    }

    saveChatTitle(chatId, chatTitle);
  }, [chatId, chatTitle]);

  const dashboard = dashboardQuery.data ?? null;
  const candidates = candidatesQuery.data?.items ?? [];
  const activityFeed = useMembershipActivityFeed({
    range,
    initialPage: dashboard?.activityFeed ?? EMPTY_ACTIVITY_PAGE,
    loadPage: (query) => getChatActivityFeed(api, chatId ?? '', query),
  });
  const filterOptions = useMemo<
    Array<{ value: EventsFilter; label: string; count: number }>
  >(() => {
    if (!dashboard) {
      return [{ value: 'ALL', label: 'Все', count: 0 }];
    }

    const options: Array<{ value: EventsFilter; label: string; count: number }> = [
      { value: 'ALL', label: 'Все', count: dashboard.violationsSummary.total },
      { value: 'WARN', label: 'Предупр.', count: dashboard.violationsSummary.warn },
      {
        value: 'DELETE_MESSAGE',
        label: 'Удаления',
        count: dashboard.violationsSummary.deleteMessage,
      },
      { value: 'KICK', label: 'Кики', count: dashboard.violationsSummary.kick },
      { value: 'BAN', label: 'Баны', count: dashboard.violationsSummary.ban },
      { value: 'UNBAN', label: 'Разбаны', count: dashboard.violationsSummary.unban },
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
    setExpandedCandidateId(null);
    if (section !== 'candidates') {
      setCandidateStatus(null);
    }
  }, [eventsFilter, range, section]);

  useEffect(() => {
    const availableIds = new Set(candidates.map((item) => item.userId));
    setSelectedCandidateIds((current) => current.filter((item) => availableIds.has(item)));
    setExpandedCandidateId((current) => (current && availableIds.has(current) ? current : null));
  }, [candidates]);

  const filteredViolations = useMemo(() => {
    if (!dashboard) {
      return [];
    }

    if (eventsFilter === 'ALL') {
      return dashboard.violations;
    }

    return dashboard.violations.filter(
      (violation) => resolveDisplayAction(violation) === eventsFilter,
    );
  }, [dashboard, eventsFilter]);

  const hardMeasures = dashboard
    ? dashboard.violationsSummary.kick + dashboard.violationsSummary.ban
    : 0;
  const moderationViolations = dashboard?.violations ?? [];
  const selectedCandidateCount = selectedCandidateIds.length;
  const visibleCandidateChatCount = useMemo(
    () =>
      new Set(candidates.flatMap((candidate) => candidate.visibleChats.map((item) => item.chatId)))
        .size,
    [candidates],
  );

  const toggleCandidateSelection = (userId: string) => {
    setCandidateStatus(null);
    setSelectedCandidateIds((current) =>
      current.includes(userId) ? current.filter((item) => item !== userId) : [...current, userId],
    );
  };

  const handleCandidateDecision = (decision: SpammerCandidateDecision, userIds: string[]) => {
    const normalizedUserIds = Array.from(new Set(userIds));
    if (!chatId || normalizedUserIds.length === 0 || reviewCandidatesMutation.isPending) {
      return;
    }

    const confirmed = window.confirm(
      buildCandidateConfirmMessage(decision, normalizedUserIds.length),
    );
    if (!confirmed) {
      return;
    }

    setCandidateStatus(null);
    reviewCandidatesMutation.mutate({
      decision,
      userIds: normalizedUserIds,
    });
  };

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

  if (section !== 'candidates' && dashboardQuery.isLoading && !dashboard) {
    return (
      <div className="page-stack page-enter">
        <GlassCard className="settings-section">
          <SkeletonCard lines={14} />
        </GlassCard>
      </div>
    );
  }

  if (section !== 'candidates' && dashboardQuery.error && !dashboard) {
    return (
      <GlassCard>
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
    );
  }

  if (section !== 'candidates' && !dashboard) {
    return null;
  }

  const membership = dashboard?.membership ?? { joinedUsers: 0, leftUsers: 0, netUsers: 0 };
  const violationsSummary = dashboard?.violationsSummary ?? {
    warn: 0,
    deleteMessage: 0,
    kick: 0,
    ban: 0,
    unban: 0,
    affectedUsers: 0,
    total: 0,
  };
  const activityBalanceTone =
    membership.netUsers > 0 ? 'success' : membership.netUsers < 0 ? 'danger' : 'neutral';
  const activityMovementsTotal = membership.joinedUsers + membership.leftUsers;
  const joinedShare = activityMovementsTotal
    ? Math.round((membership.joinedUsers / activityMovementsTotal) * 100)
    : 50;
  const leftShare = activityMovementsTotal ? 100 - joinedShare : 50;
  const activityBalanceLabel =
    membership.netUsers > 0
      ? 'Рост участников'
      : membership.netUsers < 0
        ? 'Отток участников'
        : 'Баланс без изменений';
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
      label: 'Кик + бан',
      value: String(hardMeasures),
      note: 'Жёсткие меры',
      tone: hardMeasures > 0 ? ('danger' as const) : ('neutral' as const),
    },
  ];
  const candidateHeroMetric = {
    label: 'В очереди',
    value: String(candidates.length),
    note: candidates.length > 0 ? 'Ждут согласования админа' : 'Очередь сейчас пустая',
    tone: candidates.length > 0 ? ('warning' as const) : ('accent' as const),
  };
  const candidateSecondaryMetrics = [
    {
      label: 'Чаты',
      value: String(visibleCandidateChatCount),
      note: visibleCandidateChatCount > 0 ? 'Доступны вам' : 'Пока нет совпадений',
      tone: visibleCandidateChatCount > 0 ? ('accent' as const) : ('neutral' as const),
    },
    {
      label: 'Выбрано',
      value: String(selectedCandidateCount),
      note: selectedCandidateCount > 0 ? 'Готово к пакетному решению' : 'Можно выбрать несколько',
      tone: selectedCandidateCount > 0 ? ('warning' as const) : ('neutral' as const),
    },
  ];
  const dashboardTitle =
    section === 'activity'
      ? 'Входы и выходы'
      : section === 'candidates'
        ? 'Кандидаты на удаление'
        : 'Модерация';
  const dashboardSubtitle =
    section === 'activity'
      ? 'Баланс и движение участников'
      : section === 'candidates'
        ? 'Сначала согласование, потом глобальный бан'
        : 'Люди и меры за выбранный период';
  const isActiveSectionFetching =
    section === 'candidates' ? candidatesQuery.isFetching : dashboardQuery.isFetching;
  return (
    <div className="events-screen page-enter">
      <section className={`events-stage events-stage--${section}`}>
        <header
          className={`events-stage__appbar ${isHeaderCompact ? 'is-compact' : ''} ${
            isHeaderHidden ? 'is-hidden' : ''
          }`}
        >
          <div className="events-stage__appbar-bar">
            <button
              type="button"
              className="events-stage__back"
              aria-label="К списку чатов"
              onClick={() => navigate(buildManagedEntitiesRoute('chat'))}
            >
              <BackChevronIcon />
            </button>

            <div className="events-stage__appbar-copy">
              <strong>События</strong>
              <span className="events-stage__appbar-label">{chatTitle}</span>
            </div>

            <div className="events-stage__appbar-side">
              {isActiveSectionFetching ? (
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
                onClick={() => setSection('moderation')}
              >
                <span className="events-primary-tab__icon" aria-hidden="true">
                  <ModerationTabIcon />
                </span>
                <span className="events-primary-tab__label">Модерация</span>
              </button>

              <button
                type="button"
                role="tab"
                aria-selected={section === 'activity'}
                className={`events-primary-tab ${section === 'activity' ? 'is-active' : ''}`}
                onClick={() => setSection('activity')}
              >
                <span className="events-primary-tab__icon" aria-hidden="true">
                  <ActivityTabIcon />
                </span>
                <span className="events-primary-tab__label">Входы и выходы</span>
              </button>

              <button
                type="button"
                role="tab"
                aria-selected={section === 'candidates'}
                className={`events-primary-tab ${section === 'candidates' ? 'is-active' : ''}`}
                onClick={() => setSection('candidates')}
              >
                <span className="events-primary-tab__icon" aria-hidden="true">
                  <CandidatesTabIcon />
                </span>
                <span className="events-primary-tab__label">Кандидаты</span>
              </button>
            </div>
          </div>

          <section
            className={`events-dashboard events-dashboard--${section}`}
            aria-label={
              section === 'activity'
                ? 'Сводка по входам и выходам'
                : section === 'candidates'
                  ? 'Очередь кандидатов'
                  : 'Сводка по модерации'
            }
          >
            <div className="events-dashboard__head">
              <div className="events-dashboard__head-copy">
                <strong>{dashboardTitle}</strong>
                <span className="events-dashboard__eyebrow">{dashboardSubtitle}</span>
              </div>

              {section === 'candidates' ? (
                <span className="events-dashboard__live-pill">На согласовании</span>
              ) : (
                <SegmentedControl
                  value={range}
                  options={periodOptions}
                  onChange={(next) => setRange(next as LogsDashboardRange)}
                  className="events-dashboard__range"
                />
              )}
            </div>

            {section === 'activity' ? (
              <div className="events-dashboard__activity">
                <article
                  className={`events-dashboard__activity-balance events-dashboard__activity-balance--${activityBalanceTone}`}
                >
                  <small>Баланс</small>
                  <strong>{formatSignedCount(membership.netUsers)}</strong>
                  <span>{activityBalanceLabel}</span>
                </article>

                <div className="events-dashboard__activity-ledger">
                  <article className="events-dashboard__flow-card events-dashboard__flow-card--joined">
                    <small>Вошли</small>
                    <strong>{membership.joinedUsers}</strong>
                    <span>{joinedShare}% всего движения</span>
                  </article>

                  <article className="events-dashboard__flow-card events-dashboard__flow-card--left">
                    <small>Вышли</small>
                    <strong>{membership.leftUsers}</strong>
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
            ) : section === 'candidates' ? (
              <div className="events-dashboard__body events-dashboard__body--moderation">
                <article
                  className={`events-dashboard__hero events-dashboard__hero--${candidateHeroMetric.tone}`}
                >
                  <small>{candidateHeroMetric.label}</small>
                  <strong>{candidateHeroMetric.value}</strong>
                  <span>{candidateHeroMetric.note}</span>
                </article>

                <div className="events-dashboard__stack">
                  {candidateSecondaryMetrics.map((item) => (
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

          {section === 'moderation' ? (
            <div className="events-screen__filters" role="tablist" aria-label="Фильтр модерации">
              {filterOptions.map((option) => {
                const active = option.value === eventsFilter;

                return (
                  <button
                    key={option.value}
                    type="button"
                    className={`events-filter-chip ${active ? 'is-active' : ''}`}
                    onClick={() => setEventsFilter(option.value)}
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
          onFilterChange={activityFeed.setFilter}
          items={activityFeed.items}
          hasMore={activityFeed.hasMore}
          isReloading={activityFeed.isReloading}
          isLoadingMore={activityFeed.isLoadingMore}
          error={activityFeed.error}
          onLoadMore={() => void activityFeed.loadMore()}
          onRetry={() => void activityFeed.retry()}
        />
      ) : null}

      {section === 'candidates' ? (
        <>
          {candidateStatus ? (
            <GlassCard className="events-inline-state">
              <p className={`logs-violation-item__action-status is-${candidateStatus.tone}`}>
                {candidateStatus.text}
              </p>
            </GlassCard>
          ) : null}

          {candidatesQuery.isLoading && !candidatesQuery.data ? (
            <GlassCard className="events-inline-state">
              <SkeletonCard lines={10} />
            </GlassCard>
          ) : null}

          {candidatesQuery.error ? (
            <GlassCard className="events-inline-state">
              <StatusState
                tone="warning"
                title="Не удалось загрузить очередь"
                description={(candidatesQuery.error as Error).message}
                action={
                  <button
                    type="button"
                    className="button button--ghost"
                    onClick={() => void candidatesQuery.refetch()}
                  >
                    Обновить
                  </button>
                }
              />
            </GlassCard>
          ) : null}

          {!candidatesQuery.error && !candidatesQuery.isLoading && candidates.length === 0 ? (
            <GlassCard className="events-inline-state">
              <StatusState
                tone="neutral"
                title="Очередь пуста"
                description="Когда бот заметит межчатовый спам, кандидаты появятся здесь для согласования."
              />
            </GlassCard>
          ) : null}

          {candidates.length > 0 ? (
            <>
              <section className="candidate-review-batch" aria-label="Пакетные действия">
                <div className="candidate-review-batch__copy">
                  <strong>
                    {selectedCandidateCount > 0
                      ? `Выбрано ${selectedCandidateCount}`
                      : 'Выберите кандидатов'}
                  </strong>
                  <span>
                    {selectedCandidateCount > 0
                      ? 'Их можно решить одним действием.'
                      : 'Отметьте несколько карточек для массовой обработки.'}
                  </span>
                </div>

                <div className="candidate-review-batch__actions">
                  <button
                    type="button"
                    className="button button--danger"
                    disabled={selectedCandidateCount === 0 || reviewCandidatesMutation.isPending}
                    onClick={() => handleCandidateDecision('APPROVE', selectedCandidateIds)}
                  >
                    {reviewCandidatesMutation.isPending ? 'Применяем…' : 'Удалить'}
                  </button>

                  <button
                    type="button"
                    className="button button--ghost"
                    disabled={selectedCandidateCount === 0 || reviewCandidatesMutation.isPending}
                    onClick={() => handleCandidateDecision('REJECT', selectedCandidateIds)}
                  >
                    Оставить
                  </button>
                </div>
              </section>

              <section className="candidate-review-board" aria-label="Кандидаты на удаление">
                {candidates.map((candidate) => (
                  <SpammerCandidateCard
                    key={candidate.userId}
                    candidate={candidate}
                    chatId={chatId}
                    isExpanded={expandedCandidateId === candidate.userId}
                    isSelected={selectedCandidateIds.includes(candidate.userId)}
                    isBusy={reviewCandidatesMutation.isPending}
                    onToggleExpand={(userId) =>
                      setExpandedCandidateId((current) => (current === userId ? null : userId))
                    }
                    onToggleSelect={toggleCandidateSelection}
                    onApplyDecision={handleCandidateDecision}
                  />
                ))}
              </section>
            </>
          ) : null}
        </>
      ) : null}

      {section === 'moderation' ? (
        <>
          {dashboardQuery.error ? (
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

          {moderationViolations.length === 0 ? (
            <GlassCard className="events-inline-state">
              <StatusState
                tone="neutral"
                title="Нарушений не найдено"
                description="За выбранный период действий модерации и ручных разбанов не было."
              />
            </GlassCard>
          ) : null}

          {moderationViolations.length > 0 && filteredViolations.length === 0 ? (
            <GlassCard className="events-inline-state">
              <StatusState
                tone="neutral"
                title="По этому фильтру пусто"
                description="Попробуйте переключить тип события или расширить период."
              />
            </GlassCard>
          ) : null}

          {filteredViolations.length > 0 ? (
            <section className="events-feed" aria-label="Список нарушений">
              {filteredViolations.map((violation, index) => {
                const displayAction = resolveDisplayAction(violation);
                const isExpanded = expandedViolationId === violation.id;

                return (
                  <article
                    key={violation.id}
                    className={`event-feed-item event-feed-item--${actionToneMap[displayAction]} ${
                      isExpanded ? 'is-expanded' : ''
                    } stagger-in`}
                    style={{ animationDelay: `${Math.min(index, 8) * 35}ms` }}
                  >
                    <button
                      type="button"
                      className="event-feed-item__trigger"
                      onClick={() =>
                        setExpandedViolationId((current) =>
                          current === violation.id ? null : violation.id,
                        )
                      }
                      aria-expanded={isExpanded}
                    >
                      <span className="event-feed-item__avatar">
                        {resolveOffenderInitial(resolveOffenderName(violation))}
                      </span>

                      <div className="event-feed-item__body">
                        <div className="event-feed-item__headline">
                          <div className="event-feed-item__identity">
                            <strong>{resolveOffenderName(violation)}</strong>
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
                    </button>

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
                          onApplied={() => void dashboardQuery.refetch()}
                        />
                      </div>
                    ) : null}
                  </article>
                );
              })}
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
