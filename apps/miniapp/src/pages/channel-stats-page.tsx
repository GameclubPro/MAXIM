import type {
  ChannelStatsBucket,
  ChannelStatsRange,
  ChannelStatsResponse,
  MembershipActivityItem,
  MembershipActivityPage,
} from '@maxim/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import '../styles/lazy-pages.css';
import '../styles/dashboard-events.css';
import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { MembershipActivityFeed } from '../components/dashboard/membership-activity-feed';
import { CompactStickyHeader } from '../components/ui/compact-sticky-header';
import { EntityAvatar } from '../components/ui/entity-avatar';
import { GlassCard } from '../components/ui/glass-card';
import { SegmentedControl } from '../components/ui/segmented-control';
import { SkeletonCard } from '../components/ui/skeleton';
import { StatusState } from '../components/ui/status-state';
import { useToast } from '../components/ui/toast';
import {
  getChannelActivityFeed,
  getChannelStats,
  handoffChannelMemberProfile,
  handoffChannelMemberProfileKeepalive,
} from '../lib/api/channel-stats-client';
import type { ApiTransport } from '../lib/api/transport';
import { readChatTitle, saveChatTitle } from '../lib/chat-titles';
import { buildManagedEntitiesRoute, saveLastEntityId } from '../lib/last-chat';
import { openMaxBotLinkAndClose } from '../lib/max-bridge';
import { queryKeys } from '../lib/query-keys';
import { useAutoHideHeader } from '../lib/use-auto-hide-header';
import { useMembershipActivityFeed } from '../lib/use-membership-activity-feed';

type ChannelStatsRouteState = {
  chatTitle: string;
  avatarUrl: string | null;
};

type ChartTab = 'audience' | 'views' | 'posts';

type ChartInsightTone = 'accent' | 'success' | 'danger' | 'warning' | 'neutral';

type ChartInsight = {
  tone: ChartInsightTone;
  label: string;
  value: string;
  detail: string;
};

type AudienceChartPoint = {
  at: string;
  participantsCount: number | null;
  joined: number;
  left: number;
  x: number;
  y: number;
  joinedTop: number;
  joinedHeight: number;
  leftTop: number;
  leftHeight: number;
};

type ViewChartPoint = {
  at: string;
  views: number;
  cumulativeViews: number;
  x: number;
  y: number;
  height: number;
  cumulativeY: number;
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
  { value: 'posts', label: 'Посты' },
];

