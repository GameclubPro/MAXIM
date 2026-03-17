import type {
  ChannelStatsBucket,
  ChannelStatsRange,
  ChannelStatsResponse,
  MembershipActivityPage,
} from '@maxim/contracts';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { DashboardHero } from '../components/dashboard/dashboard-hero';
import { MembershipActivityFeed } from '../components/dashboard/membership-activity-feed';
import { StatsMetricCard } from '../components/dashboard/stats-metric-card';
import { GlassCard } from '../components/ui/glass-card';
import { SegmentedControl } from '../components/ui/segmented-control';
import { SkeletonCard } from '../components/ui/skeleton';
import { StatusState } from '../components/ui/status-state';
import { getChannelActivityFeed, getChannelStats } from '../lib/api/channel-stats-client';
import type { ApiTransport } from '../lib/api/transport';
import { cn } from '../lib/cn';
import { readChatTitle, saveChatTitle } from '../lib/chat-titles';
import { buildManagedEntitiesRoute, saveLastEntityId } from '../lib/last-chat';
import { useMembershipActivityFeed } from '../lib/use-membership-activity-feed';

type ChannelStatsRouteState = {
  chatTitle: string;
};

type ChartTab = 'audience' | 'views';

type AudienceChartPoint = {
  x: number;
  y: number;
  joinedTop: number;
  joinedHeight: number;
  leftTop: number;
  leftHeight: number;
};

type ViewChartPoint = {
  x: number;
  y: number;
  height: number;
};

const periodOptions: Array<{ value: ChannelStatsRange; label: string }> = [
  { value: '24h', label: '24ч' },
  { value: '7d', label: '7д' },
  { value: '30d', label: '30д' },
];

const EMPTY_ACTIVITY_PAGE: MembershipActivityPage = {
  items: [],
  hasMore: false,
  nextCursor: null,
};

const audienceTabOptions: Array<{ value: ChartTab; label: string }> = [
  { value: 'audience', label: 'Аудитория' },
  { value: 'views', label: 'Просмотры' },
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

function formatShortDate(value: string | null, bucket: ChannelStatsBucket): string {
  if (!value) {
    return '';
  }

  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    return '';
  }

  if (bucket === 'hour') {
    return new Intl.DateTimeFormat('ru-RU', {
      hour: '2-digit',
      minute: '2-digit',
    }).format(parsed);
  }

  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: 'short',
  }).format(parsed);
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

function resolveChannelStatsLastUpdated(stats: ChannelStatsResponse): string | null {
  const latestAt = stats.activityFeed.items[0]?.createdAt ?? stats.channel.lastEventAt;
  return latestAt ? `Последнее движение аудитории · ${formatDateTime(latestAt)}` : null;
}

