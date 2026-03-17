import type {
  LogsDashboardRange,
  LogsDashboardResponse,
  ManualModerationAction,
  ManualModerationActionRequest,
  MembershipActivityPage,
} from '@maxim/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { MembershipActivityFeed } from '../components/dashboard/membership-activity-feed';
import { GlassCard } from '../components/ui/glass-card';
import { SegmentedControl } from '../components/ui/segmented-control';
import { SkeletonCard } from '../components/ui/skeleton';
import { StatusState } from '../components/ui/status-state';
import {
  applyManualModerationAction,
  getChatActivityFeed,
  getLogsDashboard,
} from '../lib/api/events-client';
import { getChats } from '../lib/api/root-client';
import type { ApiTransport } from '../lib/api/transport';
import { readChatTitle, saveChatTitle } from '../lib/chat-titles';
import { buildManagedEntitiesRoute, saveLastEntityId } from '../lib/last-chat';
import { useMembershipActivityFeed } from '../lib/use-membership-activity-feed';

type ViolationAction = LogsDashboardResponse['violations'][number]['action'];
type ViolationItem = LogsDashboardResponse['violations'][number];
type DisplayAction = Exclude<ViolationAction, 'NONE'> | 'UNBAN';
type EventsFilter = 'ALL' | DisplayAction;
type EventsSection = 'activity' | 'moderation';

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

function resolveViolationText(violation: LogsDashboardResponse['violations'][number]): string {
  if (violation.ruleCode === 'MANUAL_UNBAN') {
    return 'Участник разблокирован модератором.';
  }

  if (violation.ruleCode === 'MANUAL_KICK') {
    return 'Участник удалён модератором.';
  }

  if (violation.ruleCode === 'MANUAL_BAN') {
    const metadata =
      violation.metadata && typeof violation.metadata === 'object' && !Array.isArray(violation.metadata)
        ? violation.metadata
        : null;
    const banDurationHours =
      metadata && typeof metadata.banDurationHours === 'number' && Number.isFinite(metadata.banDurationHours)
        ? metadata.banDurationHours
        : null;

    return banDurationHours
      ? `Бан вручную на ${banDurationHours}ч.`
      : 'Участник забанен модератором.';
  }

  const rule = formatViolationRule(violation.ruleCode);

  if (violation.action === 'DELETE_MESSAGE') {
    return `Сообщение удалено · ${rule}`;
  }

  if (violation.action === 'WARN') {
    return `Предупреждение · ${rule}`;
  }

  if (violation.action === 'KICK') {
    return `Кик · ${rule}`;
  }

  if (violation.action === 'BAN') {
    return `Бан · ${rule}`;
  }

  return rule;
}

function formatPeriodCaption(from: string, to: string): string {
  const fromDate = new Date(from);
  const toDate = new Date(to);
  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
    return `${from} - ${to}`;
  }

  return `${fromDate.toLocaleDateString('ru-RU', {
    day: '2-digit',
    month: 'short',
  })} - ${toDate.toLocaleDateString('ru-RU', {
    day: '2-digit',
    month: 'short',
  })}`;
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
    const normalizedHours = action === 'BAN' ? clampBanDurationHours(hours ?? banDurationHours) : null;
    const confirmed = window.confirm(resolveConfirmMessage(action, normalizedHours ?? banDurationHours));
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
            {applyMutation.isPending ? 'Применяем…' : resolveApplyActionLabel('BAN', banDurationHours)}
          </button>
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

function resolveChatStatsLastUpdated(dashboard: LogsDashboardResponse | null): string | null {
  if (!dashboard) {
    return null;
  }

  const latestAt = dashboard.activityFeed.items[0]?.createdAt ?? dashboard.violations[0]?.createdAt;
  return latestAt ? formatViolationDate(latestAt) : null;
}