function getRouteState(state: unknown): ChannelStatsRouteState {
  if (!state || typeof state !== 'object') {
    return {
      chatTitle: '',
      avatarUrl: null,
    };
  }

  const row = state as Record<string, unknown>;
  return {
    chatTitle:
      typeof row.chatTitle === 'string' && row.chatTitle.trim() ? row.chatTitle.trim() : '',
    avatarUrl:
      typeof row.avatarUrl === 'string' && row.avatarUrl.trim() ? row.avatarUrl.trim() : null,
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

function formatChartDetailDate(value: string | null, bucket: ChannelStatsBucket): string {
  if (!value) {
    return 'Нет данных';
  }

  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    return 'Нет данных';
  }

  if (bucket === 'hour') {
    return new Intl.DateTimeFormat('ru-RU', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    }).format(parsed);
  }

  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: 'long',
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
    return formatDateTime(lastUpdated);
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function resolveSparseLabelIndices(length: number, activeIndex: number): Set<number> {
  if (length <= 4) {
    return new Set(Array.from({ length }, (_, index) => index));
  }

  const lastIndex = Math.max(0, length - 1);
  const anchors = [
    0,
    Math.round(lastIndex / 3),
    Math.round((lastIndex * 2) / 3),
    lastIndex,
    clamp(activeIndex, 0, lastIndex),
  ];

  return new Set(anchors);
}

function resolveChartIndexFromClientX(
  clientX: number,
  rect: DOMRect,
  pointsLength: number,
): number {
  if (pointsLength <= 1) {
    return 0;
  }

  const ratio = clamp((clientX - rect.left) / Math.max(rect.width, 1), 0, 1);
  return Math.round(ratio * (pointsLength - 1));
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

function findPeakIndex<TItem>(items: TItem[], resolveValue: (item: TItem) => number): number {
  let peakIndex = -1;
  let peakValue = Number.NEGATIVE_INFINITY;

  items.forEach((item, index) => {
    const value = resolveValue(item);
    if (value > peakValue) {
      peakValue = value;
      peakIndex = index;
    }
  });

  return peakIndex;
}

function getFirstFiniteParticipant(points: AudienceChartPoint[]): number | null {
  for (const point of points) {
    if (typeof point.participantsCount === 'number') {
      return point.participantsCount;
    }
  }

  return null;
}

function getLastFiniteParticipant(points: AudienceChartPoint[]): number | null {
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const point = points[index];
    if (point && typeof point.participantsCount === 'number') {
      return point.participantsCount;
    }
  }

  return null;
}

function buildAudienceInsights(
  stats: ChannelStatsResponse,
  points: AudienceChartPoint[],
): ChartInsight[] {
  const periodNet =
    stats.official.audience.net ??
    stats.official.audience.joined - (stats.official.audience.left ?? 0);
  const firstParticipants = getFirstFiniteParticipant(points);
  const lastParticipants = getLastFiniteParticipant(points);
  const participantTrend =
    firstParticipants !== null && lastParticipants !== null
      ? lastParticipants - firstParticipants
      : null;
  const peakJoinedPoint = points[findPeakIndex(points, (point) => point.joined)] ?? null;
  const peakLeftPoint = points[findPeakIndex(points, (point) => point.left)] ?? null;
  const churn = stats.official.audience.joined + (stats.official.audience.left ?? 0);

  const insights: ChartInsight[] = [
    {
      tone: periodNet > 0 ? 'success' : periodNet < 0 ? 'danger' : 'neutral',
      label: 'Баланс',
      value: formatSignedCount(periodNet),
      detail: `${formatCount(stats.official.audience.joined)} вошли за период`,
    },
  ];

  if (participantTrend !== null) {
    insights.push({
      tone: participantTrend > 0 ? 'accent' : participantTrend < 0 ? 'warning' : 'neutral',
      label: 'Темп',
      value: formatSignedCount(participantTrend),
      detail: 'по снимкам MAX',
    });
  }

  if (peakJoinedPoint && peakJoinedPoint.joined > 0) {
    insights.push({
      tone: 'success',
      label: 'Пик входа',
      value: formatCount(peakJoinedPoint.joined),
      detail: formatShortDate(peakJoinedPoint.at, stats.period.bucket),
    });
  }

  if (peakLeftPoint && peakLeftPoint.left > 0) {
    insights.push({
      tone: 'danger',
      label: 'Отток',
      value: formatCount(peakLeftPoint.left),
      detail: formatShortDate(peakLeftPoint.at, stats.period.bucket),
    });
  } else if (churn > 0) {
    insights.push({
      tone: 'neutral',
      label: 'Движение',
      value: formatCount(churn),
      detail: 'входы и выходы',
    });
  }

  return insights.slice(0, 4);
}

function buildViewsInsights(
  stats: ChannelStatsResponse,
  bars: ViewChartPoint[],
  averageViews: number,
): ChartInsight[] {
  const peakBar = bars[findPeakIndex(bars, (bar) => bar.views)] ?? null;
  const cumulativeViews = bars[bars.length - 1]?.cumulativeViews ?? stats.official.content.views;
  const posts = stats.official.content.posts;
  const reactions = stats.official.content.reactions;

  return [
    {
      tone: 'accent',
      label: 'Пик',
      value: formatCount(peakBar?.views ?? 0),
      detail: peakBar ? formatShortDate(peakBar.at, stats.period.bucket) : 'нет данных',
    },
    {
      tone: 'neutral',
      label: 'Среднее',
      value: formatCount(averageViews),
      detail: 'на точку графика',
    },
    {
      tone: 'success',
      label: 'Накоплено',
      value: formatCount(cumulativeViews),
      detail: 'по периоду',
    },
    {
      tone: reactions > 0 ? 'warning' : 'neutral',
      label: 'Контент',
      value: formatCount(posts),
      detail: `${formatCount(reactions)} реакций`,
    },
  ];
}

function ChartInsightStrip({ insights }: { insights: ChartInsight[] }) {
  if (insights.length === 0) {
    return null;
  }

  return (
    <div className="channel-stats-graph__insights" aria-label="Ключевые точки графика">
      {insights.map((insight) => (
        <span
          key={`${insight.label}-${insight.value}-${insight.detail}`}
          className={`channel-stats-graph__insight channel-stats-graph__insight--${insight.tone}`}
        >
          <small>{insight.label}</small>
          <strong>{insight.value}</strong>
          <em>{insight.detail}</em>
        </span>
      ))}
    </div>
  );
}

function buildAudienceChart(stats: ChannelStatsResponse): {
  points: AudienceChartPoint[];
  linePath: string;
  areaPath: string;
  hasLine: boolean;
  guideYs: number[];
  dividerY: number;
  barsBaseline: number;
  leftPad: number;
  rightPad: number;
  axisLabels: Array<{ y: number; label: string }>;
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
      leftPad: 50,
      rightPad: 14,
      axisLabels: [],
    };
  }

  const width = 320;
  const leftPad = 50;
  const rightPad = 14;
  const lineTop = 20;
  const lineBottom = 78;
  const lineFloor = 88;
  const dividerY = 98;
  const barsBaseline = 138;
  const joinedPeakHeight = 24;
  const leftPeakHeight = 14;
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
    const joined = membership?.joined ?? 0;
    const left = membership?.left ?? 0;
    const joinedHeight = joined * joinedScale;
    const leftHeight = typeof left === 'number' && left > 0 ? left * leftScale : 0;

    return {
      at: item.at,
      participantsCount: item.participantsCount,
      joined,
      left,
      x,
      y: participantsY,
      joinedTop: barsBaseline - joinedHeight,
      joinedHeight,
      leftTop: barsBaseline,
      leftHeight,
    };
  });

  const linePath = buildAudiencePath(points.map((point) => ({ x: point.x, y: point.y })));
  const axisLabels =
    participantValues.length === 0
      ? []
      : maxParticipants === minParticipants
        ? [
            {
              y: Math.round((lineTop + lineBottom) / 2) + 4,
              label: formatCount(maxParticipants),
            },
          ]
        : [
            { y: lineTop + 4, label: formatCount(maxParticipants) },
            {
              y: Math.round((lineTop + lineBottom) / 2) + 4,
              label: formatCount(Math.round((maxParticipants + minParticipants) / 2)),
            },
            { y: lineBottom + 4, label: formatCount(minParticipants) },
          ];

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
    leftPad,
    rightPad,
    axisLabels,
  };
}

