import type {
  ChannelStatsBucket,
  ChannelStatsRange,
  ChannelStatsResponse,
  MembershipActivityPage,
} from '@maxim/contracts';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { MembershipActivityFeed } from '../components/dashboard/membership-activity-feed';
import { BackChevronIcon } from '../components/ui/entity-header-icons';
import { GlassCard } from '../components/ui/glass-card';
import { SegmentedControl } from '../components/ui/segmented-control';
import { SkeletonCard } from '../components/ui/skeleton';
import { StatusState } from '../components/ui/status-state';
import { getChannelActivityFeed, getChannelStats } from '../lib/api/channel-stats-client';
import type { ApiTransport } from '../lib/api/transport';
import { readChatTitle, saveChatTitle } from '../lib/chat-titles';
import { buildManagedEntitiesRoute, saveLastEntityId } from '../lib/last-chat';
import { useAutoHideHeader } from '../lib/use-auto-hide-header';
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
  return (
    stats.activityFeed.items[0]?.createdAt ??
    stats.channel.lastEventAt ??
    stats.official.content.lastPublishedAt ??
    stats.secondary.lastBotActivityAt
  );
}

function formatSignedCount(value: number | null): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '—';
  }

  if (value > 0) {
    return `+${value}`;
  }

  return String(value);
}

function formatPercent(value: number | null): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '—';
  }

  return `${new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: value > 0 && value < 10 ? 1 : 0,
    maximumFractionDigits: value > 0 && value < 10 ? 1 : 0,
  }).format(value)}%`;
}

function resolveChannelStateLabel(stats: ChannelStatsResponse): string {
  if (!stats.meta.maxSnapshotAvailable) {
    return 'Снимок MAX недоступен';
  }

  const parts: string[] = [];

  if (stats.channel.status) {
    parts.push(stats.channel.status === 'active' ? 'Активен' : 'Неактивен');
  }

  if (stats.channel.isPublic !== null) {
    parts.push(stats.channel.isPublic ? 'Публичный' : 'Приватный');
  }

  return parts.join(' · ') || 'Статус не определён';
}

function resolveHeroNote(stats: ChannelStatsResponse): string {
  const lastUpdated = resolveChannelStatsLastUpdated(stats);
  if (lastUpdated) {
    return `Последнее движение ${formatDateTime(lastUpdated)}`;
  }

  return stats.meta.maxSnapshotAvailable ? 'Актуальный снимок MAX' : 'Снимок MAX недоступен';
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

  if (points.length === 1) {
    const [point] = points;
    return `M ${point.x.toFixed(2)} ${point.y.toFixed(2)}`;
  }

  let path = `M ${points[0]!.x.toFixed(2)} ${points[0]!.y.toFixed(2)}`;
  for (let index = 0; index < points.length - 1; index += 1) {
    const current = points[index]!;
    const next = points[index + 1]!;
    const deltaX = (next.x - current.x) / 2;

    path += ` C ${(current.x + deltaX * 0.7).toFixed(2)} ${current.y.toFixed(2)} ${(
      next.x -
      deltaX * 0.7
    ).toFixed(2)} ${next.y.toFixed(2)} ${next.x.toFixed(2)} ${next.y.toFixed(2)}`;
  }

  return path;
}

function buildAudienceAreaPath(
  linePath: string,
  points: Array<{ x: number; y: number }>,
  floorY: number,
): string {
  if (!linePath || points.length === 0) {
    return '';
  }

  const firstPoint = points[0]!;
  const lastPoint = points[points.length - 1]!;
  return `${linePath} L ${lastPoint.x.toFixed(2)} ${floorY.toFixed(2)} L ${firstPoint.x.toFixed(
    2,
  )} ${floorY.toFixed(2)} Z`;
}