export function EventsPage({ api }: { api: ApiTransport }) {
  const { chatId } = useParams();
  const location = useLocation();
  const [range, setRange] = useState<LogsDashboardRange>('7d');
  const [section, setSection] = useState<EventsSection>('moderation');
  const [eventsFilter, setEventsFilter] = useState<EventsFilter>('ALL');
  const [expandedViolationId, setExpandedViolationId] = useState<string | null>(null);

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
  const activityFeed = useMembershipActivityFeed({
    range,
    initialPage: dashboard?.activityFeed ?? EMPTY_ACTIVITY_PAGE,
    loadPage: (query) => getChatActivityFeed(api, chatId ?? '', query),
  });
  const filterOptions = useMemo<Array<{ value: EventsFilter; label: string; count: number }>>(() => {
    if (!dashboard) {
      return [{ value: 'ALL', label: 'Все', count: 0 }];
    }

    const options: Array<{ value: EventsFilter; label: string; count: number }> = [
      { value: 'ALL', label: 'Все', count: dashboard.violationsSummary.total },
      { value: 'WARN', label: 'Предупр.', count: dashboard.violationsSummary.warn },
      { value: 'DELETE_MESSAGE', label: 'Удаления', count: dashboard.violationsSummary.deleteMessage },
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
  }, [eventsFilter, range, section]);

  const filteredViolations = useMemo(() => {
    if (!dashboard) {
      return [];
    }

    if (eventsFilter === 'ALL') {
      return dashboard.violations;
    }

    return dashboard.violations.filter((violation) => resolveDisplayAction(violation) === eventsFilter);
  }, [dashboard, eventsFilter]);

  const periodCaption = dashboard
    ? formatPeriodCaption(dashboard.period.from, dashboard.period.to)
    : '';
  const hardMeasures = dashboard
    ? dashboard.violationsSummary.kick + dashboard.violationsSummary.ban
    : 0;
  const sectionOptions = [
    { value: 'moderation' as const, label: 'Модерация' },
    { value: 'activity' as const, label: 'Входы и выходы' },
  ];

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

  if (dashboardQuery.isLoading && !dashboard) {
    return (
      <div className="page-stack page-enter">
        <GlassCard className="settings-section">
          <SkeletonCard lines={14} />
        </GlassCard>
      </div>
    );
  }

  if (dashboardQuery.error && !dashboard) {
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

  if (!dashboard) {
    return null;
  }

  const summaryItems =
    section === 'activity'
      ? [
          {
            label: 'Вошли',
            value: String(dashboard.membership.joinedUsers),
            tone: 'success',
          },
          {
            label: 'Вышли',
            value: String(dashboard.membership.leftUsers),
            tone: 'warning',
          },
          {
            label: 'Баланс',
            value: formatSignedCount(dashboard.membership.netUsers),
            tone:
              dashboard.membership.netUsers > 0
                ? 'success'
                : dashboard.membership.netUsers < 0
                  ? 'danger'
                  : 'neutral',
          },
        ]
      : [
          {
            label: 'События',
            value: String(dashboard.violationsSummary.total),
            tone: 'accent',
          },
          {
            label: 'Люди',
            value: String(dashboard.violationsSummary.affectedUsers),
            tone: 'neutral',
          },
          {
            label: 'Кики + баны',
            value: String(hardMeasures),
            tone: hardMeasures > 0 ? 'danger' : 'neutral',
          },
        ];
  const lastUpdated = resolveChatStatsLastUpdated(dashboard);

  return (
    <div className="events-screen page-enter">
      <header className="events-screen__header stagger-in">
        <div className="events-screen__header-main">
          <Link
            to={buildManagedEntitiesRoute('chat')}
            className="events-screen__back"
            aria-label="К списку чатов"
          >
            ←
          </Link>

          <div className="events-screen__identity">
            <div className="events-screen__topline">
              <span className="events-screen__eyebrow">Статистика</span>
              {dashboardQuery.isFetching ? (
                <span className="events-screen__badge">Обновляем</span>
              ) : null}
            </div>

            <h1>{chatTitle}</h1>

            <div className="events-screen__meta">
              <span>{periodCaption}</span>
              {lastUpdated ? <span>Обновлено {lastUpdated}</span> : null}
            </div>
          </div>
        </div>

        <div className="events-screen__nav">
          <SegmentedControl
            value={section}
            options={sectionOptions}
            onChange={(next) => setSection(next as EventsSection)}
            className="events-screen__section-nav"
          />

          <SegmentedControl
            value={range}
            options={periodOptions}
            onChange={(next) => setRange(next as LogsDashboardRange)}
            className="events-screen__range-nav"
          />
        </div>

        <section
          className="events-screen__summary"
          aria-label={section === 'activity' ? 'Сводка по входам и выходам' : 'Сводка по модерации'}
        >
          {summaryItems.map((item) => (
            <article
              key={item.label}
              className={`events-summary-card events-summary-card--${item.tone}`}
            >
              <small>{item.label}</small>
              <strong>{item.value}</strong>
            </article>
          ))}
        </section>
      </header>

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

      {section === 'moderation' ? (
        <>
          <section className="events-toolbar" aria-label="Фильтр модерации">
            <SegmentedControl
              value={eventsFilter}
              options={filterOptions}
              onChange={(next) => setEventsFilter(next as EventsFilter)}
              className="events-toolbar__filters"
            />
          </section>

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

          {dashboard.violations.length === 0 ? (
            <GlassCard className="events-inline-state">
              <StatusState
                tone="neutral"
                title="Нарушений не найдено"
                description="За выбранный период действий модерации и ручных разбанов не было."
              />
            </GlassCard>
          ) : null}

          {dashboard.violations.length > 0 && filteredViolations.length === 0 ? (
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
                          <strong>{resolveOffenderName(violation)}</strong>
                          <time dateTime={violation.createdAt}>
                            {formatViolationDate(violation.createdAt)}
                          </time>
                        </div>

                        <div className="event-feed-item__meta">
                          <span
                            className={`event-feed-item__action event-feed-item__action--${actionToneMap[displayAction]}`}
                          >
                            {actionLabelMap[displayAction]}
                          </span>
                          <span className="event-feed-item__rule">
                            {formatViolationRule(violation.ruleCode)}
                          </span>
                        </div>

                        <p className="event-feed-item__summary">
                          {resolveViolationText(violation)}
                        </p>
                      </div>

                      <span className="event-feed-item__toggle" aria-hidden="true">
                        {isExpanded ? '−' : '+'}
                      </span>
                    </button>

                    {isExpanded ? (
                      <div className="event-feed-item__details">
                        {violation.maskedExcerpt ? (
                          <div className="logs-violation-item__excerpt-inline">
                            <span>Фрагмент</span>
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