function buildViewsChart(stats: ChannelStatsResponse): {
  bars: ViewChartPoint[];
  maxViews: number;
  cumulativeMax: number;
  cumulativeLinePath: string;
  cumulativeAreaPath: string;
  guideYs: number[];
  leftPad: number;
  rightPad: number;
  baselineY: number;
} {
  const series = stats.official.series.views;
  if (series.length === 0) {
    return {
      bars: [],
      maxViews: 0,
      cumulativeMax: 0,
      cumulativeLinePath: '',
      cumulativeAreaPath: '',
      guideYs: [],
      leftPad: 18,
      rightPad: 14,
      baselineY: 162,
    };
  }

  const width = 320;
  const height = 180;
  const leftPad = 18;
  const rightPad = 14;
  const topPad = 16;
  const bottomPad = 18;
  const plotWidth = width - leftPad - rightPad;
  const usableHeight = height - topPad - bottomPad;
  const maxViews = Math.max(...series.map((item) => item.views), 0);
  const cumulativeMax = Math.max(...series.map((item) => item.cumulativeViews), 0);
  const scale = maxViews > 0 ? usableHeight / maxViews : 0;
  const cumulativeRange = Math.max(1, cumulativeMax);

  const bars = series.map((item, index) => {
    const x =
      series.length === 1
        ? width / 2
        : leftPad + (plotWidth * index) / Math.max(1, series.length - 1);
    const barHeight = item.views * scale;
    return {
      at: item.at,
      views: item.views,
      cumulativeViews: item.cumulativeViews,
      x,
      y: height - bottomPad - barHeight,
      height: barHeight,
      cumulativeY:
        topPad + ((cumulativeMax - item.cumulativeViews) / cumulativeRange) * usableHeight,
    };
  });
  const cumulativePoints = bars.map((bar) => ({ x: bar.x, y: bar.cumulativeY }));
  const cumulativeLinePath = buildAudiencePath(cumulativePoints);

  return {
    bars,
    maxViews,
    cumulativeMax,
    cumulativeLinePath,
    cumulativeAreaPath: buildAudienceAreaPath(
      cumulativeLinePath,
      cumulativePoints,
      height - bottomPad,
    ),
    guideYs: [topPad, Math.round(topPad + usableHeight / 2)],
    leftPad,
    rightPad,
    baselineY: height - bottomPad,
  };
}