function resolveStatusChips(
  stats: ChannelStatsResponse | undefined,
): Array<{ label: string; className: string }> {
  if (!stats) {
    return [];
  }

  if (!stats.meta.maxSnapshotAvailable) {
    return [{ label: 'Снимок MAX недоступен', className: 'chip' }];
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

function hasSecondaryActivity(secondary: ChannelStatsResponse['secondary']): boolean {
  return (
    secondary.postsWithButtons > 0 ||
    secondary.comments > 0 ||
    secondary.suggestions > 0 ||
    secondary.commentAuthors > 0 ||
    secondary.suggestionAuthors > 0 ||
    secondary.suggestionsDelivered > 0 ||
    secondary.suggestionsFailed > 0 ||
    secondary.lastBotActivityAt !== null
  );
}

function buildAudiencePath(points: Array<{ x: number; y: number }>): string {
  if (points.length === 0) {
    return '';
  }

  return points
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
    .join(' ');
}

function buildAudienceChart(stats: ChannelStatsResponse): {
  points: AudienceChartPoint[];
  path: string;
  hasLine: boolean;
  maxMembership: number;
} {
  const series = stats.official.series.participants;
  if (series.length === 0) {
    return {
      points: [],
      path: '',
      hasLine: false,
      maxMembership: 0,
    };
  }

  const width = 320;
  const height = 180;
  const leftPad = 14;
  const rightPad = 14;
  const topPad = 14;
  const bottomPad = 18;
  const baseline = 120;
  const plotWidth = width - leftPad - rightPad;
  const participantValues = series
    .map((item) => item.participantsCount)
    .filter((item): item is number => typeof item === 'number');
  const minParticipants = participantValues.length > 0 ? Math.min(...participantValues) : 0;
  const maxParticipants = participantValues.length > 0 ? Math.max(...participantValues) : 0;
  const participantSpan = Math.max(1, maxParticipants - minParticipants);
  const membershipValues = stats.official.series.membership.flatMap((item) => [
    item.joined,
    item.left ?? 0,
  ]);
  const maxMembership = membershipValues.length > 0 ? Math.max(...membershipValues) : 0;
  const membershipScale = maxMembership > 0 ? 40 / maxMembership : 0;

  const points = series.map((item, index) => {
    const x =
      series.length === 1
        ? width / 2
        : leftPad + (plotWidth * index) / Math.max(1, series.length - 1);
    const participantsY =
      typeof item.participantsCount === 'number'
        ? topPad + ((maxParticipants - item.participantsCount) / participantSpan) * 74
        : baseline;
    const membership = stats.official.series.membership[index];
    const joinedHeight = membership ? membership.joined * membershipScale : 0;
    const leftHeight =
      membership && typeof membership.left === 'number' ? membership.left * membershipScale : 0;

    return {
      x,
      y: participantsY,
      joinedTop: baseline - joinedHeight,
      joinedHeight,
      leftTop: baseline,
      leftHeight,
    };
  });

  return {
    points,
    path: buildAudiencePath(points.map((point) => ({ x: point.x, y: point.y }))),
    hasLine: participantValues.length > 0,
    maxMembership,
  };
}

function buildViewsChart(stats: ChannelStatsResponse): {
  bars: ViewChartPoint[];
  maxViews: number;
} {
  const series = stats.official.series.views;
  if (series.length === 0) {
    return {
      bars: [],
      maxViews: 0,
    };
  }

  const width = 320;
  const height = 180;
  const leftPad = 14;
  const rightPad = 14;
  const topPad = 16;
  const bottomPad = 18;
  const plotWidth = width - leftPad - rightPad;
  const usableHeight = height - topPad - bottomPad;
  const maxViews = Math.max(...series.map((item) => item.views), 0);
  const scale = maxViews > 0 ? usableHeight / maxViews : 0;

  return {
    bars: series.map((item, index) => {
      const x =
        series.length === 1
          ? width / 2
          : leftPad + (plotWidth * index) / Math.max(1, series.length - 1);
      const barHeight = item.views * scale;
      return {
        x,
        y: height - bottomPad - barHeight,
        height: barHeight,
      };
    }),
    maxViews,
  };
}

function MetricCard({
  label,
  value,
  highlighted = false,
}: {
  label: string;
  value: string;
  highlighted?: boolean;
}) {
  return (
    <article className={cn('channel-stats-metric', highlighted && 'is-accent')}>
      <small>{label}</small>
      <strong>{value}</strong>
    </article>
  );
}

function AudienceChart({ stats }: { stats: ChannelStatsResponse }) {
  const chart = buildAudienceChart(stats);
  const labels = stats.official.series.participants;
  const hasLeftBars = stats.official.series.membership.some((item) => (item.left ?? 0) > 0);

  return (
    <div className="channel-stats-graph">
      {chart.points.length === 0 ? (
        <div className="channel-stats-graph__empty">Пока нет данных за период.</div>
      ) : (
        <>
          <svg viewBox="0 0 320 180" className="channel-stats-graph__svg" aria-hidden>
            <line x1="14" y1="120" x2="306" y2="120" className="channel-stats-graph__baseline" />
            {chart.points.map((point, index) => (
              <g key={labels[index]?.at ?? index}>
                <rect
                  x={point.x - 6}
                  y={point.joinedTop}
                  width="12"
                  height={point.joinedHeight}
                  rx="5"
                  className="channel-stats-graph__bar channel-stats-graph__bar--joined"
                />
                {point.leftHeight > 0 ? (
                  <rect
                    x={point.x - 6}
                    y={point.leftTop}
                    width="12"
                    height={point.leftHeight}
                    rx="5"
                    className="channel-stats-graph__bar channel-stats-graph__bar--left"
                  />
                ) : null}
              </g>
            ))}
            {chart.hasLine ? <path d={chart.path} className="channel-stats-graph__line" /> : null}
            {chart.hasLine
              ? chart.points.map((point, index) => (
                  <circle
                    key={labels[index]?.at ?? index}
                    cx={point.x}
                    cy={point.y}
                    r="3.5"
                    className="channel-stats-graph__dot"
                  />
                ))
              : null}
          </svg>

          <div className="channel-stats-graph__legend">
            <span>
              <i className="is-line" />
              Участники
            </span>
            <span>
              <i className="is-joined" />
              Пришло
            </span>
            {hasLeftBars ? (
              <span>
                <i className="is-left" />
                Ушло
              </span>
            ) : null}
          </div>

          <div className="channel-stats-graph__labels">
            {labels.map((item, index) => (
              <small key={`${item.at}-${index}`}>
                {formatShortDate(item.at, stats.period.bucket)}
              </small>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function ViewsChart({ stats }: { stats: ChannelStatsResponse }) {
  const chart = buildViewsChart(stats);
  const labels = stats.official.series.views;

  return (
    <div className="channel-stats-graph">
      {chart.bars.length === 0 ? (
        <div className="channel-stats-graph__empty">Пока нет постов за период.</div>
      ) : (
        <>
          <svg viewBox="0 0 320 180" className="channel-stats-graph__svg" aria-hidden>
            <line x1="14" y1="162" x2="306" y2="162" className="channel-stats-graph__baseline" />
            {chart.bars.map((bar, index) => (
              <rect
                key={labels[index]?.at ?? index}
                x={bar.x - 9}
                y={bar.y}
                width="18"
                height={Math.max(4, bar.height)}
                rx="6"
                className="channel-stats-graph__bar channel-stats-graph__bar--views"
              />
            ))}
          </svg>

          <div className="channel-stats-graph__legend">
            <span>
              <i className="is-views" />
              Просмотры постов
            </span>
          </div>

          <div className="channel-stats-graph__labels">
            {labels.map((item, index) => (
              <small key={`${item.at}-${index}`}>
                {formatShortDate(item.at, stats.period.bucket)}
              </small>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function ChannelStatsPage({ api }: { api: ApiTransport }) {
  const { chatId = '' } = useParams();
  const location = useLocation();
  const routeState = getRouteState(location.state);
  const [range, setRange] = useState<ChannelStatsRange>('7d');
  const [chartTab, setChartTab] = useState<ChartTab>('audience');

  const statsQuery = useQuery({
    queryKey: ['channel-stats', chatId, range],
    queryFn: () => getChannelStats(api, chatId, range),
    enabled: Boolean(chatId),
  });

  useEffect(() => {
    if (!chatId) {
      return;
    }

    saveLastEntityId('channel', chatId);
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

  useEffect(() => {
    if (!statsQuery.data?.meta.viewsAvailable && chartTab === 'views') {
      setChartTab('audience');
    }
  }, [chartTab, statsQuery.data?.meta.viewsAvailable]);

  const activityFeed = useMembershipActivityFeed({
    range,
    initialPage: statsQuery.data?.activityFeed ?? EMPTY_ACTIVITY_PAGE,
    loadPage: (query) => getChannelActivityFeed(api, chatId, query),
  });

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

  if (statsQuery.isLoading && !statsQuery.data) {
    return (
      <div className="page-stack page-enter">
        <GlassCard className="settings-section">
          <SkeletonCard lines={12} />
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
  const chartTabs = stats.meta.viewsAvailable ? audienceTabOptions : audienceTabOptions.slice(0, 1);
  const effectiveChartTab: ChartTab = stats.meta.viewsAvailable ? chartTab : 'audience';
  const showSecondaryActivity = hasSecondaryActivity(stats.secondary);
  const periodCaption = formatPeriodCaption(stats.period.from, stats.period.to);

  return (
    <div className="stats-dashboard channel-stats-screen page-enter">
      <DashboardHero
        accent="channel"
        eyebrow="Статистика канала"
        title={resolvedTitle}
        summary={`${periodCaption} · ${formatCount(stats.channel.participantsCount)} участников`}
        lastUpdated={resolveChannelStatsLastUpdated(stats)}
        badge={statsQuery.isFetching ? 'Обновляем' : null}
        chips={statusChips}
        backTo={buildManagedEntitiesRoute('channel')}
        rangeControl={
          <SegmentedControl
            value={range}
            options={periodOptions}
            onChange={setRange}
          />
        }
      />

      <section className="stats-dashboard__metrics" aria-label="Ключевые метрики канала">
        <StatsMetricCard
          label="Участники"
          value={formatCount(stats.channel.participantsCount)}
          detail="Актуальный снимок MAX"
          tone={typeof stats.channel.participantsCount === 'number' ? 'accent' : 'neutral'}
        />
        <StatsMetricCard
          label="Пришло"
          value={formatCount(stats.official.audience.joined)}
          detail="Подписались за период"
          tone="success"
        />
        <StatsMetricCard
          label="Ушло"
          value={formatCount(stats.official.audience.left)}
          detail="Отписались за период"
          tone="warning"
        />
        <StatsMetricCard
          label="Чистый рост"
          value={formatCount(stats.official.audience.net)}
          detail="Разница между входами и выходами"
          tone={(stats.official.audience.net ?? 0) > 0 ? 'success' : 'neutral'}
        />
        <StatsMetricCard
          label="Просмотры"
          value={stats.meta.viewsAvailable ? formatCount(stats.official.content.views) : '—'}
          detail="Сумма просмотров постов"
          tone={stats.official.content.views > 0 ? 'accent' : 'neutral'}
        />
        <StatsMetricCard
          label="Реакции"
          value={formatCount(stats.official.content.reactions)}
          detail="Все реакции на посты"
          tone={stats.official.content.reactions > 0 ? 'accent' : 'neutral'}
        />
        <StatsMetricCard
          label="Посты"
          value={formatCount(stats.official.content.posts)}
          detail="Опубликовано за период"
          tone={stats.official.content.posts > 0 ? 'accent' : 'neutral'}
        />
      </section>

      <GlassCard className="stats-panel channel-stats-panel channel-stats-panel--chart" elevated>
        <div className="channel-stats-panel__head">
          <div>
            <strong>Динамика</strong>
            <small>
              {effectiveChartTab === 'audience'
                ? 'Аудитория и churn по периодам.'
                : 'Суммарные просмотры опубликованных постов.'}
            </small>
          </div>

          <SegmentedControl
            value={effectiveChartTab}
            options={chartTabs}
            onChange={setChartTab}
            className="channel-stats-panel__switch"
          />
        </div>

        {effectiveChartTab === 'audience' ? (
          <AudienceChart stats={stats} />
        ) : (
          <ViewsChart stats={stats} />
        )}
      </GlassCard>

      <MembershipActivityFeed
        title="Движение аудитории"
        subtitle="Последние входы и выходы подписчиков канала."
        joinedLabel="каналу"
        leftLabel="канал"
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

      {stats.official.content.topReactions.length > 0 ? (
        <GlassCard className="channel-stats-top-reactions stats-panel" elevated>
          <div className="channel-stats-panel__head">
            <strong>Топ реакций</strong>
            <small>Самые частые реакции на посты за период.</small>
          </div>

          <div className="channel-stats-top-reactions__list">
            {stats.official.content.topReactions.map((reaction) => (
              <span key={reaction.emoji} className="chip">
                {reaction.emoji} {formatCount(reaction.count)}
              </span>
            ))}
          </div>
        </GlassCard>
      ) : null}

      <GlassCard className="channel-stats-secondary stats-panel" elevated>
        <div className="channel-stats-panel__head">
          <div>
            <strong>Через приложение</strong>
            <small>Комментарии, предложки и автодоставка админам.</small>
          </div>
        </div>

        <div className="channel-stats-secondary__grid">
          <article>
            <small>Комментарии</small>
            <strong>{formatCount(stats.secondary.comments)}</strong>
            <span>Авторов {formatCount(stats.secondary.commentAuthors)}</span>
          </article>
          <article>
            <small>Идеи</small>
            <strong>{formatCount(stats.secondary.suggestions)}</strong>
            <span>Авторов {formatCount(stats.secondary.suggestionAuthors)}</span>
          </article>
          <article>
            <small>Доставлено админам</small>
            <strong>{formatCount(stats.secondary.suggestionsDelivered)}</strong>
            <span>Ошибок {formatCount(stats.secondary.suggestionsFailed)}</span>
          </article>
          <article>
            <small>Постов с кнопками</small>
            <strong>{formatCount(stats.secondary.postsWithButtons)}</strong>
          </article>
        </div>

        {!showSecondaryActivity ? (
          <p className="channel-stats-secondary__empty">Активности за период пока нет.</p>
        ) : null}
      </GlassCard>

      <GlassCard className="channel-stats-meta stats-panel" elevated>
        {stats.channel.lastEventAt ? (
          <article className="channel-stats-meta__item">
            <small>Активность в канале</small>
            <strong>{formatDateTime(stats.channel.lastEventAt)}</strong>
          </article>
        ) : null}

        {stats.official.content.lastPublishedAt ? (
          <article className="channel-stats-meta__item">
            <small>Последний пост</small>
            <strong>{formatDateTime(stats.official.content.lastPublishedAt)}</strong>
          </article>
        ) : null}

        {stats.secondary.lastBotActivityAt ? (
          <article className="channel-stats-meta__item">
            <small>Через приложение</small>
            <strong>{formatDateTime(stats.secondary.lastBotActivityAt)}</strong>
          </article>
        ) : null}

        <article className="channel-stats-meta__item">
          <small>Ссылка</small>
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
        </article>
      </GlassCard>
    </div>
  );
}
