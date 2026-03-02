import type { ModerationEvent } from '@maxim/contracts';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { GlassCard } from '../components/ui/glass-card';
import { PageHeader } from '../components/ui/page-header';
import { SegmentedControl } from '../components/ui/segmented-control';
import { SkeletonCard } from '../components/ui/skeleton';
import { StatusState } from '../components/ui/status-state';
import type { ApiClient } from '../lib/api-client';
import { saveLastChatId } from '../lib/last-chat';

type ActionFilter = 'ALL' | ModerationEvent['action'];

const actionLabelMap: Record<ModerationEvent['action'], string> = {
  NONE: 'Без санкции',
  WARN: 'Предупреждение',
  DELETE_MESSAGE: 'Удаление',
  KICK: 'Кик',
  BAN: 'Бан',
};

const actionToneMap: Record<ModerationEvent['action'], 'neutral' | 'warning' | 'danger'> = {
  NONE: 'neutral',
  WARN: 'warning',
  DELETE_MESSAGE: 'danger',
  KICK: 'danger',
  BAN: 'danger',
};

export function EventsPage({ api }: { api: ApiClient }) {
  const { chatId } = useParams();
  const [search, setSearch] = useState('');
  const [actionFilter, setActionFilter] = useState<ActionFilter>('ALL');

  useEffect(() => {
    if (chatId) {
      saveLastChatId(chatId);
    }
  }, [chatId]);

  const eventsQuery = useQuery({
    queryKey: ['events', chatId],
    queryFn: () => api.getEvents(chatId ?? ''),
    enabled: Boolean(chatId),
    refetchInterval: () => (document.hidden ? false : 10_000),
    refetchOnWindowFocus: true,
  });

  const actionStats = useMemo(() => {
    const stats: Record<ModerationEvent['action'], number> = {
      NONE: 0,
      WARN: 0,
      DELETE_MESSAGE: 0,
      KICK: 0,
      BAN: 0,
    };

    for (const event of eventsQuery.data ?? []) {
      stats[event.action] += 1;
    }

    return stats;
  }, [eventsQuery.data]);

  const filteredEvents = useMemo(() => {
    const source = eventsQuery.data ?? [];
    const normalizedSearch = search.trim().toLowerCase();

    return source.filter((event) => {
      if (actionFilter !== 'ALL' && event.action !== actionFilter) {
        return false;
      }

      if (!normalizedSearch) {
        return true;
      }

      const haystack = `${event.userId} ${event.ruleCode} ${event.maskedExcerpt ?? ''}`.toLowerCase();
      return haystack.includes(normalizedSearch);
    });
  }, [actionFilter, eventsQuery.data, search]);

  const segmentedOptions = useMemo(
    () => [
      { value: 'ALL' as const, label: 'Все', count: eventsQuery.data?.length ?? 0 },
      { value: 'WARN' as const, label: 'Варн', count: actionStats.WARN },
      { value: 'DELETE_MESSAGE' as const, label: 'Удаление', count: actionStats.DELETE_MESSAGE },
      { value: 'KICK' as const, label: 'Кик', count: actionStats.KICK },
      { value: 'BAN' as const, label: 'Бан', count: actionStats.BAN },
      { value: 'NONE' as const, label: 'Без санкции', count: actionStats.NONE },
    ],
    [actionStats, eventsQuery.data?.length],
  );

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
      <GlassCard className="hero-card" elevated>
        <PageHeader
          title="Логи модерации"
          subtitle="Последние 50 событий с автообновлением каждые 10 секунд."
          badge={`Чат: ${chatId}`}
        />

        <div className="events-tools">
          <label className="field field--search" htmlFor="events-search">
            <span>Поиск по userId, правилу или excerpt</span>
            <input
              id="events-search"
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Например: spam_link"
            />
          </label>
          <SegmentedControl value={actionFilter} options={segmentedOptions} onChange={setActionFilter} />
        </div>
      </GlassCard>

      <section className="events-stats" aria-label="Статистика действий">
        {([
          ['WARN', actionStats.WARN],
          ['DELETE_MESSAGE', actionStats.DELETE_MESSAGE],
          ['KICK', actionStats.KICK],
          ['BAN', actionStats.BAN],
        ] as Array<[ModerationEvent['action'], number]>).map(([action, count], index) => (
          <GlassCard
            key={action}
            className="events-stats__card stagger-in"
            style={{ animationDelay: `${index * 40}ms` }}
          >
            <small>{actionLabelMap[action]}</small>
            <h3>{count}</h3>
          </GlassCard>
        ))}
      </section>

      {eventsQuery.isLoading ? (
        <section className="events-list" aria-label="Загрузка событий">
          {Array.from({ length: 5 }).map((_, index) => (
            <GlassCard key={index} className="events-item">
              <SkeletonCard lines={3} />
            </GlassCard>
          ))}
        </section>
      ) : null}

      {eventsQuery.error ? (
        <GlassCard>
          <StatusState
            tone="danger"
            title="Не удалось загрузить журнал"
            description={(eventsQuery.error as Error).message}
            action={
              <button type="button" className="button button--danger" onClick={() => void eventsQuery.refetch()}>
                Повторить
              </button>
            }
          />
        </GlassCard>
      ) : null}

      {!eventsQuery.isLoading && !eventsQuery.error && filteredEvents.length === 0 ? (
        <GlassCard>
          <StatusState
            tone="neutral"
            title="События не найдены"
            description="Измените фильтры или дождитесь новых сообщений в чате."
          />
        </GlassCard>
      ) : null}

      {!eventsQuery.isLoading && !eventsQuery.error && filteredEvents.length > 0 ? (
        <section className="events-list" aria-label="Список событий">
          {filteredEvents.map((event, index) => (
            <GlassCard
              key={event.id}
              className="events-item stagger-in"
              style={{ animationDelay: `${Math.min(index, 8) * 35}ms` }}
            >
              <div className="events-item__head">
                <div className="events-item__meta">
                  <span className="events-item__date">
                    {new Date(event.createdAt).toLocaleString('ru-RU', {
                      day: '2-digit',
                      month: 'short',
                      year: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                  <span className="events-item__rule-chip">{event.ruleCode}</span>
                </div>
                <span className={`badge-action badge-action--${actionToneMap[event.action]}`}>
                  {actionLabelMap[event.action]}
                </span>
              </div>

              <div className="events-item__identity">
                <span className="events-item__identity-label">Пользователь</span>
                <code className="events-item__identity-value">{event.userId}</code>
              </div>

              <div className="events-item__facts">
                <div className="events-item__fact">
                  <span>Score</span>
                  <strong>{event.score}</strong>
                </div>
                <div className="events-item__fact">
                  <span>Operator</span>
                  <strong>{event.operator}</strong>
                </div>
              </div>

              {event.maskedExcerpt ? (
                <div className="events-item__excerpt">
                  <span className="events-item__excerpt-label">Excerpt</span>
                  <p>{event.maskedExcerpt}</p>
                </div>
              ) : null}
            </GlassCard>
          ))}
        </section>
      ) : null}
    </div>
  );
}