function AudienceChart({ stats }: { stats: ChannelStatsResponse }) {
  const chart = buildAudienceChart(stats);
  const labels = stats.official.series.participants;
  const [activeIndex, setActiveIndex] = useState(Math.max(chart.points.length - 1, 0));

  useEffect(() => {
    setActiveIndex(Math.max(chart.points.length - 1, 0));
  }, [chart.points.length, stats.period.from, stats.period.to]);

  const safeActiveIndex = clamp(activeIndex, 0, Math.max(chart.points.length - 1, 0));
  const activePoint = chart.points[safeActiveIndex] ?? null;
  const hasLeftBars = chart.points.some((point) => point.left > 0);
  const visibleLabelIndices = resolveSparseLabelIndices(labels.length, safeActiveIndex);
  const slotWidth =
    chart.points.length > 1
      ? (320 - chart.leftPad - chart.rightPad) / Math.max(1, chart.points.length - 1)
      : 44;
  const activeBandWidth = clamp(slotWidth * 0.72, 26, 40);
  const activeParticipantsLabel = formatCount(activePoint?.participantsCount ?? null);
  const activeParticipantsLabelWidth = Math.max(58, activeParticipantsLabel.length * 7 + 18);
  const activeNet = activePoint ? activePoint.joined - activePoint.left : 0;
  const audienceInsights = buildAudienceInsights(stats, chart.points);
  const maxMembershipActivity = Math.max(
    ...chart.points.map((point) => point.joined + point.left),
    0,
  );
  const activeGuideLabel = activePoint
    ? `${formatChartDetailDate(activePoint.at, stats.period.bucket)}: ${formatCount(
        activePoint.participantsCount,
      )} участников, ${formatCount(activePoint.joined)} пришли, ${formatCount(
        activePoint.left,
      )} ушли, баланс ${formatSignedCount(activeNet)}`
    : 'Данные по аудитории недоступны';
  const calloutX = activePoint
    ? clamp(
        activePoint.x - activeParticipantsLabelWidth / 2,
        chart.leftPad,
        320 - chart.rightPad - activeParticipantsLabelWidth,
      )
    : 0;
  const calloutY = activePoint ? clamp(activePoint.y - 36, 8, chart.dividerY - 28) : 0;

  return (
    <div className="channel-stats-graph">
      {chart.points.length === 0 ? (
        <div className="channel-stats-graph__empty">Пока нет данных за период.</div>
      ) : (
        <>
          <div className="channel-stats-graph__summary">
            <div className="channel-stats-graph__summary-copy">
              <small>
                {activePoint
                  ? formatChartDetailDate(activePoint.at, stats.period.bucket)
                  : 'Нет данных'}
              </small>
              <strong>{activeParticipantsLabel} участников</strong>
            </div>

            <div className="channel-stats-graph__summary-chips">
              <span className="channel-stats-graph__chip channel-stats-graph__chip--line">
                Баланс {formatSignedCount(activeNet)}
              </span>
              <span className="channel-stats-graph__chip channel-stats-graph__chip--joined">
                Вошли {formatCount(activePoint?.joined ?? 0)}
              </span>
              {hasLeftBars ? (
                <span className="channel-stats-graph__chip channel-stats-graph__chip--left">
                  Вышли {formatCount(activePoint?.left ?? 0)}
                </span>
              ) : null}
            </div>
          </div>

          <ChartInsightStrip insights={audienceInsights} />

          <div
            className="channel-stats-graph__canvas channel-stats-graph__canvas--audience"
            tabIndex={0}
            role="slider"
            aria-label="Динамика аудитории"
            aria-valuemin={1}
            aria-valuemax={chart.points.length}
            aria-valuenow={safeActiveIndex + 1}
            aria-valuetext={activeGuideLabel}
            onPointerDown={(event) =>
              setActiveIndex(
                resolveChartIndexFromClientX(
                  event.clientX,
                  event.currentTarget.getBoundingClientRect(),
                  chart.points.length,
                ),
              )
            }
            onPointerMove={(event) => {
              if (event.pointerType !== 'mouse' && event.buttons !== 1) {
                return;
              }

              setActiveIndex(
                resolveChartIndexFromClientX(
                  event.clientX,
                  event.currentTarget.getBoundingClientRect(),
                  chart.points.length,
                ),
              );
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowLeft') {
                event.preventDefault();
                setActiveIndex((current) => clamp(current - 1, 0, chart.points.length - 1));
              }

              if (event.key === 'ArrowRight') {
                event.preventDefault();
                setActiveIndex((current) => clamp(current + 1, 0, chart.points.length - 1));
              }
            }}
          >
            <svg viewBox="0 0 320 180" className="channel-stats-graph__svg" aria-hidden>
              <defs>
                <linearGradient id="channel-audience-line" x1="50" x2="306" y1="20" y2="78">
                  <stop offset="0" stopColor="#5f9dff" />
                  <stop offset="0.54" stopColor="#0b84ff" />
                  <stop offset="1" stopColor="#35c59f" />
                </linearGradient>
                <linearGradient id="channel-audience-area" x1="0" x2="0" y1="18" y2="92">
                  <stop offset="0" stopColor="#0b84ff" stopOpacity="0.2" />
                  <stop offset="0.72" stopColor="#35c59f" stopOpacity="0.07" />
                  <stop offset="1" stopColor="#35c59f" stopOpacity="0" />
                </linearGradient>
                <linearGradient id="channel-joined-bar" x1="0" x2="0" y1="106" y2="138">
                  <stop offset="0" stopColor="#5ee2a8" />
                  <stop offset="1" stopColor="#1fa97e" />
                </linearGradient>
                <linearGradient id="channel-left-bar" x1="0" x2="0" y1="138" y2="154">
                  <stop offset="0" stopColor="#ff9aa9" />
                  <stop offset="1" stopColor="#e45363" />
                </linearGradient>
              </defs>
              {activePoint ? (
                <rect
                  x={activePoint.x - activeBandWidth / 2}
                  y={chart.guideYs[0]! - 10}
                  width={activeBandWidth}
                  height={chart.barsBaseline - chart.guideYs[0]! + 14}
                  rx={activeBandWidth / 2}
                  className="channel-stats-graph__active-band"
                />
              ) : null}
              {chart.axisLabels.map((label) => (
                <text
                  key={`${label.label}-${label.y}`}
                  x="12"
                  y={label.y}
                  className="channel-stats-graph__axis-text"
                >
                  {label.label}
                </text>
              ))}
              {chart.guideYs.map((y) => (
                <line
                  key={`guide-${y}`}
                  x1={chart.leftPad}
                  y1={y}
                  x2={320 - chart.rightPad}
                  y2={y}
                  className="channel-stats-graph__grid"
                />
              ))}
              <line
                x1={chart.leftPad}
                y1={chart.dividerY}
                x2={320 - chart.rightPad}
                y2={chart.dividerY}
                className="channel-stats-graph__divider"
              />
              <line
                x1={chart.leftPad}
                y1={chart.barsBaseline}
                x2={320 - chart.rightPad}
                y2={chart.barsBaseline}
                className="channel-stats-graph__baseline"
              />
              {chart.hasLine ? (
                <path
                  d={chart.areaPath}
                  className="channel-stats-graph__area channel-stats-graph__area--audience"
                />
              ) : null}
              {chart.hasLine ? (
                <path
                  d={chart.linePath}
                  className="channel-stats-graph__line-glow channel-stats-graph__line-glow--audience"
                />
              ) : null}
              {activePoint ? (
                <line
                  x1={activePoint.x}
                  y1={chart.guideYs[0]}
                  x2={activePoint.x}
                  y2={chart.barsBaseline}
                  className="channel-stats-graph__active-guide"
                />
              ) : null}
              {chart.points.map((point, index) => (
                <g key={labels[index]?.at ?? index}>
                  <rect
                    x={point.x - (safeActiveIndex === index ? 6 : 5)}
                    y={point.joinedTop}
                    width={safeActiveIndex === index ? 12 : 10}
                    height={point.joinedHeight}
                    rx="4.5"
                    className={`channel-stats-graph__bar channel-stats-graph__bar--joined ${
                      safeActiveIndex === index ? 'is-active' : ''
                    }`}
                  />
                  {point.leftHeight > 0 ? (
                    <rect
                      x={point.x - (safeActiveIndex === index ? 6 : 5)}
                      y={point.leftTop}
                      width={safeActiveIndex === index ? 12 : 10}
                      height={point.leftHeight}
                      rx="4.5"
                      className={`channel-stats-graph__bar channel-stats-graph__bar--left ${
                        safeActiveIndex === index ? 'is-active' : ''
                      }`}
                    />
                  ) : null}
                </g>
              ))}
              <line
                x1={chart.leftPad}
                y1="158"
                x2={320 - chart.rightPad}
                y2="158"
                className="channel-stats-graph__event-rail"
              />
              {chart.points.map((point, index) => {
                const activity = point.joined + point.left;
                const tone =
                  point.left > point.joined ? 'left' : point.joined > 0 ? 'joined' : 'neutral';
                const opacity =
                  maxMembershipActivity > 0
                    ? clamp(activity / maxMembershipActivity, 0.32, 1)
                    : 0.28;

                return (
                  <circle
                    key={`event-${labels[index]?.at ?? index}`}
                    cx={point.x}
                    cy="158"
                    r={safeActiveIndex === index ? 4.4 : 2.8}
                    style={{ opacity }}
                    className={`channel-stats-graph__event-dot channel-stats-graph__event-dot--${tone} ${
                      safeActiveIndex === index ? 'is-active' : ''
                    }`}
                  />
                );
              })}
              {chart.hasLine ? (
                <path
                  d={chart.linePath}
                  className="channel-stats-graph__line channel-stats-graph__line--audience"
                />
              ) : null}
              {chart.hasLine && activePoint ? (
                <circle
                  cx={activePoint.x}
                  cy={activePoint.y}
                  r="10"
                  className="channel-stats-graph__dot-pulse"
                />
              ) : null}
              {chart.hasLine
                ? chart.points.map((point, index) => (
                    <circle
                      key={labels[index]?.at ?? index}
                      cx={point.x}
                      cy={point.y}
                      r={safeActiveIndex === index ? 5 : 3.5}
                      className={`channel-stats-graph__dot ${
                        safeActiveIndex === index ? 'is-active' : ''
                      }`}
                    />
                  ))
                : null}
              {activePoint ? (
                <g>
                  <rect
                    x={calloutX}
                    y={calloutY}
                    width={activeParticipantsLabelWidth}
                    height="24"
                    rx="12"
                    className="channel-stats-graph__callout"
                  />
                  <text
                    x={calloutX + activeParticipantsLabelWidth / 2}
                    y={calloutY + 16}
                    textAnchor="middle"
                    className="channel-stats-graph__callout-text"
                  >
                    {activeParticipantsLabel}
                  </text>
                </g>
              ) : null}
            </svg>
          </div>

          <div className="channel-stats-graph__labels">
            {labels.map((item, index) => (
              <small
                key={`${item.at}-${index}`}
                className={safeActiveIndex === index ? 'is-active' : ''}
              >
                {visibleLabelIndices.has(index)
                  ? formatShortDate(item.at, stats.period.bucket)
                  : '\u00a0'}
              </small>
            ))}
          </div>

          <output className="channel-stats-graph__sr" aria-live="polite">
            {activeGuideLabel}
          </output>
        </>
      )}
    </div>
  );
}

