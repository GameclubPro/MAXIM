import type {
  LogsDashboardRange,
  LogsDashboardResponse,
  ManualModerationAction,
} from '@maxim/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { GlassCard } from '../components/ui/glass-card';
import { SegmentedControl } from '../components/ui/segmented-control';
import { SkeletonCard } from '../components/ui/skeleton';
import { StatusState } from '../components/ui/status-state';
import type { ApiClient } from '../lib/api-client';
import { readChatTitle, saveChatTitle } from '../lib/chat-titles';
import { saveLastChatId } from '../lib/last-chat';

type ViolationAction = LogsDashboardResponse['violations'][number]['action'];
type ViolationItem = LogsDashboardResponse['violations'][number];

const BAN_DURATION_MIN_HOURS = 1;
const BAN_DURATION_MAX_HOURS = 336;

const actionLabelMap: Record<ViolationAction, string> = {
  DELETE_MESSAGE: 'Удаление',
  WARN: 'Предупреждение',
  KICK: 'Исключение',
  BAN: 'Бан',
  NONE: 'Без санкции',
};

const actionToneMap: Record<ViolationAction, 'neutral' | 'warning' | 'danger'> = {
  WARN: 'warning',
  DELETE_MESSAGE: 'danger',
  KICK: 'danger',
  BAN: 'danger',
  NONE: 'neutral',
};

const periodOptions: Array<{ value: LogsDashboardRange; label: string }> = [
  { value: '24h', label: '24ч' },
  { value: '7d', label: '7д' },
  { value: '30d', label: '30д' },
];

