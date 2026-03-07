import type { ChannelStatsRange, ChannelStatsResponse } from '@maxim/contracts';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { GlassCard } from '../components/ui/glass-card';
import { SegmentedControl } from '../components/ui/segmented-control';
import { SkeletonCard } from '../components/ui/skeleton';
import { StatusState } from '../components/ui/status-state';
import { cn } from '../lib/cn';
import type { ApiClient } from '../lib/api-client';
import { readChatTitle, saveChatTitle } from '../lib/chat-titles';
import { saveLastChatId, saveLastEntityType } from '../lib/last-chat';

type ChannelStatsRouteState = {
  chatTitle: string;
};

const periodOptions: Array<{ value: ChannelStatsRange; label: string }> = [
  { value: '24h', label: '24ч' },
  { value: '7d', label: '7д' },
  { value: '30d', label: '30д' },
];

function getRouteState(state: unknown): ChannelStatsRouteState {
  if (!state || typeof state !== 'object') {
    return {
      chatTitle: '',
    };
  }

  const row = state as Record<string, unknown>;
  return {
    chatTitle:
      typeof row.chatTitle === 'string' && row.chatTitle.trim() ? row.chatTitle.trim() : '',
  };
}

function formatCount(value: number | null): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '—';
  }

  return new Intl.NumberFormat('ru-RU').format(value);
}

function formatDateTime(value: string | null): string {
  if (!value) {
    return 'Нет данных';
  }

  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    return 'Нет данных';
  }

  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(parsed);
}

function formatLink(value: string | null): string {
  if (!value) {
    return 'Канал приватный';
  }

  try {
    const parsed = new URL(value);
    return `${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`;
  } catch {
    return value;
  }
}

function hasActivity(summary: ChannelStatsResponse['summary']): boolean {
  return (
    summary.postsWithButtons > 0 ||
    summary.comments > 0 ||
    summary.suggestions > 0 ||
    summary.commentAuthors > 0 ||
    summary.suggestionAuthors > 0 ||
    summary.suggestionsDelivered > 0 ||
    summary.suggestionsFailed > 0 ||
    summary.lastBotActivityAt !== null
  );
}

function resolveStatusChips(
  stats: ChannelStatsResponse | undefined,
): Array<{ label: string; className: string }> {
  if (!stats) {
    return [];
  }

  if (!stats.meta.maxSnapshotAvailable) {
    return [{ label: 'Данные канала недоступны', className: 'chip' }];
  }

  const chips: Array<{ label: string; className: string }> = [];

  if (stats.channel.status) {
    const isActive = stats.channel.status === 'active';
    chips.push({
      label: isActive ? 'Активен' : 'Неактивен',
      className: cn('chip', isActive ? 'chip--success' : 'chip--warning'),
    });
  }

  if (stats.channel.isPublic !== null) {
    chips.push({
      label: stats.channel.isPublic ? 'Публичный' : 'Приватный',
      className: cn('chip', !stats.channel.isPublic && 'chip--warning'),
    });
  }

  return chips;
}

function buildActivityChart(summary: ChannelStatsResponse['summary']): {
  total: number;
  background: string;
  segments: Array<{ label: string; value: number; colorClassName: string }>;
} {
  const posts = Math.max(0, summary.postsWithButtons);
  const comments = Math.max(0, summary.comments);
  const suggestions = Math.max(0, summary.suggestions);
  const total = posts + comments + suggestions;

  if (total === 0) {
    return {
      total,
      background: 'conic-gradient(#d9e6f2 0deg 360deg)',
      segments: [
        { label: 'Посты', value: posts, colorClassName: 'is-posts' },
        { label: 'Комментарии', value: comments, colorClassName: 'is-comments' },
        { label: 'Предложки', value: suggestions, colorClassName: 'is-suggestions' },
      ],
    };
  }

  const postsAngle = (posts / total) * 360;
  const commentsAngle = (comments / total) * 360;
  const suggestionsAngle = 360 - postsAngle - commentsAngle;
  const postsEnd = postsAngle;
  const commentsEnd = postsEnd + commentsAngle;
  const suggestionsEnd = commentsEnd + suggestionsAngle;

  return {
    total,
    background: `conic-gradient(
      #28b47a 0deg ${postsEnd}deg,
      #0b84ff ${postsEnd}deg ${commentsEnd}deg,
      #ff8a3d ${commentsEnd}deg ${suggestionsEnd}deg
    )`,
    segments: [
      { label: 'Посты', value: posts, colorClassName: 'is-posts' },
      { label: 'Комментарии', value: comments, colorClassName: 'is-comments' },
      { label: 'Предложки', value: suggestions, colorClassName: 'is-suggestions' },
    ],
  };
}