function ViewsChart({ stats }: { stats: ChannelStatsResponse }) {
  const chart = buildViewsChart(stats);
  const labels = stats.official.series.views;
  const [activeIndex, setActiveIndex] = useState(Math.max(chart.bars.length - 1, 0));

  useEffect(() => {
    setActiveIndex(Math.max(chart.bars.length - 1, 0));
  }, [chart.bars.length, stats.period.from, stats.period.to]);

  const safeActiveIndex = clamp(activeIndex, 0, Math.max(chart.bars.length - 1, 0));
  const activeBar = chart.bars[safeActiveIndex] ?? null;
  const visibleLabelIndices = resolveSparseLabelIndices(labels.length, safeActiveIndex);
  const totalViews = labels.reduce((sum, item) => sum + item.views, 0);
  const averageViews = labels.length > 0 ? Math.round(totalViews / labels.length) : 0;
  const viewInsights = buildViewsInsights(stats, chart.bars, averageViews);
  const slotWidth =
    chart.bars.length > 1
      ? (320 - chart.leftPad - chart.rightPad) / Math.max(1, chart.bars.length - 1)
      : 44;
  const activeBandWidth = clamp(slotWidth * 0.76, 28, 44);
  const activeViewsLabel = formatCount(activeBar?.views ?? null);
  const activeCumulativeLabel = formatCount(activeBar?.cumulativeViews ?? chart.cumulativeMax);
  const activeViewsLabelWidth = Math.max(58, activeViewsLabel.length * 7 + 18);
  const calloutX = activeBar
    ? clamp(
        activeBar.x - activeViewsLabelWidth / 2,
        chart.leftPad,
        320 - chart.rightPad - activeViewsLabelWidth,
      )
    : 0;
  const calloutY = activeBar ? clamp(activeBar.y - 34, 8, chart.baselineY - 28) : 0;
  const activeGuideLabel = activeBar
    ? `${formatChartDetailDate(activeBar.at, stats.period.bucket)}: ${formatCount(
        activeBar.views,
      )} просмотров за период, ${formatCount(activeBar.cumulativeViews)} накопительно`
    : 'Данные по просмотрам недоступны';
  const modeLabel =
    stats.official.content.viewsMode === 'observedDelta'
      ? 'Прирост между снимками MAX'
      : 'Текущие просмотры постов';

  return (
    <div className="channel-stats-graph">
      {chart.bars.length === 0 ? (
        <div className="channel-stats-graph__empty">Пока нет постов за период.</div>
      ) : (
        <>
          <div className="channel-stats-graph__summary">
            <div className="channel-stats-graph__summary-copy">
              <small>
                {activeBar
                  ? formatChartDetailDate(activeBar.at, stats.period.bucket)
                  : 'Нет данных'}
              </small>
              <strong>{activeViewsLabel} просмотров</strong>
            </div>

            <div className="channel-stats-graph__summary-chips">
              <span className="channel-stats-graph__chip channel-stats-graph__chip--views">
                Пик {formatCount(chart.maxViews)}
              </span>
              <span className="channel-stats-graph__chip channel-stats-graph__chip--muted">
                Среднее {formatCount(averageViews)}
              </span>
              <span className="channel-stats-graph__chip channel-stats-graph__chip--muted">
                Накоплено {activeCumulativeLabel}
              </span>
              <span className="channel-stats-graph__chip channel-stats-graph__chip--muted">
                {modeLabel}
              </span>
            </div>
          </div>

          <ChartInsightStrip insights={viewInsights} />

          <div
            className="channel-stats-graph__canvas"
            tabIndex={0}
            role="slider"
            aria-label="Охват публикаций"
            aria-valuemin={1}
            aria-valuemax={chart.bars.length}
            aria-valuenow={safeActiveIndex + 1}
            aria-valuetext={activeGuideLabel}
            onPointerDown={(event) =>
              setActiveIndex(
                resolveChartIndexFromClientX(
                  event.clientX,
                  event.currentTarget.getBoundingClientRect(),
                  chart.bars.length,
                ),
              )
            }
            onPointerMove={(event) => {
              if (event.pointerType !== 'mouse' && event.buttons !== 1) {
                return;
              }

              setActiveIndex(
                resolveChartIndexFromClientX(
                  event.clientX,
                  event.currentTarget.getBoundingClientRect(),
                  chart.bars.length,
                ),
              );
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowLeft') {
                event.preventDefault();
                setActiveIndex((current) => clamp(current - 1, 0, chart.bars.length - 1));
              }

              if (event.key === 'ArrowRight') {
                event.preventDefault();
                setActiveIndex((current) => clamp(current + 1, 0, chart.bars.length - 1));
              }
            }}
          >
            <svg viewBox="0 0 320 180" className="channel-stats-graph__svg" aria-hidden>
              <defs>
                <linearGradient id="channel-views-bar" x1="0" x2="0" y1="18" y2="162">
                  <stop offset="0" stopColor="#58a6ff" />
                  <stop offset="1" stopColor="#0b84ff" />
                </linearGradient>
                <linearGradient
                  id="channel-views-cumulative-line"
                  x1="18"
                  x2="306"
                  y1="18"
                  y2="162"
                >
                  <stop offset="0" stopColor="#9f7aea" />
                  <stop offset="0.58" stopColor="#0b84ff" />
                  <stop offset="1" stopColor="#35c59f" />
                </linearGradient>
                <linearGradient id="channel-views-cumulative-area" x1="0" x2="0" y1="16" y2="162">
                  <stop offset="0" stopColor="#0b84ff" stopOpacity="0.16" />
                  <stop offset="0.74" stopColor="#9f7aea" stopOpacity="0.05" />
                  <stop offset="1" stopColor="#9f7aea" stopOpacity="0" />
                </linearGradient>
              </defs>
              {activeBar ? (
                <rect
                  x={activeBar.x - activeBandWidth / 2}
                  y={chart.guideYs[0]! - 10}
                  width={activeBandWidth}
                  height={chart.baselineY - chart.guideYs[0]! + 14}
                  rx={activeBandWidth / 2}
                  className="channel-stats-graph__active-band channel-stats-graph__active-band--views"
                />
              ) : null}
              {chart.guideYs.map((y) => (
                <line
                  key={`views-guide-${y}`}
                  x1={chart.leftPad}
                  y1={y}
                  x2={320 - chart.rightPad}
                  y2={y}
                  className="channel-stats-graph__grid"
                />
              ))}
              <line
                x1={chart.leftPad}
                y1={chart.baselineY}
                x2={320 - chart.rightPad}
                y2={chart.baselineY}
                className="channel-stats-graph__baseline"
              />
              {chart.cumulativeAreaPath ? (
                <path
                  d={chart.cumulativeAreaPath}
                  className="channel-stats-graph__area channel-stats-graph__area--views-cumulative"
                />
              ) : null}
              {chart.cumulativeLinePath ? (
                <path
                  d={chart.cumulativeLinePath}
                  className="channel-stats-graph__line-glow channel-stats-graph__line-glow--views"
                />
              ) : null}
              {activeBar ? (
                <line
                  x1={activeBar.x}
                  y1={chart.guideYs[0]!}
                  x2={activeBar.x}
                  y2={chart.baselineY}
                  className="channel-stats-graph__active-guide channel-stats-graph__active-guide--views"
                />
              ) : null}
              {chart.bars.map((bar, index) => (
                <rect
                  key={labels[index]?.at ?? index}
                  x={bar.x - (safeActiveIndex === index ? 10 : 9)}
                  y={bar.y}
                  width={safeActiveIndex === index ? 20 : 18}
                  height={Math.max(4, bar.height)}
                  rx="6"
                  className={`channel-stats-graph__bar channel-stats-graph__bar--views ${
                    safeActiveIndex === index ? 'is-active' : ''
                  }`}
                />
              ))}
              {chart.cumulativeLinePath ? (
                <path
                  d={chart.cumulativeLinePath}
                  className="channel-stats-graph__line channel-stats-graph__line--views-cumulative"
                />
              ) : null}
              {activeBar ? (
                <circle
                  cx={activeBar.x}
                  cy={activeBar.cumulativeY}
                  r="8"
                  className="channel-stats-graph__dot-pulse channel-stats-graph__dot-pulse--views"
                />
              ) : null}
              {activeBar ? (
                <circle
                  cx={activeBar.x}
                  cy={activeBar.cumulativeY}
                  r="4.3"
                  className="channel-stats-graph__dot channel-stats-graph__dot--views is-active"
                />
              ) : null}
              {activeBar ? (
                <g>
                  <rect
                    x={calloutX}
                    y={calloutY}
                    width={activeViewsLabelWidth}
                    height="24"
                    rx="12"
                    className="channel-stats-graph__callout channel-stats-graph__callout--views"
                  />
                  <text
                    x={calloutX + activeViewsLabelWidth / 2}
                    y={calloutY + 16}
                    textAnchor="middle"
                    className="channel-stats-graph__callout-text"
                  >
                    {activeViewsLabel}
                  </text>
                </g>
              ) : null}
            </svg>
          </div>

          <div className="channel-stats-graph__labels">
            {labels.map((item, index) => (
              <small
                key={`${item.at}-${index}`}
                className={safeActiveIndex === index ? 'is-active' : ''}
              >
                {visibleLabelIndices.has(index)
                  ? formatShortDate(item.at, stats.period.bucket)
                  : '\u00a0'}
              </small>
            ))}
          </div>

          <output className="channel-stats-graph__sr" aria-live="polite">
            {activeGuideLabel}
          </output>
        </>
      )}
    </div>
  );
}

