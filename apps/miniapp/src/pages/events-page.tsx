import type {
  LogsDashboardRange,
  LogsDashboardResponse,
  ManualModerationAction,
  ManualModerationActionRequest,
} from '@maxim/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { GlassCard } from '../components/ui/glass-card';
import { SegmentedControl } from '../components/ui/segmented-control';
import { SkeletonCard } from '../components/ui/skeleton';
import { StatusState } from '../components/ui/status-state';
import { applyManualModerationAction, getLogsDashboard } from '../lib/api/events-client';
import { getChats } from '../lib/api/root-client';
import type { ApiTransport } from '../lib/api/transport';
import { readChatTitle, saveChatTitle } from '../lib/chat-titles';
import { buildManagedEntitiesRoute, saveLastEntityId } from '../lib/last-chat';

type ViolationAction = LogsDashboardResponse['violations'][number]['action'];
type ViolationItem = LogsDashboardResponse['violations'][number];
type DisplayAction = Exclude<ViolationAction, 'NONE'> | 'UNBAN';
type EventsFilter = 'ALL' | DisplayAction;

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
    COMMERCIAL_AD: 'Комерция',
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
      <div className="logs-violation-item__moderation-head">
        <span>Действия модератора</span>
        {banExpanded ? <small>Настройте срок бана</small> : null}
      </div>

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
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function EventsPage({ api }: { api: ApiTransport }) {
  const { chatId } = useParams();
  const location = useLocation();
  const [range, setRange] = useState<LogsDashboardRange>('7d');
  const [eventsFilter, setEventsFilter] = useState<EventsFilter>('ALL');

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
  const feedCaption = dashboard
    ? dashboard.violationsSummary.total > dashboard.violations.length
      ? `Показаны последние ${dashboard.violations.length} из ${dashboard.violationsSummary.total} действий`
      : `${dashboard.violations.length} действий за период`
    : '';

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

  return (
    <div className="page-stack page-enter">
      <section className="logs-head">
        <div className="logs-head__title">
          <p className="logs-head__eyebrow">События чата</p>
          <h1>{chatTitle}</h1>
          {dashboard ? (
            <p className="logs-head__summary">
              {periodCaption} · {feedCaption}
            </p>
          ) : null}
        </div>
        <SegmentedControl
          value={range}
          options={periodOptions}
          onChange={(next) => setRange(next as LogsDashboardRange)}
        />
      </section>

      {dashboardQuery.isLoading ? (
        <section className="events-list" aria-label="Загрузка событий">
          {Array.from({ length: 4 }).map((_, index) => (
            <GlassCard key={index} className="logs-violation-item" padding="sm">
              <SkeletonCard lines={3} />
            </GlassCard>
          ))}
        </section>
      ) : null}

      {dashboardQuery.error ? (
        <GlassCard>
          <StatusState
            tone="danger"
            title="Не удалось загрузить события"
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
      ) : null}

      {!dashboardQuery.isLoading && !dashboardQuery.error && dashboard ? (
        <section className="events-overview" aria-label="Сводка по чату">
          <GlassCard className="events-overview__card" padding="sm">
            <small>События</small>
            <strong>{dashboard.violationsSummary.total}</strong>
            <span>{feedCaption}</span>
          </GlassCard>
          <GlassCard className="events-overview__card" padding="sm">
            <small>Нарушители</small>
            <strong>{dashboard.violationsSummary.affectedUsers}</strong>
            <span>Уникальные участники</span>
          </GlassCard>
          <GlassCard className="events-overview__card" padding="sm">
            <small>Баланс чата</small>
            <strong
              className={`events-overview__value ${
                dashboard.membership.netUsers > 0
                  ? 'is-positive'
                  : dashboard.membership.netUsers < 0
                    ? 'is-negative'
                    : 'is-neutral'
              }`}
            >
              {formatSignedCount(dashboard.membership.netUsers)}
            </strong>
            <span>
              +{dashboard.membership.joinedUsers} / -{dashboard.membership.leftUsers}
            </span>
          </GlassCard>
          <GlassCard className="events-overview__card" padding="sm">
            <small>Жёсткие меры</small>
            <strong>{dashboard.violationsSummary.kick + dashboard.violationsSummary.ban}</strong>
            <span>
              Кики {dashboard.violationsSummary.kick} · Баны {dashboard.violationsSummary.ban}
            </span>
          </GlassCard>
        </section>
      ) : null}

      {!dashboardQuery.isLoading && !dashboardQuery.error && dashboard ? (
        <GlassCard className="logs-filter-card" padding="sm">
          <div className="logs-section-title logs-section-title--compact">
            <h2>Лента действий</h2>
          </div>
          <SegmentedControl
            value={eventsFilter}
            options={filterOptions}
            onChange={(next) => setEventsFilter(next as EventsFilter)}
            className="logs-filter-card__controls"
          />
        </GlassCard>
      ) : null}

      {!dashboardQuery.isLoading &&
      !dashboardQuery.error &&
      dashboard &&
      dashboard.violations.length === 0 ? (
        <GlassCard>
          <StatusState
            tone="neutral"
            title="Событий не найдено"
            description="За выбранный период действий модерации и ручных разбанов не было."
          />
        </GlassCard>
      ) : null}

      {!dashboardQuery.isLoading &&
      !dashboardQuery.error &&
      dashboard &&
      dashboard.violations.length > 0 &&
      filteredViolations.length === 0 ? (
        <GlassCard>
          <StatusState
            tone="neutral"
            title="По этому фильтру пусто"
            description="Попробуйте переключить тип события или расширить период."
          />
        </GlassCard>
      ) : null}

      {!dashboardQuery.isLoading &&
      !dashboardQuery.error &&
      dashboard &&
      filteredViolations.length > 0 ? (
        <section className="events-list" aria-label="Список нарушений">
          {filteredViolations.map((violation, index) => (
            <GlassCard
              key={violation.id}
              className="logs-violation-item stagger-in"
              padding="sm"
              style={{ animationDelay: `${Math.min(index, 8) * 35}ms` }}
            >
              <div className="logs-violation-item__head">
                <div className="logs-violation-item__identity">
                  <span className="logs-violation-item__avatar">
                    {resolveOffenderInitial(resolveOffenderName(violation))}
                  </span>
                  <div className="logs-violation-item__meta">
                    <span className="logs-violation-item__offender">
                      {resolveOffenderName(violation)}
                    </span>
                    <span className="logs-violation-item__date">
                      {formatViolationDate(violation.createdAt)}
                    </span>
                  </div>
                </div>
                <div className="logs-violation-item__chips">
                  <span
                    className={`badge-action badge-action--${actionToneMap[resolveDisplayAction(violation)]}`}
                  >
                    {actionLabelMap[resolveDisplayAction(violation)]}
                  </span>
                  <span className="logs-violation-item__rule">
                    {formatViolationRule(violation.ruleCode)}
                  </span>
                </div>
              </div>

              <p className="logs-violation-item__summary">{resolveViolationText(violation)}</p>
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
            </GlassCard>
          ))}
        </section>
      ) : null}
    </div>
  );
}