function MetricCard({
  label,
  value,
  hint,
  highlighted = false,
}: {
  label: string;
  value: string;
  hint: string;
  highlighted?: boolean;
}) {
  return (
    <article className={cn('channel-stats-metric', highlighted && 'is-accent')}>
      <small>{label}</small>
      <strong>{value}</strong>
      <p>{hint}</p>
    </article>
  );
}

export function ChannelStatsPage({ api }: { api: ApiClient }) {
  const { chatId = '' } = useParams();
  const location = useLocation();
  const routeState = getRouteState(location.state);
  const [range, setRange] = useState<ChannelStatsRange>('7d');

  const statsQuery = useQuery({
    queryKey: ['channel-stats', chatId, range],
    queryFn: () => api.getChannelStats(chatId, range),
    enabled: Boolean(chatId),
  });

  useEffect(() => {
    if (!chatId) {
      return;
    }

    saveLastChatId(chatId);
    saveLastEntityType('channel');
  }, [chatId]);

  const resolvedTitle = useMemo(() => {
    return (
      statsQuery.data?.channel.title || routeState.chatTitle || readChatTitle(chatId) || 'Канал'
    );
  }, [chatId, routeState.chatTitle, statsQuery.data?.channel.title]);

  useEffect(() => {
    if (!chatId || !resolvedTitle) {
      return;
    }

    saveChatTitle(chatId, resolvedTitle);
  }, [chatId, resolvedTitle]);

  if (!chatId) {
    return (
      <div className="page-stack page-enter">
        <GlassCard>
          <StatusState
            tone="warning"
            title="Канал не выбран"
            description="Откройте канал из списка на главном экране."
            action={
              <Link to="/" className="button button--accent">
                К списку
              </Link>
            }
          />
        </GlassCard>
      </div>
    );
  }

  if (statsQuery.isLoading && !statsQuery.data) {
    return (
      <div className="page-stack page-enter">
        <GlassCard className="settings-section">
          <SkeletonCard lines={10} />
        </GlassCard>
      </div>
    );
  }

  if (statsQuery.error && !statsQuery.data) {
    return (
      <div className="page-stack page-enter">
        <GlassCard>
          <StatusState
            tone="danger"
            title="Не удалось загрузить статистику"
            description={(statsQuery.error as Error).message}
            action={
              <button
                type="button"
                className="button button--danger"
                onClick={() => void statsQuery.refetch()}
              >
                Повторить
              </button>
            }
          />
        </GlassCard>
      </div>
    );
  }

  const stats = statsQuery.data;
  if (!stats) {
    return null;
  }

  const statusChips = resolveStatusChips(stats);
  const isEmptyPeriod = !hasActivity(stats.summary);
  const activityChart = buildActivityChart(stats.summary);
  const deliveryRate =
    stats.summary.suggestions > 0
      ? Math.round((stats.summary.suggestionsDelivered / stats.summary.suggestions) * 100)
      : 0;

  return (
    <div className="channel-stats-screen page-enter">
      <GlassCard className="channel-stats-hero" elevated>
        <div className="channel-stats-hero__top">
          <Link to="/" className="button button--ghost channel-stats-hero__back">
            Назад
          </Link>
          <span className="channel-stats-hero__badge">
            {statsQuery.isFetching ? 'Обновляем' : 'Статистика'}
          </span>
        </div>

        <div className="channel-stats-hero__main">
          <h1>{resolvedTitle}</h1>
          <p>{chatId}</p>
        </div>

        <SegmentedControl
          value={range}
          options={periodOptions}
          onChange={setRange}
          className="channel-stats-hero__range"
        />

        {statusChips.length > 0 ? (
          <div className="channel-stats-hero__chips">
            {statusChips.map((chip) => (
              <span key={chip.label} className={chip.className}>
                {chip.label}
              </span>
            ))}
          </div>
        ) : null}

        {!stats.meta.maxSnapshotAvailable ? (
          <p className="channel-stats-note">
            Сейчас доступны только данные активности через бота. Снимок канала временно не получен.
          </p>
        ) : null}
      </GlassCard>

      <section className="channel-stats-insights" aria-label="Диаграммы по активности">
        <GlassCard className="channel-stats-panel" elevated>
          <div className="channel-stats-panel__head">
            <small>Срез периода</small>
            <strong>{formatCount(activityChart.total)} действий</strong>
          </div>

          <div className="channel-stats-donut-layout">
            <div
              className="channel-stats-donut"
              style={{ background: activityChart.background }}
              aria-hidden
            >
              <div className="channel-stats-donut__core">
                <span>Всего</span>
                <strong>{formatCount(activityChart.total)}</strong>
              </div>
            </div>

            <div className="channel-stats-legend">
              {activityChart.segments.map((segment) => (
                <div key={segment.label} className="channel-stats-legend__item">
                  <span className={cn('channel-stats-legend__swatch', segment.colorClassName)} />
                  <div>
                    <small>{segment.label}</small>
                    <strong>{formatCount(segment.value)}</strong>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </GlassCard>

        <GlassCard className="channel-stats-panel channel-stats-panel--delivery" elevated>
          <div className="channel-stats-panel__head">
            <small>Доставка идей</small>
            <strong>{stats.summary.suggestions > 0 ? `${deliveryRate}%` : 'Нет данных'}</strong>
          </div>

          <div className="channel-stats-delivery">
            <div className="channel-stats-delivery__bar" aria-hidden>
              <span style={{ width: `${deliveryRate}%` }} />
            </div>

            <div className="channel-stats-delivery__stats">
              <article>
                <small>Доставлено</small>
                <strong>{formatCount(stats.summary.suggestionsDelivered)}</strong>
              </article>
              <article>
                <small>С ошибкой</small>
                <strong>{formatCount(stats.summary.suggestionsFailed)}</strong>
              </article>
            </div>
          </div>
        </GlassCard>
      </section>

      <section className="channel-stats-metrics" aria-label="Основная статистика канала">
        <MetricCard
          label="Участников"
          value={formatCount(stats.channel.participantsCount)}
          hint={
            stats.meta.maxSnapshotAvailable
              ? 'Текущее количество подписчиков'
              : 'Снимок канала временно недоступен'
          }
          highlighted={typeof stats.channel.participantsCount === 'number'}
        />

        <MetricCard
          label="Постов с кнопками"
          value={formatCount(stats.summary.postsWithButtons)}
          hint="Посты с переходом в miniapp"
          highlighted={stats.summary.postsWithButtons > 0}
        />

        <MetricCard
          label="Комментариев"
          value={formatCount(stats.summary.comments)}
          hint={
            stats.summary.comments > 0
              ? `Авторов: ${formatCount(stats.summary.commentAuthors)}`
              : 'Пока без комментариев'
          }
          highlighted={stats.summary.comments > 0}
        />

        <MetricCard
          label="Предложек"
          value={formatCount(stats.summary.suggestions)}
          hint={
            stats.summary.suggestions > 0
              ? `Авторов: ${formatCount(stats.summary.suggestionAuthors)}`
              : 'Пока без предложений'
          }
          highlighted={stats.summary.suggestions > 0}
        />

        <MetricCard
          label="Авторов комментариев"
          value={formatCount(stats.summary.commentAuthors)}
          hint="Уникальные участники за выбранный период"
          highlighted={stats.summary.commentAuthors > 0}
        />

        <MetricCard
          label="Доставлено админам"
          value={formatCount(stats.summary.suggestionsDelivered)}
          hint={`Не доставлено: ${formatCount(stats.summary.suggestionsFailed)}`}
          highlighted={stats.summary.suggestionsDelivered > 0}
        />
      </section>

      {isEmptyPeriod ? (
        <GlassCard>
          <StatusState
            tone="neutral"
            title="За этот период бот ещё не зафиксировал активность"
            description="Когда появятся комментарии, предложки или посты с кнопками, статистика обновится здесь."
          />
        </GlassCard>
      ) : null}

      <GlassCard className="channel-stats-meta" elevated>
        <article className="channel-stats-meta__item">
          <small>Последняя активность в канале</small>
          <strong>{formatDateTime(stats.channel.lastEventAt)}</strong>
          <p>По данным MAX о самом канале.</p>
        </article>

        <article className="channel-stats-meta__item">
          <small>Последняя активность через бота</small>
          <strong>{formatDateTime(stats.summary.lastBotActivityAt)}</strong>
          <p>Комментарии, предложки и посты с кнопками.</p>
        </article>

        <article className="channel-stats-meta__item">
          <small>
            {stats.channel.isPublic && stats.channel.link ? 'Ссылка на канал' : 'Доступ'}
          </small>
          {stats.channel.isPublic && stats.channel.link ? (
            <a
              href={stats.channel.link}
              target="_blank"
              rel="noreferrer"
              className="channel-stats-meta__link"
            >
              {formatLink(stats.channel.link)}
            </a>
          ) : (
            <strong>{stats.channel.isPublic === false ? 'Канал приватный' : 'Нет данных'}</strong>
          )}
          <p>
            {stats.channel.isPublic && stats.channel.link
              ? 'Открывается напрямую в MAX.'
              : 'Ссылка доступна только для публичных каналов.'}
          </p>
        </article>
      </GlassCard>
    </div>
  );
}