function TopPostsChart({ stats }: { stats: ChannelStatsResponse }) {
  const posts = stats.official.content.topPosts;
  const maxViews = Math.max(...posts.map((post) => post.viewsDelta || post.views), 0);

  if (posts.length === 0) {
    return (
      <div className="channel-posts-chart">
        <div className="channel-stats-graph__empty">Пока нет публикаций за период.</div>
      </div>
    );
  }

  return (
    <div className="channel-posts-chart">
      <div className="channel-posts-chart__summary">
        <strong>Лучшие публикации</strong>
        <small>
          По приросту просмотров. Реакции показаны рядом, чтобы не смешивать два разных сигнала.
        </small>
      </div>

      <div className="channel-posts-chart__list">
        {posts.map((post, index) => {
          const value = post.viewsDelta || post.views;
          const width = maxViews > 0 ? Math.max(8, Math.round((value / maxViews) * 100)) : 8;
          const title = `Пост ${index + 1}`;
          const row = (
            <>
              <div className="channel-posts-chart__row-head">
                <span className="channel-posts-chart__rank">#{index + 1}</span>
                <span className="channel-posts-chart__title">{title}</span>
                <strong>{formatCount(value)}</strong>
              </div>
              <div className="channel-posts-chart__bar" aria-hidden="true">
                <span style={{ width: `${width}%` }} />
              </div>
              <div className="channel-posts-chart__row-meta">
                <small>Прирост {formatCount(post.viewsDelta)}</small>
                <small>{formatDateTime(post.publishedAt)}</small>
                <small>{formatCount(post.reactions)} реакций</small>
                <small>{formatCount(post.views)} всего</small>
              </div>
            </>
          );

          return post.url ? (
            <a
              key={post.messageId}
              href={post.url}
              target="_blank"
              rel="noreferrer"
              className="channel-posts-chart__row"
            >
              {row}
            </a>
          ) : (
            <article key={post.messageId} className="channel-posts-chart__row">
              {row}
            </article>
          );
        })}
      </div>
    </div>
  );
}