const manualActionOptions: Array<{ value: ManualModerationAction; label: string }> = [
  { value: 'KICK', label: 'Удалить' },
  { value: 'BAN', label: 'Бан' },
  { value: 'UNBAN', label: 'Вернуть' },
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
    COMMERCIAL_AD: 'Реклама',
    MESSAGE_TOO_LONG: 'Слишком длинное сообщение',
    VIDEO_BLOCKED: 'Видео запрещено',
    FILE_BLOCKED: 'Файлы запрещены',
    VOICE_BLOCKED: 'Голосовые запрещены',
    PHOTO_RATE_LIMIT: 'Слишком много фото',
    DUPLICATE_WARN: 'Повторяющиеся сообщения',
    DUPLICATE_KICK: 'Повторяющиеся сообщения',
    DUPLICATE_BAN: 'Повторяющиеся сообщения',
    GLOBAL_USER_BLACKLIST_KICK: 'Глобальный черный список',
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

function resolveViolationText(violation: LogsDashboardResponse['violations'][number]): string {
  const metadataReason =
    violation.metadata &&
    typeof violation.metadata === 'object' &&
    'reason' in violation.metadata &&
    typeof violation.metadata.reason === 'string'
      ? violation.metadata.reason.trim()
      : '';

  if (metadataReason) {
    return metadataReason;
  }

  return `Нарушение: ${formatViolationRule(violation.ruleCode)}.`;
}

function clampBanDurationHours(value: number): number {
  const normalized = Number.isFinite(value) ? Math.trunc(value) : BAN_DURATION_MIN_HOURS;
  return Math.max(BAN_DURATION_MIN_HOURS, Math.min(BAN_DURATION_MAX_HOURS, normalized));
}

function resolveApplyActionLabel(action: ManualModerationAction, banDurationHours: number): string {
  if (action === 'KICK') {
    return 'Удалить участника';
  }

  if (action === 'BAN') {
    return `Забанить на ${banDurationHours}ч`;
  }

  return 'Вернуть и разбанить';
}

function resolveConfirmMessage(action: ManualModerationAction, banDurationHours: number): string {
  if (action === 'KICK') {
    return 'Удалить участника из чата?';
  }

  if (action === 'BAN') {
    return `Забанить участника на ${banDurationHours}ч с авторазбаном?`;
  }

  return 'Вернуть участника в чат и снять блокировку?';
}

function ViolationModerationControls({
  api,
  chatId,
  violation,
  onApplied,
}: {
  api: ApiClient;
  chatId: string;
  violation: ViolationItem;
  onApplied: () => void;
}) {
  const [action, setAction] = useState<ManualModerationAction>('KICK');
  const [banDurationHours, setBanDurationHours] = useState(6);
  const [status, setStatus] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const isBanAction = action === 'BAN';

  const applyMutation = useMutation({
    mutationFn: async () =>
      api.applyManualModerationAction(chatId, violation.userId, {
        action,
        ...(isBanAction ? { banDurationHours } : {}),
      }),
    onSuccess: (result) => {
      setStatus({ tone: 'success', text: result.message });
      onApplied();
    },
    onError: (error: unknown) => {
      const message = error instanceof Error ? error.message : 'Не удалось выполнить действие.';
      setStatus({ tone: 'danger', text: message });
    },
  });

  return (
    <div className="logs-violation-item__actions" aria-label="Ручная модерация">
      <div className="logs-violation-item__actions-head">
        <span>Действие по участнику</span>
        <code>{violation.userId}</code>
      </div>

      <div className="logs-violation-item__actions-row">
        {manualActionOptions.map((option) => (
          <button
            key={option.value}
            type="button"
            className={`logs-violation-item__action-pill ${
              action === option.value ? 'is-active' : ''
            }`}
            onClick={() => {
              setAction(option.value);
              setStatus(null);
            }}
            disabled={applyMutation.isPending}
          >
            {option.label}
          </button>
        ))}
      </div>

      {isBanAction ? (
        <div className="logs-violation-item__ban-config">
          <span>Длительность, часы</span>
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
        </div>
      ) : null}

      <button
        type="button"
        className="button button--accent logs-violation-item__apply-button"
        disabled={applyMutation.isPending}
        onClick={() => {
          const confirmed = window.confirm(resolveConfirmMessage(action, banDurationHours));
          if (!confirmed) {
            return;
          }

          setStatus(null);
          applyMutation.mutate();
        }}
      >
        {applyMutation.isPending ? 'Выполняем…' : resolveApplyActionLabel(action, banDurationHours)}
      </button>

      {status ? (
        <p className={`logs-violation-item__action-status is-${status.tone}`}>{status.text}</p>
      ) : null}
    </div>
  );
}

export function EventsPage({ api }: { api: ApiClient }) {
  const { chatId } = useParams();
  const location = useLocation();
  const [range, setRange] = useState<LogsDashboardRange>('7d');

  const routeChatTitle = getRouteChatTitle(location.state);

  useEffect(() => {
    if (chatId) {
      saveLastChatId(chatId);
    }
  }, [chatId]);

  const chatsQuery = useQuery({
    queryKey: ['chats'],
    queryFn: () => api.getChats(),
    enabled: Boolean(chatId),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  const dashboardQuery = useQuery({
    queryKey: ['logs-dashboard', chatId, range],
    queryFn: () => api.getLogsDashboard(chatId ?? '', range),
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

  if (!chatId) {
    return (
      <GlassCard>
        <StatusState
          tone="warning"
          title="Чат не выбран"
          description="Выберите чат в разделе «Чаты»."
          action={
            <Link to="/" className="button button--accent">
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
          <p className="logs-head__eyebrow">Логи чата</p>
          <h1>{chatTitle}</h1>
        </div>
        <SegmentedControl
          value={range}
          options={periodOptions}
          onChange={(next) => setRange(next as LogsDashboardRange)}
        />
      </section>

      {dashboardQuery.isLoading ? (
        <section className="events-list" aria-label="Загрузка логов">
          {Array.from({ length: 4 }).map((_, index) => (
            <GlassCard key={index} className="logs-violation-item">
              <SkeletonCard lines={3} />
            </GlassCard>
          ))}
        </section>
      ) : null}

      {dashboardQuery.error ? (
        <GlassCard>
          <StatusState
            tone="danger"
            title="Не удалось загрузить логи"
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

      {!dashboardQuery.isLoading && !dashboardQuery.error && dashboardQuery.data ? (
        <GlassCard>
          <section className="logs-membership" aria-label="Статистика участников">
            <div className="logs-section-title">
              <h2>Участники</h2>
              <p>
                Период: {new Date(dashboardQuery.data.period.from).toLocaleDateString('ru-RU')} -{' '}
                {new Date(dashboardQuery.data.period.to).toLocaleDateString('ru-RU')}
              </p>
            </div>
            <div className="logs-membership__grid">
              <article className="logs-metric-card">
                <small>Вступили</small>
                <strong>{dashboardQuery.data.membership.joinedUsers}</strong>
              </article>
              <article className="logs-metric-card">
                <small>Вышли</small>
                <strong>{dashboardQuery.data.membership.leftUsers}</strong>
              </article>
            </div>
          </section>
        </GlassCard>
      ) : null}

      {!dashboardQuery.isLoading && !dashboardQuery.error && dashboardQuery.data ? (
        <section className="logs-summary" aria-label="Сводка нарушений">
          <GlassCard>
            <div className="logs-section-title">
              <h2>Нарушения</h2>
              <p>Предупреждения, удаления, исключения и баны.</p>
            </div>
            <div className="logs-summary__grid">
              <article className="logs-metric-card">
                <small>Предупреждения</small>
                <strong>{dashboardQuery.data.violationsSummary.warn}</strong>
              </article>
              <article className="logs-metric-card">
                <small>Удаления</small>
                <strong>{dashboardQuery.data.violationsSummary.deleteMessage}</strong>
              </article>
              <article className="logs-metric-card">
                <small>Исключения</small>
                <strong>{dashboardQuery.data.violationsSummary.kick}</strong>
              </article>
              <article className="logs-metric-card">
                <small>Баны</small>
                <strong>{dashboardQuery.data.violationsSummary.ban}</strong>
              </article>
            </div>
          </GlassCard>
        </section>
      ) : null}

      {!dashboardQuery.isLoading &&
      !dashboardQuery.error &&
      dashboardQuery.data &&
      dashboardQuery.data.violations.length === 0 ? (
        <GlassCard>
          <StatusState
            tone="neutral"
            title="Нарушений не найдено"
            description="За выбранный период действий модерации не было."
          />
        </GlassCard>
      ) : null}

      {!dashboardQuery.isLoading &&
      !dashboardQuery.error &&
      dashboardQuery.data &&
      dashboardQuery.data.violations.length > 0 ? (
        <section className="events-list" aria-label="Список нарушений">
          {dashboardQuery.data.violations.map((violation, index) => (
            <GlassCard
              key={violation.id}
              className="logs-violation-item stagger-in"
              style={{ animationDelay: `${Math.min(index, 8) * 35}ms` }}
            >
              <div className="logs-violation-item__head">
                <div className="logs-violation-item__meta">
                  <span className="logs-violation-item__date">
                    {new Date(violation.createdAt).toLocaleString('ru-RU', {
                      day: '2-digit',
                      month: 'short',
                      year: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                  <span className="logs-violation-item__rule">
                    {formatViolationRule(violation.ruleCode)}
                  </span>
                </div>
                <span className={`badge-action badge-action--${actionToneMap[violation.action]}`}>
                  {actionLabelMap[violation.action]}
                </span>
              </div>

              <p className="logs-violation-item__reason">{resolveViolationText(violation)}</p>

              <ViolationModerationControls
                api={api}
                chatId={chatId}
                violation={violation}
                onApplied={() => void dashboardQuery.refetch()}
              />

              <details className="logs-violation-item__details">
                <summary>Подробности</summary>
                <div className="logs-violation-item__details-grid">
                  <div>
                    <span>ID пользователя</span>
                    <code>{violation.userId}</code>
                  </div>
                  <div>
                    <span>Код правила</span>
                    <code>{violation.ruleCode}</code>
                  </div>
                  {violation.maskedExcerpt ? (
                    <div className="logs-violation-item__excerpt">
                      <span>Фрагмент сообщения</span>
                      <p>{violation.maskedExcerpt}</p>
                    </div>
                  ) : null}
                </div>
              </details>
            </GlassCard>
          ))}
        </section>
      ) : null}
    </div>
  );
}
