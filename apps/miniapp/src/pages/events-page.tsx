import type { LogsDashboardRange, LogsDashboardResponse } from '@maxim/contracts';
import { useQuery } from '@tanstack/react-query';
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