export function ChannelStatsPage({ api }: { api: ApiTransport }) {
  const { chatId = '' } = useParams();
  const location = useLocation();
  const { pushToast } = useToast();
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
    queryKey: queryKeys.channelStats(chatId, range),
    queryFn: ({ signal }) => getChannelStats(api, chatId, range, { signal }),
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
    if (!statsQuery.data?.meta.viewsAvailable && (chartTab === 'views' || chartTab === 'posts')) {
      setChartTab('audience');
    }
    if (
      statsQuery.data?.meta.viewsAvailable &&
      chartTab === 'posts' &&
      statsQuery.data.official.content.topPosts.length === 0
    ) {
      setChartTab('audience');
    }
  }, [
    chartTab,
    statsQuery.data?.meta.viewsAvailable,
    statsQuery.data?.official.content.topPosts.length,
  ]);

  const activityFeed = useMembershipActivityFeed({
    range,
    initialPage: statsQuery.data?.activityFeed ?? EMPTY_ACTIVITY_PAGE,
    loadPage: (query) => getChannelActivityFeed(api, chatId, query),
  });
  const profileHandoffMutation = useMutation({
    mutationFn: ({ userId, displayName }: { userId: string; displayName: string }) =>
      handoffChannelMemberProfile(api, chatId, userId, { displayName }),
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

  const chartTabs = audienceTabOptions.filter((option) => {
    if (option.value === 'views') {
      return stats.meta.viewsAvailable;
    }

    if (option.value === 'posts') {
      return stats.meta.viewsAvailable && stats.official.content.topPosts.length > 0;
    }

    return true;
  });
  const effectiveChartTab: ChartTab =
    stats.meta.viewsAvailable && chartTabs.some((option) => option.value === chartTab)
      ? chartTab
      : 'audience';
  const showSecondaryActivity = hasSecondaryActivity(stats.secondary);
  const audienceJoined = stats.official.audience.joined ?? 0;
  const audienceLeft = stats.official.audience.left ?? 0;
  const audienceNet = stats.official.audience.net ?? audienceJoined - audienceLeft;
  const netTone = audienceNet > 0 ? 'success' : audienceNet < 0 ? 'danger' : 'neutral';
  const averageViewsPerPost =
    stats.meta.viewsAvailable && stats.official.content.posts > 0
      ? Math.round(stats.official.content.viewsTotal / stats.official.content.posts)
      : null;
  const reactionsPerPost =
    stats.official.content.posts > 0
      ? Math.round(stats.official.content.reactions / stats.official.content.posts)
      : null;
  const engagementRate =
    stats.meta.viewsAvailable && stats.official.content.views > 0
      ? (stats.official.content.reactions / stats.official.content.views) * 100
      : null;
  const chartTitle =
    effectiveChartTab === 'audience'
      ? 'Динамика аудитории'
      : effectiveChartTab === 'views'
        ? 'Просмотры'
        : 'Топ публикаций';
  const chartSummary =
    effectiveChartTab === 'audience'
      ? `${formatCount(audienceJoined)} вошли · ${formatCount(audienceLeft)} вышли`
      : effectiveChartTab === 'views' && stats.meta.viewsAvailable
        ? `${formatCount(stats.official.content.views)} просмотров · ${formatCount(
            stats.official.content.posts,
          )} постов`
        : effectiveChartTab === 'posts'
          ? `${formatCount(stats.official.content.topPosts.length)} лучших за период`
          : 'Официальные просмотры MAX недоступны';
  const linkLabel =
    stats.channel.isPublic && stats.channel.link
      ? formatLink(stats.channel.link)
      : stats.channel.isPublic === false
        ? 'Канал приватный'
        : 'Нет данных';
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
      handoffChannelMemberProfileKeepalive(api, chatId, normalizedUserId, {
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

  return (
    <div className="channel-insights page-enter">
      <CompactStickyHeader
        backTo={buildManagedEntitiesRoute('channel')}
        backLabel="К списку каналов"
        title={resolvedTitle}
        avatar={
          <EntityAvatar
            title={resolvedTitle}
            entityType="channel"
            avatarUrl={statsQuery.data?.channel.avatarUrl ?? routeState.avatarUrl ?? null}
            className="compact-page-header__entity-avatar"
          />
        }
        compact={isHeaderCompact}
        hidden={isHeaderHidden}
        className="channel-insights__sticky-header"
        aside={
          statsQuery.isFetching ? (
            <span className="channel-insights__pulse" aria-label="Обновляем" title="Обновляем" />
          ) : (
            <span
              className="channel-insights__pulse channel-insights__pulse--idle"
              aria-hidden="true"
            />
          )
        }
      />

      <div className="channel-insights__body">
        <section
          className="channel-insights__summary channel-insights__summary--command stagger-in"
          aria-label="Сводка по каналу"
        >
          <div className="channel-insights__summary-head">
            <div className="channel-insights__summary-copy">
              <h2>Обзор</h2>
              <p>{resolveChannelStateLabel(stats)}</p>
            </div>

            <SegmentedControl
              value={range}
              options={periodOptions}
              onChange={setRange}
              className="channel-insights__range"
            />
          </div>

          <div className="channel-insights__kpi-grid">
            <article className="channel-insights__kpi-card channel-insights__kpi-card--live">
              <small>Участники</small>
              <strong>{formatCount(stats.channel.participantsCount)}</strong>
              <span>{resolveHeroNote(stats)}</span>
            </article>

            <article
              className={`channel-insights__kpi-card channel-insights__kpi-card--${netTone}`}
            >
              <small>Прирост</small>
              <strong>{formatSignedCount(audienceNet)}</strong>
              <span>
                {formatCount(audienceJoined)} вошли · {formatCount(audienceLeft)} вышли
              </span>
            </article>

            <article className="channel-insights__kpi-card channel-insights__kpi-card--views">
              <small>Просмотры</small>
              <strong>
                {stats.meta.viewsAvailable
                  ? formatCount(stats.official.content.views)
                  : formatCount(stats.official.content.posts)}
              </strong>
              <span>
                {stats.meta.viewsAvailable
                  ? averageViewsPerPost !== null
                    ? `${formatCount(averageViewsPerPost)} в среднем`
                    : 'Без публикаций'
                  : `${formatCount(stats.official.content.posts)} постов`}
              </span>
            </article>

            <article className="channel-insights__kpi-card channel-insights__kpi-card--reactions">
              <small>Реакции</small>
              <strong>{formatCount(stats.official.content.reactions)}</strong>
              <span>
                {engagementRate !== null
                  ? `${formatPercent(engagementRate)} от просмотров`
                  : reactionsPerPost !== null
                    ? `${formatCount(reactionsPerPost)} на пост`
                    : 'Нет данных'}
              </span>
            </article>
          </div>

          <article className="channel-insights__chart-card">
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
            ) : effectiveChartTab === 'views' ? (
              <ViewsChart stats={stats} />
            ) : (
              <TopPostsChart stats={stats} />
            )}
          </article>
        </section>

        <MembershipActivityFeed
          title="Движение подписчиков"
          subtitle={null}
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
          onProfileActivate={(item: MembershipActivityItem) =>
            activateProfile(item.userId, item.userDisplayName, item.profileHandoffUrl)
          }
        />

        <div className="channel-insights__secondary-layout">
          {stats.official.content.topReactions.length > 0 ? (
            <section className="channel-insights__panel channel-insights__panel--reactions channel-insights__panel--warm">
              <div className="channel-insights__panel-head">
                <div className="channel-insights__panel-copy">
                  <strong>Топ реакций</strong>
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