function buildAudienceChart(stats: ChannelStatsResponse): {
  points: AudienceChartPoint[];
  linePath: string;
  areaPath: string;
  hasLine: boolean;
  guideYs: number[];
  dividerY: number;
  barsBaseline: number;
} {
  const series = stats.official.series.participants;
  if (series.length === 0) {
    return {
      points: [],
      linePath: '',
      areaPath: '',
      hasLine: false,
      guideYs: [],
      dividerY: 92,
      barsBaseline: 132,
    };
  }

  const width = 320;
  const leftPad = 14;
  const rightPad = 14;
  const lineTop = 16;
  const lineBottom = 74;
  const lineFloor = 84;
  const dividerY = 92;
  const barsBaseline = 132;
  const joinedPeakHeight = 28;
  const leftPeakHeight = 16;
  const plotWidth = width - leftPad - rightPad;
  const participantValues = series
    .map((item) => item.participantsCount)
    .filter((item): item is number => typeof item === 'number');
  const minParticipants = participantValues.length > 0 ? Math.min(...participantValues) : 0;
  const maxParticipants = participantValues.length > 0 ? Math.max(...participantValues) : 0;
  const participantSpan = Math.max(1, maxParticipants - minParticipants);
  const participantPadding = Math.max(1, participantSpan * 0.16);
  const participantMin = minParticipants - participantPadding;
  const participantMax = maxParticipants + participantPadding;
  const participantRange = Math.max(1, participantMax - participantMin);
  const membershipSeries = stats.official.series.membership;
  const maxJoined = Math.max(...membershipSeries.map((item) => item.joined), 0);
  const maxLeft = Math.max(...membershipSeries.map((item) => item.left ?? 0), 0);
  const joinedScale = maxJoined > 0 ? joinedPeakHeight / maxJoined : 0;
  const leftScale = maxLeft > 0 ? leftPeakHeight / maxLeft : 0;

  const points = series.map((item, index) => {
    const x =
      series.length === 1
        ? width / 2
        : leftPad + (plotWidth * index) / Math.max(1, series.length - 1);
    const participantsY =
      typeof item.participantsCount === 'number'
        ? lineTop +
          ((participantMax - item.participantsCount) / participantRange) * (lineBottom - lineTop)
        : lineBottom;
    const membership = stats.official.series.membership[index];
    const joinedHeight = membership ? membership.joined * joinedScale : 0;
    const leftHeight =
      membership && typeof membership.left === 'number' ? membership.left * leftScale : 0;

    return {
      x,
      y: participantsY,
      joinedTop: barsBaseline - joinedHeight,
      joinedHeight,
      leftTop: barsBaseline,
      leftHeight,
    };
  });

  const linePath = buildAudiencePath(points.map((point) => ({ x: point.x, y: point.y })));

  return {
    points,
    linePath,
    areaPath: buildAudienceAreaPath(
      linePath,
      points.map((point) => ({ x: point.x, y: point.y })),
      lineFloor,
    ),
    hasLine: participantValues.length > 0,
    guideYs: [lineTop, Math.round((lineTop + lineBottom) / 2), lineBottom],
    dividerY,
    barsBaseline,
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
          <div className="channel-stats-graph__canvas channel-stats-graph__canvas--audience">
            <svg viewBox="0 0 320 180" className="channel-stats-graph__svg" aria-hidden>
              {chart.guideYs.map((y) => (
                <line
                  key={`guide-${y}`}
                  x1="14"
                  y1={y}
                  x2="306"
                  y2={y}
                  className="channel-stats-graph__grid"
                />
              ))}
              <line
                x1="14"
                y1={chart.dividerY}
                x2="306"
                y2={chart.dividerY}
                className="channel-stats-graph__divider"
              />
              <line
                x1="14"
                y1={chart.barsBaseline}
                x2="306"
                y2={chart.barsBaseline}
                className="channel-stats-graph__baseline"
              />
              {chart.hasLine ? (
                <path d={chart.areaPath} className="channel-stats-graph__area" />
              ) : null}
              {chart.points.map((point, index) => (
                <g key={labels[index]?.at ?? index}>
                  <rect
                    x={point.x - 5}
                    y={point.joinedTop}
                    width="10"
                    height={point.joinedHeight}
                    rx="4.5"
                    className="channel-stats-graph__bar channel-stats-graph__bar--joined"
                  />
                  {point.leftHeight > 0 ? (
                    <rect
                      x={point.x - 5}
                      y={point.leftTop}
                      width="10"
                      height={point.leftHeight}
                      rx="4.5"
                      className="channel-stats-graph__bar channel-stats-graph__bar--left"
                    />
                  ) : null}
                </g>
              ))}
              {chart.hasLine ? (
                <path d={chart.linePath} className="channel-stats-graph__line" />
              ) : null}
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
          </div>

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
          <div className="channel-stats-graph__canvas">
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
          </div>

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
  const { isCompact: isHeaderCompact, isHidden: isHeaderHidden } = useAutoHideHeader({
    compactAfter: 12,
    hideAfter: 72,
    hideDistance: 44,
    revealDistance: 6,
  });

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

  const chartTabs = stats.meta.viewsAvailable ? audienceTabOptions : audienceTabOptions.slice(0, 1);
  const effectiveChartTab: ChartTab = stats.meta.viewsAvailable ? chartTab : 'audience';
  const showSecondaryActivity = hasSecondaryActivity(stats.secondary);
  const periodCaption = formatPeriodCaption(stats.period.from, stats.period.to);
  const audienceJoined = stats.official.audience.joined ?? 0;
  const audienceLeft = stats.official.audience.left ?? 0;
  const audienceNet = stats.official.audience.net ?? audienceJoined - audienceLeft;
  const netTone = audienceNet > 0 ? 'success' : audienceNet < 0 ? 'danger' : 'neutral';
  const movementTotal = audienceJoined + audienceLeft;
  const joinedShare = movementTotal ? Math.round((audienceJoined / movementTotal) * 100) : 50;
  const leftShare = movementTotal ? 100 - joinedShare : 50;
  const averageViewsPerPost =
    stats.meta.viewsAvailable && stats.official.content.posts > 0
      ? Math.round(stats.official.content.views / stats.official.content.posts)
      : null;
  const reactionsPerPost =
    stats.official.content.posts > 0
      ? Math.round(stats.official.content.reactions / stats.official.content.posts)
      : null;
  const engagementRate =
    stats.meta.viewsAvailable && stats.official.content.views > 0
      ? (stats.official.content.reactions / stats.official.content.views) * 100
      : null;
  const chartTitle = effectiveChartTab === 'audience' ? 'Динамика аудитории' : 'Охват публикаций';
  const chartSummary =
    effectiveChartTab === 'audience'
      ? `${formatCount(audienceJoined)} вошли · ${formatCount(audienceLeft)} вышли`
      : stats.meta.viewsAvailable
        ? `${formatCount(stats.official.content.views)} просмотров · ${formatCount(
            stats.official.content.posts,
          )} постов`
        : 'Официальные просмотры MAX недоступны';
  const linkLabel =
    stats.channel.isPublic && stats.channel.link
      ? formatLink(stats.channel.link)
      : stats.channel.isPublic === false
        ? 'Канал приватный'
        : 'Нет данных';

  return (
    <div className="channel-insights page-enter">
      <header
        className={`channel-insights__appbar ${isHeaderCompact ? 'is-compact' : ''} ${
          isHeaderHidden ? 'is-hidden' : ''
        }`}
      >
        <div className="channel-insights__appbar-bar">
          <Link
            to={buildManagedEntitiesRoute('channel')}
            className="channel-insights__back"
            aria-label="К списку каналов"
          >
            <BackChevronIcon />
          </Link>

          <div className="channel-insights__appbar-copy">
            <strong>Статистика</strong>
            <span className="channel-insights__appbar-label">{resolvedTitle}</span>
          </div>

          <div className="channel-insights__appbar-side">
            {statsQuery.isFetching ? (
              <span className="channel-insights__pulse" aria-label="Обновляем" title="Обновляем" />
            ) : (
              <span
                className="channel-insights__pulse channel-insights__pulse--idle"
                aria-hidden="true"
              />
            )}
          </div>
        </div>
      </header>

      <div className="channel-insights__body">
        <section className="channel-insights__summary stagger-in" aria-label="Сводка по каналу">
          <div className="channel-insights__summary-head">
            <div className="channel-insights__summary-copy">
              <span className="channel-insights__eyebrow">Статистика канала</span>
              <h2>{resolvedTitle}</h2>
              <p>{`${resolveChannelStateLabel(stats)} · ${periodCaption}`}</p>
            </div>

            <SegmentedControl
              value={range}
              options={periodOptions}
              onChange={setRange}
              className="channel-insights__range"
            />
          </div>

          <article className="channel-insights__hero-card">
            <div className="channel-insights__hero-copy">
              <small>Участники сейчас</small>
              <strong>{formatCount(stats.channel.participantsCount)}</strong>
              <span>{resolveHeroNote(stats)}</span>
            </div>

            <div
              className={`channel-insights__hero-delta channel-insights__hero-delta--${netTone}`}
            >
              <small>За период</small>
              <strong>{formatSignedCount(audienceNet)}</strong>
            </div>
          </article>

          <article className="channel-insights__ledger-card">
            <div className="channel-insights__ledger-grid">
              <article
                className={`channel-insights__ledger-metric channel-insights__ledger-metric--${netTone}`}
              >
                <small>Прирост</small>
                <strong>{formatSignedCount(audienceNet)}</strong>
                <span>
                  {formatCount(audienceJoined)} вошли · {formatCount(audienceLeft)} вышли
                </span>
              </article>

              <article className="channel-insights__ledger-metric channel-insights__ledger-metric--accent">
                <small>Охват</small>
                <strong>
                  {stats.meta.viewsAvailable
                    ? formatCount(stats.official.content.views)
                    : formatCount(stats.official.content.posts)}
                </strong>
                <span>
                  {stats.meta.viewsAvailable
                    ? averageViewsPerPost !== null
                      ? `${formatCount(averageViewsPerPost)} в среднем на пост`
                      : 'Постов за период нет'
                    : `${formatCount(stats.official.content.posts)} постов за период`}
                </span>
              </article>

              <article className="channel-insights__ledger-metric channel-insights__ledger-metric--neutral">
                <small>Реакции</small>
                <strong>{formatCount(stats.official.content.reactions)}</strong>
                <span>
                  {engagementRate !== null
                    ? `ER ${formatPercent(engagementRate)} · ${formatCount(
                        reactionsPerPost,
                      )} на пост`
                    : reactionsPerPost !== null
                      ? `${formatCount(reactionsPerPost)} на пост`
                      : 'За период без публикаций'}
                </span>
              </article>
            </div>

            <div className="channel-insights__ledger-bar" aria-hidden="true">
              <span style={{ width: `${joinedShare}%` }} />
            </div>

            <div className="channel-insights__ledger-meta">
              <small>Вошли {joinedShare}%</small>
              <small>Вышли {leftShare}%</small>
              <small>{periodCaption}</small>
            </div>
          </article>
        </section>

        <section className="channel-insights__panel channel-insights__panel--chart">
          <div className="channel-insights__panel-head">
            <div className="channel-insights__panel-copy">
              <strong>{chartTitle}</strong>
              <small>{chartSummary}</small>
            </div>

            <SegmentedControl
              value={effectiveChartTab}
              options={chartTabs}
              onChange={setChartTab}
              className="channel-insights__switch"
            />
          </div>

          {effectiveChartTab === 'audience' ? (
            <AudienceChart stats={stats} />
          ) : (
            <ViewsChart stats={stats} />
          )}
        </section>

        <MembershipActivityFeed
          title="Движение подписчиков"
          subtitle="Последние входы и выходы по дням."
          variant="immersive"
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

        <div className="channel-insights__secondary-layout">
          {stats.official.content.topReactions.length > 0 ? (
            <section className="channel-insights__panel channel-insights__panel--reactions channel-insights__panel--warm">
              <div className="channel-insights__panel-head">
                <div className="channel-insights__panel-copy">
                  <strong>Топ реакций</strong>
                  <small>Что сработало лучше всего за период.</small>
                </div>
              </div>

              <div className="channel-insights__reaction-list">
                {stats.official.content.topReactions.map((reaction) => (
                  <span key={reaction.emoji} className="channel-insights__reaction-pill">
                    <b>{reaction.emoji}</b>
                    <small>{formatCount(reaction.count)}</small>
                  </span>
                ))}
              </div>
            </section>
          ) : null}

          <section className="channel-insights__panel channel-insights__panel--secondary channel-insights__panel--cool">
            <div className="channel-insights__panel-head">
              <div className="channel-insights__panel-copy">
                <strong>Через приложение</strong>
                <small>Комментарии, идеи и доставка админам.</small>
              </div>
            </div>

            <div className="channel-insights__secondary-grid">
              <article className="channel-insights__secondary-metric channel-insights__secondary-metric--comments">
                <small>Комментарии</small>
                <strong>{formatCount(stats.secondary.comments)}</strong>
                <span>Авторов {formatCount(stats.secondary.commentAuthors)}</span>
              </article>

              <article className="channel-insights__secondary-metric channel-insights__secondary-metric--ideas">
                <small>Идеи</small>
                <strong>{formatCount(stats.secondary.suggestions)}</strong>
                <span>Авторов {formatCount(stats.secondary.suggestionAuthors)}</span>
              </article>

              <article className="channel-insights__secondary-metric channel-insights__secondary-metric--delivery">
                <small>Доставлено</small>
                <strong>{formatCount(stats.secondary.suggestionsDelivered)}</strong>
                <span>Ошибок {formatCount(stats.secondary.suggestionsFailed)}</span>
              </article>

              <article className="channel-insights__secondary-metric channel-insights__secondary-metric--buttons">
                <small>Посты с кнопками</small>
                <strong>{formatCount(stats.secondary.postsWithButtons)}</strong>
                <span>Через мини-приложение</span>
              </article>
            </div>

            {!showSecondaryActivity ? (
              <p className="channel-insights__empty">Активности за период пока нет.</p>
            ) : null}
          </section>
        </div>

        <section className="channel-insights__panel channel-insights__panel--meta channel-insights__panel--neutral">
          <div className="channel-insights__panel-head">
            <div className="channel-insights__panel-copy">
              <strong>Контекст канала</strong>
              <small>Последние точки активности и ссылка на канал.</small>
            </div>
          </div>

          <div className="channel-insights__facts">
            {stats.channel.lastEventAt ? (
              <article className="channel-insights__fact channel-insights__fact--activity">
                <small>Активность</small>
                <strong>{formatDateTime(stats.channel.lastEventAt)}</strong>
              </article>
            ) : null}

            {stats.official.content.lastPublishedAt ? (
              <article className="channel-insights__fact channel-insights__fact--published">
                <small>Последний пост</small>
                <strong>{formatDateTime(stats.official.content.lastPublishedAt)}</strong>
              </article>
            ) : null}

            {stats.secondary.lastBotActivityAt ? (
              <article className="channel-insights__fact channel-insights__fact--app">
                <small>Через приложение</small>
                <strong>{formatDateTime(stats.secondary.lastBotActivityAt)}</strong>
              </article>
            ) : null}

            <article className="channel-insights__fact channel-insights__fact--link">
              <small>Ссылка</small>
              {stats.channel.isPublic && stats.channel.link ? (
                <a
                  href={stats.channel.link}
                  target="_blank"
                  rel="noreferrer"
                  className="channel-insights__fact-link"
                >
                  {linkLabel}
                </a>
              ) : (
                <strong>{linkLabel}</strong>
              )}
            </article>
          </div>
        </section>
      </div>
    </div>
  );
}
