import type { MembershipActivityItem } from '@maxim/contracts';
import type {
  ChannelStatsBucket,
  ChannelStatsRange,
  ChannelStatsResponse,
} from '@maxim/contracts/channel-stats';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity as IconActivity,
  Calendar as IconCalendar,
  ClockRotateRight as IconClockRotateRight,
  Community as IconCommunity,
  DatabaseStats as IconDatabaseStats,
  Eye as IconEye,
  GraphUp as IconGraphUp,
  PercentageCircle as IconPercentageCircle,
  UserPlus as IconUserPlus,
  UserXmark as IconUserXmark,
} from 'iconoir-react';
import '../styles/channel-stats.css';
import type { CSSProperties, PointerEvent } from 'react';
import { startTransition, useEffect, useMemo, useState } from 'react';
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
import { readStatsSnapshot, saveStatsSnapshot } from '../lib/stats-snapshot-cache';
import {
  resolveChannelStatsDisplayViews,
  resolveChannelStatsViewsModeLabel,
  resolveInitialAudienceChartIndex,
  resolveInitialViewsChartIndex,
  shouldUseChannelStatsPeriodViews,
} from '../lib/channel-stats-chart';
import { useAutoHideHeader } from '../lib/use-auto-hide-header';
import { useMembershipActivityFeed } from '../lib/use-membership-activity-feed';

type ChannelStatsRouteState = {
  chatTitle: string;
  avatarUrl: string | null;
};

type ChartTab = 'audience' | 'views';
type ChannelStatsSection = 'overview' | 'events';

type ChartInsightTone = 'accent' | 'success' | 'danger' | 'warning' | 'neutral';

type AudienceChartPoint = {
  at: string;
  participantsCount: number | null;
  joined: number;
  left: number;
  net: number;
  cumulativeNet: number;
  x: number;
  y: number;
  joinedTop: number;
  joinedHeight: number;
  leftTop: number;
  leftHeight: number;
};

type PreviousAudienceChartPoint = {
  at: string;
  participantsCount: number | null;
  joined: number;
  left: number;
  net: number;
  cumulativeNet: number;
  x: number;
  y: number;
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

type PreviousViewChartPoint = ViewChartPoint;

type ViewChartAggregateBar = {
  x: number;
  y: number;
  width: number;
  height: number;
  views: number;
};

type ChartPostPin = {
  messageId: string;
  label: string;
  value: string;
  detail: string;
  x: number;
  tone: ChartInsightTone;
};

const periodOptions: Array<{ value: ChannelStatsRange; label: string }> = [
  { value: '24h', label: '24ч' },
  { value: '7d', label: '7д' },
  { value: '30d', label: '30д' },
];

const audienceTabOptions: Array<{ value: ChartTab; label: string }> = [
  { value: 'audience', label: 'Ауд.' },
  { value: 'views', label: 'Просм.' },
];

const sectionOptions: Array<{ value: ChannelStatsSection; label: string }> = [
  { value: 'overview', label: 'Обзор' },
  { value: 'events', label: 'События' },
];

const dayShortLabels = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'] as const;
const CHART_VIEWBOX_WIDTH = 390;
const CHART_VIEWBOX_HEIGHT = 210;

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

function getInitialSection(search: string): ChannelStatsSection {
  return new URLSearchParams(search).get('section') === 'events' ? 'events' : 'overview';
}

function formatCount(value: number | null): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '—';
  }

  return new Intl.NumberFormat('ru-RU').format(value);
}

function formatCompactCount(value: number | null): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '—';
  }

  return new Intl.NumberFormat('ru-RU', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value);
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

function formatSignedCount(value: number | null): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '—';
  }

  if (value > 0) {
    return `+${value}`;
  }

  return String(value);
}

function formatSignedCompactCount(value: number | null): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '—';
  }

  if (value > 0) {
    return `+${formatCompactCount(value)}`;
  }

  if (value < 0) {
    return `-${formatCompactCount(Math.abs(value))}`;
  }

  return '0';
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

function formatDeltaMetric(
  metric: ChannelStatsResponse['comparison']['deltas']['views'] | undefined,
): string {
  if (!metric) {
    return '0';
  }

  if (typeof metric.percent === 'number' && Number.isFinite(metric.percent)) {
    const rounded = Math.round(metric.percent);
    if (rounded !== 0) {
      return `${rounded > 0 ? '+' : ''}${rounded}%`;
    }
  }

  return formatSignedCount(metric.absolute);
}

function resolveDeltaTone(
  metric: ChannelStatsResponse['comparison']['deltas']['views'] | undefined,
  inverse = false,
): ChartInsightTone {
  if (!metric || metric.absolute === 0) {
    return 'neutral';
  }

  const positive = inverse ? metric.absolute < 0 : metric.absolute > 0;
  return positive ? 'success' : 'warning';
}

function formatPostDateTime(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    return '';
  }

  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(parsed);
}

function DeltaBadge({
  metric,
  inverse = false,
}: {
  metric: ChannelStatsResponse['comparison']['deltas']['views'] | undefined;
  inverse?: boolean;
}) {
  const tone = resolveDeltaTone(metric, inverse);

  return (
    <span className={`channel-insights__delta channel-insights__delta--${tone}`}>
      {formatDeltaMetric(metric)}
    </span>
  );
}

function formatBestWindowValue(window: ChannelStatsResponse['signals']['bestWindows'][number]) {
  const day = dayShortLabels[window.dayOfWeek] ?? '';
  const hour = String(window.hour).padStart(2, '0');
  return `${day} ${hour}:00`.trim();
}

function formatBestWindowStats(window: ChannelStatsResponse['signals']['bestWindows'][number]) {
  const views = formatCompactCount(window.averageViews);
  const reactions = formatCompactCount(window.averageReactions);
  return reactions === '—' || window.averageReactions === 0
    ? `${views} просм.`
    : `${views} просм. · ${reactions} реакц.`;
}

function formatDateTime(value: string | null): string {
  if (!value) {
    return '—';
  }

  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    return '—';
  }

  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(parsed);
}

function formatDateOnly(value: string | null): string {
  if (!value) {
    return '—';
  }

  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    return '—';
  }

  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: 'short',
  }).format(parsed);
}

function formatPeriodRange(from: string, to: string): string {
  return `${formatDateOnly(from)} — ${formatDateOnly(to)}`;
}

function ChannelSourceStrip({ stats }: { stats: ChannelStatsResponse }) {
  const coverageLabel = stats.meta.officialCoverageFrom
    ? `с ${formatDateOnly(stats.meta.officialCoverageFrom)}`
    : stats.meta.maxSnapshotAvailable
      ? 'текущий снимок'
      : 'нет снимка';

  return (
    <div className="channel-fact-strip" aria-label="Источник и свежесть данных">
      <span>
        <i className="channel-fact-strip__icon" aria-hidden="true">
          <IconClockRotateRight width={16} height={16} strokeWidth={2.1} />
        </i>
        <div className="channel-fact-strip__copy">
          <small>Срез</small>
          <strong>{formatDateTime(stats.period.to)}</strong>
        </div>
      </span>
      <span>
        <i className="channel-fact-strip__icon" aria-hidden="true">
          <IconCalendar width={16} height={16} strokeWidth={2.1} />
        </i>
        <div className="channel-fact-strip__copy">
          <small>Период</small>
          <strong>{formatPeriodRange(stats.period.from, stats.period.to)}</strong>
        </div>
      </span>
      <span>
        <i className="channel-fact-strip__icon" aria-hidden="true">
          <IconDatabaseStats width={16} height={16} strokeWidth={2.1} />
        </i>
        <div className="channel-fact-strip__copy">
          <small>Покрытие</small>
          <strong>{coverageLabel}</strong>
        </div>
      </span>
    </div>
  );
}

function ChannelBestWindowsPanel({ stats }: { stats: ChannelStatsResponse }) {
  const windows = stats.signals.bestWindows.filter((window) => window.posts > 0).slice(0, 3);

  return (
    <article className="channel-fact-panel channel-best-windows-panel">
      <div className="channel-insights__panel-head">
        <div className="channel-insights__panel-copy">
          <strong>Окна публикаций</strong>
        </div>
      </div>

      {windows.length > 0 ? (
        <div className="channel-best-windows">
          {windows.map((window) => (
            <div key={`${window.dayOfWeek}-${window.hour}`} className="channel-best-windows__row">
              <strong>{formatBestWindowValue(window)}</strong>
              <span>{formatBestWindowStats(window)}</span>
              <small>{formatCount(window.posts)} постов</small>
            </div>
          ))}
        </div>
      ) : (
        <p className="channel-fact-panel__empty">Недостаточно публикаций за период.</p>
      )}
    </article>
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
  leftPad = 0,
  rightPad = 0,
): number {
  if (pointsLength <= 1) {
    return 0;
  }

  const plotLeft = rect.left + (rect.width * leftPad) / CHART_VIEWBOX_WIDTH;
  const plotRight = rect.left + (rect.width * (CHART_VIEWBOX_WIDTH - rightPad)) / CHART_VIEWBOX_WIDTH;
  const ratio = clamp((clientX - plotLeft) / Math.max(plotRight - plotLeft, 1), 0, 1);
  return Math.round(ratio * (pointsLength - 1));
}

function readChartIndexFromPointer(
  event: PointerEvent<HTMLDivElement>,
  pointsLength: number,
  leftPad = 0,
  rightPad = 0,
): number {
  return resolveChartIndexFromClientX(
    event.clientX,
    event.currentTarget.getBoundingClientRect(),
    pointsLength,
    leftPad,
    rightPad,
  );
}

function captureChartPointer(event: PointerEvent<HTMLDivElement>): void {
  try {
    event.currentTarget.setPointerCapture(event.pointerId);
  } catch {
    // Older WebViews can skip pointer capture; scrubbing still works inside the canvas.
  }
}

function resolveAlignedIndex(
  sourceLength: number,
  targetIndex: number,
  targetLength: number,
): number {
  if (sourceLength <= 1 || targetLength <= 1) {
    return 0;
  }

  const ratio = clamp(targetIndex / Math.max(1, targetLength - 1), 0, 1);
  return Math.round(ratio * (sourceLength - 1));
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

function resolvePostPinPositions(
  posts: ChannelStatsResponse['official']['content']['topPosts'],
  anchors: Array<{ at: string; x: number }>,
  usePeriodViews: boolean,
): ChartPostPin[] {
  if (anchors.length === 0 || posts.length === 0) {
    return [];
  }

  return posts.slice(0, 5).map((post, index) => {
    const postTime = new Date(post.publishedAt).getTime();
    let bestAnchor = anchors[0]!;
    let bestDistance = Number.POSITIVE_INFINITY;

    if (Number.isFinite(postTime)) {
      for (const anchor of anchors) {
        const anchorTime = new Date(anchor.at).getTime();
        const distance = Number.isFinite(anchorTime)
          ? Math.abs(anchorTime - postTime)
          : Number.POSITIVE_INFINITY;
        if (distance < bestDistance) {
          bestAnchor = anchor;
          bestDistance = distance;
        }
      }
    }

    const views = usePeriodViews ? post.viewsDelta : post.views;
    return {
      messageId: post.messageId,
      label: `#${index + 1}`,
      value: formatCompactCount(views),
      detail: `${formatCompactCount(views)} просм. · ${formatCompactCount(post.reactions)} р.`,
      x: bestAnchor.x,
      tone: index === 0 ? 'accent' : 'neutral',
    };
  });
}

function resolveActivePostPin(
  pins: ChartPostPin[],
  activeX: number | null,
  slotWidth: number,
): ChartPostPin | null {
  if (pins.length === 0 || activeX === null) {
    return null;
  }

  const threshold = clamp(slotWidth * 0.52, 12, 28);
  let closestPin: ChartPostPin | null = null;
  let closestDistance = Number.POSITIVE_INFINITY;

  for (const pin of pins) {
    const distance = Math.abs(pin.x - activeX);
    if (distance < closestDistance) {
      closestPin = pin;
      closestDistance = distance;
    }
  }

  return closestPin && closestDistance <= threshold ? closestPin : null;
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

function resolveGraphMarkerPositions(
  markers: ChannelStatsResponse['signals']['markers'],
  anchors: Array<{ at: string; x: number }>,
  filter: (marker: ChannelStatsResponse['signals']['markers'][number]) => boolean,
) {
  if (anchors.length === 0) {
    return [];
  }

  return markers
    .filter(filter)
    .map((marker) => {
      const markerTime = new Date(marker.at).getTime();
      if (!Number.isFinite(markerTime)) {
        return null;
      }

      let bestAnchor = anchors[0]!;
      let bestDistance = Math.abs(new Date(bestAnchor.at).getTime() - markerTime);
      for (const anchor of anchors.slice(1)) {
        const distance = Math.abs(new Date(anchor.at).getTime() - markerTime);
        if (distance < bestDistance) {
          bestAnchor = anchor;
          bestDistance = distance;
        }
      }

      return {
        ...marker,
        x: bestAnchor.x,
      };
    })
    .filter(
      (marker): marker is ChannelStatsResponse['signals']['markers'][number] & { x: number } =>
        marker !== null,
    )
    .slice(0, 5);
}

function buildAudienceChart(stats: ChannelStatsResponse): {
  points: AudienceChartPoint[];
  previousPoints: PreviousAudienceChartPoint[];
  linePath: string;
  areaPath: string;
  previousLinePath: string;
  hasLine: boolean;
  hasPreviousLine: boolean;
  guideYs: number[];
  dividerY: number;
  barsBaseline: number;
  eventRailY: number;
  zeroY: number;
  height: number;
  leftPad: number;
  rightPad: number;
  axisLabels: Array<{ y: number; label: string }>;
} {
  const participantSeries = stats.official.series.participants;
  const membershipSeries = stats.official.series.membership;
  const previousParticipantSeries = stats.comparison.series?.participants ?? [];
  const previousMembershipSeries = stats.comparison.series?.membership ?? [];
  const pointCount = Math.max(participantSeries.length, membershipSeries.length);
  if (pointCount === 0) {
    return {
      points: [],
      previousPoints: [],
      linePath: '',
      areaPath: '',
      previousLinePath: '',
      hasLine: false,
      hasPreviousLine: false,
      guideYs: [],
      dividerY: 156,
      barsBaseline: 220,
      eventRailY: 188,
      zeroY: 132,
      height: CHART_VIEWBOX_HEIGHT,
      leftPad: 20,
      rightPad: 8,
      axisLabels: [],
    };
  }

  const width = CHART_VIEWBOX_WIDTH;
  const height = CHART_VIEWBOX_HEIGHT;
  const leftPad = 20;
  const rightPad = 8;
  const lineTop = 20;
  const lineBottom = 92;
  const lineFloor = 108;
  const dividerY = 116;
  const barsBaseline = 160;
  const eventRailY = 188;
  const joinedPeakHeight = 36;
  const leftPeakHeight = 20;
  const plotWidth = width - leftPad - rightPad;
  const maxJoined = Math.max(
    ...membershipSeries.map((item) => item.joined),
    ...previousMembershipSeries.map((item) => item.joined),
    0,
  );
  const maxLeft = Math.max(
    ...membershipSeries.map((item) => item.left ?? 0),
    ...previousMembershipSeries.map((item) => item.left ?? 0),
    0,
  );
  const joinedScale = maxJoined > 0 ? joinedPeakHeight / maxJoined : 0;
  const leftScale = maxLeft > 0 ? leftPeakHeight / maxLeft : 0;

  let cumulativeNet = 0;
  const rawPoints = Array.from({ length: pointCount }, (_, index) => {
    const participant = participantSeries[index] ?? participantSeries.at(-1) ?? null;
    const membership = membershipSeries[index] ?? null;
    const at = membership?.at ?? participant?.at ?? new Date().toISOString();
    const joined = membership?.joined ?? 0;
    const left = membership?.left ?? 0;
    const net = joined - left;
    cumulativeNet += net;
    const x =
      pointCount === 1 ? width / 2 : leftPad + (plotWidth * index) / Math.max(1, pointCount - 1);
    const joinedHeight = joined * joinedScale;
    const leftHeight = typeof left === 'number' && left > 0 ? left * leftScale : 0;

    return {
      at,
      participantsCount: participant?.participantsCount ?? null,
      joined,
      left,
      net,
      cumulativeNet,
      x,
      y: lineBottom,
      joinedTop: barsBaseline - joinedHeight,
      joinedHeight,
      leftTop: barsBaseline,
      leftHeight,
    };
  });

  const previousPointCount = Math.max(
    previousParticipantSeries.length,
    previousMembershipSeries.length,
  );
  let previousCumulativeNet = 0;
  const rawPreviousPoints = Array.from({ length: previousPointCount }, (_, index) => {
    const participant =
      previousParticipantSeries[index] ?? previousParticipantSeries.at(-1) ?? null;
    const membership = previousMembershipSeries[index] ?? null;
    const at = membership?.at ?? participant?.at ?? new Date().toISOString();
    const joined = membership?.joined ?? 0;
    const left = membership?.left ?? 0;
    const net = joined - left;
    previousCumulativeNet += net;
    const x =
      previousPointCount === 1
        ? width / 2
        : leftPad + (plotWidth * index) / Math.max(1, previousPointCount - 1);

    return {
      at,
      participantsCount: participant?.participantsCount ?? null,
      joined,
      left,
      net,
      cumulativeNet: previousCumulativeNet,
      x,
      y: lineBottom,
    };
  });
  const netValues = [
    0,
    ...rawPoints.map((point) => point.cumulativeNet),
    ...rawPreviousPoints.map((point) => point.cumulativeNet),
  ];
  const rawMinNet = Math.min(...netValues);
  const rawMaxNet = Math.max(...netValues);
  const netSpan = Math.max(1, rawMaxNet - rawMinNet);
  const netPadding = Math.max(1, netSpan * 0.2);
  const minNet = rawMinNet - netPadding;
  const maxNet = rawMaxNet + netPadding;
  const netRange = Math.max(1, maxNet - minNet);
  const resolveNetY = (value: number) =>
    lineTop + ((maxNet - value) / netRange) * (lineBottom - lineTop);
  const points = rawPoints.map((point) => ({
    ...point,
    y: resolveNetY(point.cumulativeNet),
  }));
  const previousPoints = rawPreviousPoints.map((point) => ({
    ...point,
    y: resolveNetY(point.cumulativeNet),
  }));

  const linePath = buildAudiencePath(points.map((point) => ({ x: point.x, y: point.y })));
  const previousLinePath = buildAudiencePath(
    previousPoints.map((point) => ({ x: point.x, y: point.y })),
  );
  const zeroY = resolveNetY(0);
  const axisLabels = [
    { y: resolveNetY(rawMaxNet) + 4, label: formatSignedCount(Math.round(rawMaxNet)) },
    { y: zeroY + 4, label: '0' },
    { y: resolveNetY(rawMinNet) + 4, label: formatSignedCount(Math.round(rawMinNet)) },
  ].filter((label, index, labels) => {
    const duplicateIndex = labels.findIndex((item) => item.label === label.label);
    const overlapsPrevious = labels.slice(0, index).some((item) => Math.abs(item.y - label.y) < 12);
    return duplicateIndex === index && !overlapsPrevious;
  });

  return {
    points,
    previousPoints,
    linePath,
    areaPath: buildAudienceAreaPath(
      linePath,
      points.map((point) => ({ x: point.x, y: point.y })),
      lineFloor,
    ),
    previousLinePath,
    hasLine: points.length > 0,
    hasPreviousLine: previousPoints.length > 0,
    guideYs: [lineTop, Math.round((lineTop + lineBottom) / 2), lineBottom],
    dividerY,
    barsBaseline,
    eventRailY,
    zeroY,
    height,
    leftPad,
    rightPad,
    axisLabels,
  };
}

function buildViewsChart(stats: ChannelStatsResponse): {
  bars: ViewChartPoint[];
  previousBars: PreviousViewChartPoint[];
  aggregateBar: ViewChartAggregateBar | null;
  maxViews: number;
  cumulativeMax: number;
  cumulativeLinePath: string;
  cumulativeAreaPath: string;
  previousCumulativeLinePath: string;
  guideYs: number[];
  leftPad: number;
  rightPad: number;
  baselineY: number;
  eventRailY: number;
  height: number;
} {
  const series = stats.official.series.views;
  const previousSeries = stats.comparison.series?.views ?? [];
  if (series.length === 0) {
    return {
      bars: [],
      previousBars: [],
      aggregateBar: null,
      maxViews: 0,
      cumulativeMax: 0,
      cumulativeLinePath: '',
      cumulativeAreaPath: '',
      previousCumulativeLinePath: '',
      guideYs: [],
      leftPad: 10,
      rightPad: 8,
      baselineY: 176,
      eventRailY: 196,
      height: CHART_VIEWBOX_HEIGHT,
    };
  }

  const width = CHART_VIEWBOX_WIDTH;
  const height = CHART_VIEWBOX_HEIGHT;
  const leftPad = 10;
  const rightPad = 8;
  const topPad = 16;
  const bottomPad = 34;
  const plotWidth = width - leftPad - rightPad;
  const usableHeight = height - topPad - bottomPad;
  const baselineY = height - bottomPad;
  const displayViews = resolveChannelStatsDisplayViews(stats);
  const topPostMaxViews = Math.max(
    ...stats.official.content.topPosts.map((post) =>
      shouldUseChannelStatsPeriodViews(stats) ? post.viewsDelta : post.views || post.viewsDelta,
    ),
    0,
  );
  const currentMaxViews = Math.max(...series.map((item) => item.views), 0);
  const previousMaxViews = Math.max(...previousSeries.map((item) => item.views), 0);
  const maxBucketViews = Math.max(currentMaxViews, previousMaxViews);
  const aggregateViews = Math.max(displayViews, topPostMaxViews);
  const maxViews = currentMaxViews > 0 ? currentMaxViews : Math.max(previousMaxViews, aggregateViews);
  const cumulativeMax = Math.max(
    ...series.map((item) => item.cumulativeViews),
    maxBucketViews > 0 ? 0 : aggregateViews,
    0,
  );
  const scale = maxViews > 0 ? usableHeight / maxViews : 0;
  const cumulativeRange = Math.max(1, cumulativeMax);
  const resolveCumulativeY = (value: number) =>
    cumulativeMax > 0
      ? topPad + ((cumulativeMax - clamp(value, 0, cumulativeMax)) / cumulativeRange) * usableHeight
      : baselineY;

  const bars = series.map((item, index) => {
    const x =
      series.length === 1
        ? width / 2
        : leftPad + (plotWidth * index) / Math.max(1, series.length - 1);
    const barHeight = Math.min(item.views * scale, usableHeight);
    return {
      at: item.at,
      views: item.views,
      cumulativeViews: item.cumulativeViews,
      x,
      y: baselineY - barHeight,
      height: barHeight,
      cumulativeY: resolveCumulativeY(item.cumulativeViews),
    };
  });
  const previousBars = previousSeries.map((item, index) => {
    const x =
      previousSeries.length === 1
        ? width / 2
        : leftPad + (plotWidth * index) / Math.max(1, previousSeries.length - 1);
    const barHeight = Math.min(item.views * scale, usableHeight);
    return {
      at: item.at,
      views: item.views,
      cumulativeViews: item.cumulativeViews,
      x,
      y: baselineY - barHeight,
      height: barHeight,
      cumulativeY: resolveCumulativeY(item.cumulativeViews),
    };
  });
  const cumulativePoints = bars.map((bar) => ({ x: bar.x, y: bar.cumulativeY }));
  const cumulativeLinePath = buildAudiencePath(cumulativePoints);
  const previousCumulativePoints = previousBars.map((bar) => ({ x: bar.x, y: bar.cumulativeY }));
  const previousCumulativeLinePath = buildAudiencePath(previousCumulativePoints);
  const aggregateBar =
    maxBucketViews === 0 && aggregateViews > 0
      ? {
          x: leftPad,
          y: baselineY - usableHeight * 0.72,
          width: plotWidth,
          height: usableHeight * 0.72,
          views: aggregateViews,
        }
      : null;

  return {
    bars,
    previousBars,
    aggregateBar,
    maxViews,
    cumulativeMax,
    cumulativeLinePath,
    cumulativeAreaPath: buildAudienceAreaPath(cumulativeLinePath, cumulativePoints, baselineY),
    previousCumulativeLinePath,
    guideYs: [topPad, Math.round(topPad + usableHeight / 2)],
    leftPad,
    rightPad,
    baselineY,
    eventRailY: 196,
    height,
  };
}

function AudienceChart({ stats }: { stats: ChannelStatsResponse }) {
  const chart = buildAudienceChart(stats);
  const labels = chart.points;
  const [activeIndex, setActiveIndex] = useState(() =>
    resolveInitialAudienceChartIndex(chart.points),
  );
  const [isTooltipVisible, setIsTooltipVisible] = useState(false);

  useEffect(() => {
    setActiveIndex(resolveInitialAudienceChartIndex(chart.points));
  }, [
    chart.points.length,
    stats.channel.participantsCount,
    stats.official.audience.joined,
    stats.official.audience.left,
    stats.official.audience.net,
    stats.period.from,
    stats.period.to,
  ]);

  const safeActiveIndex = clamp(activeIndex, 0, Math.max(chart.points.length - 1, 0));
  const activePoint = chart.points[safeActiveIndex] ?? null;
  const previousIndex = resolveAlignedIndex(
    chart.previousPoints.length,
    safeActiveIndex,
    chart.points.length,
  );
  const activePreviousPoint = chart.previousPoints[previousIndex] ?? null;
  const hasLeftBars = chart.points.some((point) => point.left > 0);
  const visibleLabelIndices = resolveSparseLabelIndices(labels.length, safeActiveIndex);
  const slotWidth =
    chart.points.length > 1
      ? (CHART_VIEWBOX_WIDTH - chart.leftPad - chart.rightPad) /
        Math.max(1, chart.points.length - 1)
      : 44;
  const activeBandWidth = clamp(slotWidth * 0.72, 26, 40);
  const membershipBarWidth = clamp(slotWidth * 0.48, 5, 10);
  const activeMembershipBarWidth = clamp(slotWidth * 0.62, 7, 14);
  const activeParticipantsLabel = formatCount(activePoint?.participantsCount ?? null);
  const activeParticipantsCompactLabel = formatCompactCount(activePoint?.participantsCount ?? null);
  const hasActiveParticipantsCount =
    activePoint?.participantsCount !== null && activePoint?.participantsCount !== undefined;
  const activeNet = activePoint?.net ?? 0;
  const activeCumulativeNet = activePoint?.cumulativeNet ?? 0;
  const activeNetLabel = formatSignedCount(activeNet);
  const activeCumulativeNetLabel = formatSignedCount(activeCumulativeNet);
  const activeAudiencePrimaryLabel = hasActiveParticipantsCount
    ? `${activeParticipantsCompactLabel} подписчиков`
    : `${activeCumulativeNetLabel} за период`;
  const activeBucketLabel = stats.period.bucket === 'hour' ? 'За час' : 'За день';
  const activeBucketChipLabel = stats.period.bucket === 'hour' ? 'Час' : 'День';
  const activeParticipantDetail =
    activePoint?.participantsCount === null || activePoint?.participantsCount === undefined
      ? 'итоговая аудитория не снята'
      : `всего ${activeParticipantsLabel} участников`;
  const maxMembershipActivity = Math.max(
    ...chart.points.map((point) => point.joined + point.left),
    0,
  );
  const graphMarkers = resolveGraphMarkerPositions(
    stats.signals.markers,
    chart.points.map((point) => ({ at: point.at, x: point.x })),
    (marker) => marker.type !== 'post',
  );
  const postPins = resolvePostPinPositions(
    stats.official.content.topPosts,
    chart.points.map((point) => ({ at: point.at, x: point.x })),
    shouldUseChannelStatsPeriodViews(stats),
  );
  const activePostPin = resolveActivePostPin(postPins, activePoint?.x ?? null, slotWidth);
  const activeGuideLabel = activePoint
    ? `${formatChartDetailDate(
        activePoint.at,
        stats.period.bucket,
      )}: ${activeBucketLabel.toLocaleLowerCase('ru-RU')} ${activeNetLabel}, ${activeCumulativeNetLabel} за период, ${formatCount(
        activePoint.joined,
      )} пришли, ${formatCount(activePoint.left)} ушли, ${activeParticipantDetail}`
    : 'Данные по аудитории недоступны';
  const tooltipX = activePoint ? clamp((activePoint.x / CHART_VIEWBOX_WIDTH) * 100, 15, 85) : 50;
  const tooltipStyle = { '--tooltip-x': `${tooltipX}%` } as CSSProperties;

  return (
    <div className="channel-stats-graph">
      {chart.points.length === 0 ? (
        <div className="channel-stats-graph__empty">Пока нет данных за период.</div>
      ) : (
        <>
          <header className="channel-stats-graph__summary">
            <small className="channel-stats-graph__summary-date">
              {activePoint
                ? formatChartDetailDate(activePoint.at, stats.period.bucket)
                : 'Нет данных'}
            </small>
            <strong className="channel-stats-graph__summary-value">
              {activeAudiencePrimaryLabel}
            </strong>

            <div className="channel-stats-graph__summary-chips">
              <span className="channel-stats-graph__chip channel-stats-graph__chip--line">
                {activeBucketChipLabel} {activeNetLabel}
              </span>
              <span className="channel-stats-graph__chip channel-stats-graph__chip--joined">
                Вошли {formatCompactCount(activePoint?.joined ?? 0)}
              </span>
              {hasLeftBars ? (
                <span className="channel-stats-graph__chip channel-stats-graph__chip--left">
                  Вышли {formatCompactCount(activePoint?.left ?? 0)}
                </span>
              ) : null}
              {activePreviousPoint ? (
                <span className="channel-stats-graph__chip channel-stats-graph__chip--previous">
                  Пред. {formatSignedCompactCount(activePreviousPoint.cumulativeNet)}
                </span>
              ) : null}
              {hasActiveParticipantsCount ? (
                <span className="channel-stats-graph__chip channel-stats-graph__chip--muted channel-stats-graph__chip--audience-total">
                  Всего {activeParticipantsCompactLabel}
                </span>
              ) : null}
            </div>
          </header>

          <div
            className="channel-stats-graph__canvas channel-stats-graph__canvas--audience"
            tabIndex={0}
            role="slider"
            aria-label="Динамика аудитории"
            aria-valuemin={1}
            aria-valuemax={chart.points.length}
            aria-valuenow={safeActiveIndex + 1}
            aria-valuetext={activeGuideLabel}
            onPointerDown={(event) => {
              captureChartPointer(event);
              setIsTooltipVisible(true);
              setActiveIndex(
                readChartIndexFromPointer(
                  event,
                  chart.points.length,
                  chart.leftPad,
                  chart.rightPad,
                ),
              );
            }}
            onPointerMove={(event) => {
              if (event.buttons !== 1) {
                return;
              }

              setIsTooltipVisible(true);
              setActiveIndex(
                readChartIndexFromPointer(
                  event,
                  chart.points.length,
                  chart.leftPad,
                  chart.rightPad,
                ),
              );
            }}
            onPointerUp={() => setIsTooltipVisible(false)}
            onPointerCancel={() => setIsTooltipVisible(false)}
            onPointerLeave={() => setIsTooltipVisible(false)}
            onBlur={() => setIsTooltipVisible(false)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowLeft') {
                event.preventDefault();
                setIsTooltipVisible(true);
                setActiveIndex((current) => clamp(current - 1, 0, chart.points.length - 1));
              }

              if (event.key === 'ArrowRight') {
                event.preventDefault();
                setIsTooltipVisible(true);
                setActiveIndex((current) => clamp(current + 1, 0, chart.points.length - 1));
              }
            }}
          >
            {activePoint && isTooltipVisible ? (
              <div className="channel-stats-graph__tooltip" style={tooltipStyle}>
                <small>{formatChartDetailDate(activePoint.at, stats.period.bucket)}</small>
                <strong>
                  {hasActiveParticipantsCount
                    ? `${activeParticipantsLabel} подписчиков`
                    : `Баланс ${activeCumulativeNetLabel}`}
                </strong>
                <span>
                  Баланс {activeCumulativeNetLabel} · {activeBucketLabel.toLocaleLowerCase('ru-RU')}{' '}
                  {activeNetLabel} · +{formatCount(activePoint.joined)} / -
                  {formatCount(activePoint.left)}
                </span>
                {activePoint.participantsCount !== null ? (
                  <em>Всего: {activeParticipantsLabel} участников</em>
                ) : null}
                {activePreviousPoint ? (
                  <em>Прошлый период: {formatSignedCount(activePreviousPoint.cumulativeNet)}</em>
                ) : null}
                {activePostPin ? (
                  <em title={`${activePostPin.label} · ${activePostPin.detail}`}>
                    {activePostPin.label} · {activePostPin.detail}
                  </em>
                ) : null}
              </div>
            ) : null}

            <svg
              viewBox={`0 0 ${CHART_VIEWBOX_WIDTH} ${chart.height}`}
              className="channel-stats-graph__svg"
              aria-hidden
            >
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
                  height={chart.eventRailY - chart.guideYs[0]! + 12}
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
                  x2={CHART_VIEWBOX_WIDTH - chart.rightPad}
                  y2={y}
                  className="channel-stats-graph__grid"
                />
              ))}
              <line
                x1={chart.leftPad}
                y1={chart.zeroY}
                x2={CHART_VIEWBOX_WIDTH - chart.rightPad}
                y2={chart.zeroY}
                className="channel-stats-graph__zero-line"
              />
              <line
                x1={chart.leftPad}
                y1={chart.dividerY}
                x2={CHART_VIEWBOX_WIDTH - chart.rightPad}
                y2={chart.dividerY}
                className="channel-stats-graph__divider"
              />
              <line
                x1={chart.leftPad}
                y1={chart.barsBaseline}
                x2={CHART_VIEWBOX_WIDTH - chart.rightPad}
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
                    x={
                      point.x -
                      (safeActiveIndex === index ? activeMembershipBarWidth : membershipBarWidth) /
                        2
                    }
                    y={point.joinedTop}
                    width={
                      safeActiveIndex === index ? activeMembershipBarWidth : membershipBarWidth
                    }
                    height={point.joinedHeight}
                    rx="4.5"
                    className={`channel-stats-graph__bar channel-stats-graph__bar--joined ${
                      safeActiveIndex === index ? 'is-active' : ''
                    }`}
                  />
                  {point.leftHeight > 0 ? (
                    <rect
                      x={
                        point.x -
                        (safeActiveIndex === index
                          ? activeMembershipBarWidth
                          : membershipBarWidth) /
                          2
                      }
                      y={point.leftTop}
                      width={
                        safeActiveIndex === index ? activeMembershipBarWidth : membershipBarWidth
                      }
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
                y1={chart.eventRailY}
                x2={CHART_VIEWBOX_WIDTH - chart.rightPad}
                y2={chart.eventRailY}
                className="channel-stats-graph__event-rail"
              />
              {chart.hasPreviousLine ? (
                <path
                  d={chart.previousLinePath}
                  className="channel-stats-graph__line channel-stats-graph__line--previous"
                />
              ) : null}
              {chart.points.map((point, index) => {
                const activity = point.joined + point.left;
                const tone =
                  point.left > point.joined ? 'left' : point.joined > 0 ? 'joined' : 'neutral';
                const opacity =
                  safeActiveIndex === index
                    ? 0.96
                    : maxMembershipActivity > 0
                      ? clamp(activity / maxMembershipActivity, 0.16, 0.58)
                      : 0.16;

                return (
                  <circle
                    key={`event-${labels[index]?.at ?? index}`}
                    cx={point.x}
                    cy={chart.eventRailY}
                    r={safeActiveIndex === index ? 4.4 : 2.8}
                    style={{ opacity }}
                    className={`channel-stats-graph__event-dot channel-stats-graph__event-dot--${tone} ${
                      safeActiveIndex === index ? 'is-active' : ''
                    }`}
                  />
                );
              })}
              {postPins.map((pin) => (
                <g
                  key={pin.messageId}
                  className={`channel-stats-graph__post-marker channel-stats-graph__post-marker--${
                    pin.tone
                  } ${activePostPin?.messageId === pin.messageId ? 'is-active' : ''}`}
                  transform={`translate(${pin.x.toFixed(2)} ${chart.eventRailY - 17})`}
                >
                  <title>{`${pin.label} · ${pin.detail}`}</title>
                  <line x1="0" y1="9" x2="0" y2="17" />
                  <circle cx="0" cy="5" r="4.5" />
                </g>
              ))}
              {graphMarkers.map((marker) => (
                <g key={`${marker.code}-${marker.at}`} aria-hidden="true">
                  <path
                    d={`M ${marker.x.toFixed(2)} ${(chart.dividerY - 28).toFixed(
                      2,
                    )} l 5 5 l -5 5 l -5 -5 Z`}
                    className={`channel-stats-graph__marker channel-stats-graph__marker--${marker.tone}`}
                  >
                    <title>{`${marker.label} ${marker.value}`}</title>
                  </path>
                </g>
              ))}
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
            {activePreviousPoint
              ? `${activeGuideLabel}. Прошлый период: ${formatSignedCount(
                  activePreviousPoint.cumulativeNet,
                )}.`
              : activeGuideLabel}
          </output>
        </>
      )}
    </div>
  );
}

function ViewsChart({ stats }: { stats: ChannelStatsResponse }) {
  const chart = buildViewsChart(stats);
  const labels = stats.official.series.views;
  const [activeIndex, setActiveIndex] = useState(() => resolveInitialViewsChartIndex(chart.bars));
  const [isTooltipVisible, setIsTooltipVisible] = useState(false);

  useEffect(() => {
    setActiveIndex(resolveInitialViewsChartIndex(chart.bars));
  }, [
    chart.bars.length,
    stats.official.content.views,
    stats.official.content.viewsTotal,
    stats.official.content.viewsMode,
    stats.official.content.lastPublishedAt,
    stats.period.from,
    stats.period.to,
  ]);

  const safeActiveIndex = clamp(activeIndex, 0, Math.max(chart.bars.length - 1, 0));
  const activeBar = chart.bars[safeActiveIndex] ?? null;
  const previousIndex = resolveAlignedIndex(
    chart.previousBars.length,
    safeActiveIndex,
    chart.bars.length,
  );
  const activePreviousBar = chart.previousBars[previousIndex] ?? null;
  const visibleLabelIndices = resolveSparseLabelIndices(labels.length, safeActiveIndex);
  const hasBucketViews = chart.bars.some((bar) => bar.views > 0);
  const displayViews = resolveChannelStatsDisplayViews(stats);
  const displayViewsCompactLabel = formatCompactCount(displayViews);
  const periodViews = stats.official.content.views;
  const totalPostViews = stats.official.content.viewsTotal;
  const averageViewsPerPost =
    stats.comparison.deltas.averageViewsPerPost.current ||
    (stats.official.content.posts > 0
      ? Math.round(displayViews / stats.official.content.posts)
      : 0);
  const graphMarkers = resolveGraphMarkerPositions(
    stats.signals.markers,
    chart.bars.map((bar) => ({ at: bar.at, x: bar.x })),
    (marker) => marker.type === 'post' || marker.type === 'peak',
  );
  const postPins = resolvePostPinPositions(
    stats.official.content.topPosts,
    chart.bars.map((bar) => ({ at: bar.at, x: bar.x })),
    shouldUseChannelStatsPeriodViews(stats),
  );
  const slotWidth =
    chart.bars.length > 1
      ? (CHART_VIEWBOX_WIDTH - chart.leftPad - chart.rightPad) / Math.max(1, chart.bars.length - 1)
      : 44;
  const activeBandWidth = clamp(slotWidth * 0.76, 28, 44);
  const previousBarWidth = clamp(slotWidth * 0.54, 4, 15);
  const viewBarWidth = clamp(slotWidth * 0.68, 5, 18);
  const activeViewBarWidth = clamp(slotWidth * 0.82, 7, 22);
  const activeViewsCompactLabel = formatCompactCount(activeBar?.views ?? null);
  const activeCumulativeCompactLabel = formatCompactCount(
    activeBar?.cumulativeViews ?? chart.cumulativeMax,
  );
  const viewsModeLabel = resolveChannelStatsViewsModeLabel(stats);
  const viewsCumulativeLabel = shouldUseChannelStatsPeriodViews(stats) ? 'Накоплено' : 'Сумма';
  const viewsCumulativeChipLabel = shouldUseChannelStatsPeriodViews(stats) ? 'Итог' : 'Сумма';
  const chartPeriodLabel = stats.period.range === '24h' ? '24 часа' : stats.period.range;
  const activePostPin = resolveActivePostPin(postPins, activeBar?.x ?? null, slotWidth);
  const tooltipX = activeBar ? clamp((activeBar.x / CHART_VIEWBOX_WIDTH) * 100, 15, 85) : 50;
  const tooltipStyle = { '--tooltip-x': `${tooltipX}%` } as CSSProperties;
  const activeGuideLabel = activeBar
    ? `${formatChartDetailDate(activeBar.at, stats.period.bucket)}: ${formatCount(
        activeBar.views,
      )} просмотров в точке, ${formatCount(displayViews)} просмотров ${viewsModeLabel}`
    : 'Данные по просмотрам недоступны';
  return (
    <div className="channel-stats-graph">
      {chart.bars.length === 0 ? (
        <div className="channel-stats-graph__empty">Пока нет постов за период.</div>
      ) : (
        <>
          <header className="channel-stats-graph__summary">
            <small className="channel-stats-graph__summary-date">
              Просмотры {viewsModeLabel} · {chartPeriodLabel}
            </small>
            <strong className="channel-stats-graph__summary-value">
              {displayViewsCompactLabel} просмотров
            </strong>

            <div className="channel-stats-graph__summary-chips">
              <span className="channel-stats-graph__chip channel-stats-graph__chip--views">
                Пик {formatCompactCount(chart.maxViews)}
              </span>
              <span className="channel-stats-graph__chip channel-stats-graph__chip--muted">
                Ср./пост {formatCompactCount(averageViewsPerPost)}
              </span>
              {shouldUseChannelStatsPeriodViews(stats) && totalPostViews > displayViews ? (
                <span className="channel-stats-graph__chip channel-stats-graph__chip--muted channel-stats-graph__chip--total">
                  Всего {formatCompactCount(totalPostViews)}
                </span>
              ) : null}
              {!shouldUseChannelStatsPeriodViews(stats) && periodViews > 0 ? (
                <span className="channel-stats-graph__chip channel-stats-graph__chip--muted">
                  Период {formatCompactCount(periodViews)}
                </span>
              ) : null}
              {hasBucketViews ? (
                <span className="channel-stats-graph__chip channel-stats-graph__chip--muted channel-stats-graph__chip--cumulative">
                  {viewsCumulativeChipLabel} {activeCumulativeCompactLabel}
                </span>
              ) : null}
              {activeBar ? (
                <span className="channel-stats-graph__chip channel-stats-graph__chip--muted channel-stats-graph__chip--point">
                  Точка {activeViewsCompactLabel}
                </span>
              ) : null}
              {activePreviousBar ? (
                <span className="channel-stats-graph__chip channel-stats-graph__chip--previous">
                  Пред. {formatCompactCount(activePreviousBar.views)}
                </span>
              ) : null}
            </div>
          </header>

          <div
            className="channel-stats-graph__canvas"
            tabIndex={0}
            role="slider"
            aria-label="Охват публикаций"
            aria-valuemin={1}
            aria-valuemax={chart.bars.length}
            aria-valuenow={safeActiveIndex + 1}
            aria-valuetext={activeGuideLabel}
            onPointerDown={(event) => {
              captureChartPointer(event);
              setIsTooltipVisible(true);
              setActiveIndex(
                readChartIndexFromPointer(event, chart.bars.length, chart.leftPad, chart.rightPad),
              );
            }}
            onPointerMove={(event) => {
              if (event.buttons !== 1) {
                return;
              }

              setIsTooltipVisible(true);
              setActiveIndex(
                readChartIndexFromPointer(event, chart.bars.length, chart.leftPad, chart.rightPad),
              );
            }}
            onPointerUp={() => setIsTooltipVisible(false)}
            onPointerCancel={() => setIsTooltipVisible(false)}
            onPointerLeave={() => setIsTooltipVisible(false)}
            onBlur={() => setIsTooltipVisible(false)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowLeft') {
                event.preventDefault();
                setIsTooltipVisible(true);
                setActiveIndex((current) => clamp(current - 1, 0, chart.bars.length - 1));
              }

              if (event.key === 'ArrowRight') {
                event.preventDefault();
                setIsTooltipVisible(true);
                setActiveIndex((current) => clamp(current + 1, 0, chart.bars.length - 1));
              }
            }}
          >
            {activeBar && isTooltipVisible ? (
              <div className="channel-stats-graph__tooltip" style={tooltipStyle}>
                <small>{formatChartDetailDate(activeBar.at, stats.period.bucket)}</small>
                <strong>{activeViewsCompactLabel} просмотров</strong>
                <span>
                  {viewsModeLabel} · {viewsCumulativeLabel.toLocaleLowerCase('ru-RU')}{' '}
                  {activeCumulativeCompactLabel}
                </span>
                {activePreviousBar ? (
                  <em>Прошлый: {formatCompactCount(activePreviousBar.views)}</em>
                ) : null}
                {activePostPin ? (
                  <em title={`${activePostPin.label} · ${activePostPin.detail}`}>
                    {activePostPin.label} · {activePostPin.detail}
                  </em>
                ) : null}
              </div>
            ) : null}

            <svg
              viewBox={`0 0 ${CHART_VIEWBOX_WIDTH} ${chart.height}`}
              className="channel-stats-graph__svg"
              aria-hidden
            >
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
              {activeBar && hasBucketViews ? (
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
                  x2={CHART_VIEWBOX_WIDTH - chart.rightPad}
                  y2={y}
                  className="channel-stats-graph__grid"
                />
              ))}
              <line
                x1={chart.leftPad}
                y1={chart.baselineY}
                x2={CHART_VIEWBOX_WIDTH - chart.rightPad}
                y2={chart.baselineY}
                className="channel-stats-graph__baseline"
              />
              {hasBucketViews && chart.cumulativeAreaPath ? (
                <path
                  d={chart.cumulativeAreaPath}
                  className="channel-stats-graph__area channel-stats-graph__area--views-cumulative"
                />
              ) : null}
              {hasBucketViews && chart.previousCumulativeLinePath ? (
                <path
                  d={chart.previousCumulativeLinePath}
                  className="channel-stats-graph__line channel-stats-graph__line--previous"
                />
              ) : null}
              {hasBucketViews && chart.cumulativeLinePath ? (
                <path
                  d={chart.cumulativeLinePath}
                  className="channel-stats-graph__line-glow channel-stats-graph__line-glow--views"
                />
              ) : null}
              {activeBar && hasBucketViews ? (
                <line
                  x1={activeBar.x}
                  y1={chart.guideYs[0]!}
                  x2={activeBar.x}
                  y2={chart.baselineY}
                  className="channel-stats-graph__active-guide channel-stats-graph__active-guide--views"
                />
              ) : null}
              {chart.aggregateBar ? (
                <g className="channel-stats-graph__aggregate">
                  <rect
                    x={chart.aggregateBar.x}
                    y={chart.aggregateBar.y}
                    width={chart.aggregateBar.width}
                    height={chart.aggregateBar.height}
                    rx="16"
                    className="channel-stats-graph__aggregate-bar"
                  />
                  <text
                    x={chart.aggregateBar.x + 14}
                    y={chart.aggregateBar.y + 27}
                    className="channel-stats-graph__aggregate-text"
                  >
                    {displayViewsCompactLabel} просмотров
                  </text>
                  <text
                    x={chart.aggregateBar.x + 14}
                    y={chart.aggregateBar.y + 45}
                    className="channel-stats-graph__aggregate-caption"
                  >
                    {viewsModeLabel}
                  </text>
                </g>
              ) : null}
              {chart.previousBars.map((bar, index) => (
                <rect
                  key={`previous-${bar.at}-${index}`}
                  x={bar.x - previousBarWidth / 2}
                  y={bar.y}
                  width={previousBarWidth}
                  height={bar.views > 0 ? Math.max(3, bar.height) : 0}
                  rx="5"
                  className="channel-stats-graph__bar channel-stats-graph__bar--previous"
                />
              ))}
              {chart.bars.map((bar, index) => (
                <rect
                  key={labels[index]?.at ?? index}
                  x={bar.x - (safeActiveIndex === index ? activeViewBarWidth : viewBarWidth) / 2}
                  y={bar.y}
                  width={safeActiveIndex === index ? activeViewBarWidth : viewBarWidth}
                  height={bar.views > 0 ? Math.max(4, bar.height) : 0}
                  rx="6"
                  className={`channel-stats-graph__bar channel-stats-graph__bar--views ${
                    safeActiveIndex === index ? 'is-active' : ''
                  }`}
                />
              ))}
              {hasBucketViews && chart.cumulativeLinePath ? (
                <path
                  d={chart.cumulativeLinePath}
                  className="channel-stats-graph__line channel-stats-graph__line--views-cumulative"
                />
              ) : null}
              {activeBar && hasBucketViews ? (
                <circle
                  cx={activeBar.x}
                  cy={activeBar.cumulativeY}
                  r="8"
                  className="channel-stats-graph__dot-pulse channel-stats-graph__dot-pulse--views"
                />
              ) : null}
              {activeBar && hasBucketViews ? (
                <circle
                  cx={activeBar.x}
                  cy={activeBar.cumulativeY}
                  r="4.3"
                  className="channel-stats-graph__dot channel-stats-graph__dot--views is-active"
                />
              ) : null}
              {graphMarkers.map((marker) => (
                <g key={`${marker.code}-${marker.at}`} aria-hidden="true">
                  <path
                    d={`M ${marker.x.toFixed(2)} ${(chart.baselineY + 17).toFixed(
                      2,
                    )} l 4.8 -8.4 l 4.8 8.4 Z`}
                    className={`channel-stats-graph__marker channel-stats-graph__marker--${marker.tone}`}
                  >
                    <title>{`${marker.label} ${marker.value}`}</title>
                  </path>
                </g>
              ))}
              <line
                x1={chart.leftPad}
                y1={chart.eventRailY}
                x2={CHART_VIEWBOX_WIDTH - chart.rightPad}
                y2={chart.eventRailY}
                className="channel-stats-graph__event-rail"
              />
              {postPins.map((pin) => (
                <g
                  key={pin.messageId}
                  className={`channel-stats-graph__post-marker channel-stats-graph__post-marker--${
                    pin.tone
                  } ${activePostPin?.messageId === pin.messageId ? 'is-active' : ''}`}
                  transform={`translate(${pin.x.toFixed(2)} ${chart.eventRailY - 17})`}
                >
                  <title>{`${pin.label} · ${pin.detail}`}</title>
                  <line x1="0" y1="9" x2="0" y2="17" />
                  <circle cx="0" cy="5" r="4.5" />
                </g>
              ))}
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
            {activePreviousBar
              ? `${activeGuideLabel}. Прошлый период: ${formatCount(
                  activePreviousBar.views,
                )} просмотров.`
              : activeGuideLabel}
          </output>
        </>
      )}
    </div>
  );
}

function TopPostsChart({ stats }: { stats: ChannelStatsResponse }) {
  const posts = stats.official.content.topPosts;
  const isPeriodViews = shouldUseChannelStatsPeriodViews(stats);
  const resolvePostViews = (
    post: ChannelStatsResponse['official']['content']['topPosts'][number],
  ) => (isPeriodViews ? post.viewsDelta : post.views);
  const maxViews = Math.max(...posts.map(resolvePostViews), 0);

  if (posts.length === 0) {
    return (
      <div className="channel-posts-chart">
        <div className="channel-stats-graph__empty">Пока нет публикаций за период.</div>
      </div>
    );
  }

  return (
    <div className="channel-posts-chart">
      <div className="channel-posts-chart__list">
        {posts.map((post, index) => {
          const value = resolvePostViews(post);
          const width = maxViews > 0 && value > 0 ? Math.max(5, (value / maxViews) * 100) : 0;
          const valueLabel = formatCompactCount(value);
          const detailParts = [
            `${formatCount(value)} просмотров ${isPeriodViews ? 'за период' : 'всего'}`,
          ];
          const metaParts = [`${formatCount(post.reactions)} реакц.`];

          if (isPeriodViews && post.views > value) {
            detailParts.push(`${formatCount(post.views)} всего`);
            metaParts.push(`${formatCompactCount(post.views)} всего`);
          }

          const row = (
            <>
              <div className="channel-posts-chart__row-head">
                <span className="channel-posts-chart__rank">#{index + 1}</span>
                <span className="channel-posts-chart__title">
                  {formatPostDateTime(post.publishedAt)}
                </span>
                <strong>{valueLabel}</strong>
              </div>
              <div className="channel-posts-chart__bar" aria-hidden="true">
                <span style={{ width: `${width}%` }} />
              </div>
              <div className="channel-posts-chart__row-meta">
                {metaParts.map((part) => (
                  <small key={part}>{part}</small>
                ))}
              </div>
            </>
          );
          const rowLabel = `Публикация ${index + 1}, ${formatPostDateTime(
            post.publishedAt,
          )}: ${detailParts.join(', ')}, ${formatCount(post.reactions)} реакций`;

          return post.url ? (
            <a
              key={post.messageId}
              href={post.url}
              target="_blank"
              rel="noreferrer"
              className="channel-posts-chart__row"
              aria-label={rowLabel}
            >
              {row}
            </a>
          ) : (
            <article
              key={post.messageId}
              className="channel-posts-chart__row"
              aria-label={rowLabel}
            >
              {row}
            </article>
          );
        })}
      </div>
    </div>
  );
}

function ChannelStatsOverview({
  stats,
  range,
  chartTab,
  onRangeChange,
  onChartTabChange,
}: {
  stats: ChannelStatsResponse;
  range: ChannelStatsRange;
  chartTab: ChartTab;
  onRangeChange: (range: ChannelStatsRange) => void;
  onChartTabChange: (tab: ChartTab) => void;
}) {
  const chartTabs = audienceTabOptions.filter((option) => {
    if (option.value === 'views') {
      return stats.meta.viewsAvailable;
    }

    return true;
  });
  const effectiveChartTab: ChartTab =
    stats.meta.viewsAvailable && chartTabs.some((option) => option.value === chartTab)
      ? chartTab
      : 'audience';
  const audienceJoined = stats.official.audience.joined ?? 0;
  const audienceLeft = stats.official.audience.left ?? 0;
  const audienceNet = stats.official.audience.net ?? audienceJoined - audienceLeft;
  const netTone = audienceNet > 0 ? 'success' : audienceNet < 0 ? 'danger' : 'neutral';
  const engagementRate =
    stats.meta.viewsAvailable && resolveChannelStatsDisplayViews(stats) > 0
      ? (stats.official.content.reactions / resolveChannelStatsDisplayViews(stats)) * 100
      : null;
  const viewsPerPost =
    stats.meta.viewsAvailable && stats.official.content.posts > 0
      ? Math.round(resolveChannelStatsDisplayViews(stats) / stats.official.content.posts)
      : null;
  const viewsMetricSuffix = resolveChannelStatsViewsModeLabel(stats);
  const chartTitle = 'Аналитика';

  return (
    <section
      className="channel-insights__summary channel-insights__summary--command stagger-in"
      aria-label="Сводка по каналу"
    >
      <article className="channel-insights__chart-card channel-insights__chart-card--executive">
        <header className="channel-insights__chart-header">
          <strong className="channel-insights__chart-title">{chartTitle}</strong>

          <div className="channel-insights__chart-controls">
            {chartTabs.length > 1 ? (
              <SegmentedControl
                value={effectiveChartTab}
                options={chartTabs}
                onChange={(next) => onChartTabChange(next as ChartTab)}
                className="channel-insights__switch"
              />
            ) : null}
            <SegmentedControl
              value={range}
              options={periodOptions}
              onChange={(next) => onRangeChange(next as ChannelStatsRange)}
              className="channel-insights__range"
            />
          </div>
        </header>

        {effectiveChartTab === 'audience' ? (
          <AudienceChart stats={stats} />
        ) : (
          <ViewsChart stats={stats} />
        )}
      </article>

      <div className="channel-insights__kpi-grid">
        <article className="channel-insights__kpi-card channel-insights__kpi-card--live">
          <div className="channel-insights__kpi-top">
            <small>Подписчики</small>
            <span className="channel-insights__kpi-icon" aria-hidden="true">
              <IconCommunity width={17} height={17} strokeWidth={2.05} />
            </span>
          </div>
          <strong>{formatCompactCount(stats.channel.participantsCount)}</strong>
          <span>{formatCount(stats.channel.participantsCount)}</span>
        </article>

        <article className={`channel-insights__kpi-card channel-insights__kpi-card--${netTone}`}>
          <div className="channel-insights__kpi-top">
            <small>Прирост</small>
            <span className="channel-insights__kpi-icon" aria-hidden="true">
              <IconGraphUp width={17} height={17} strokeWidth={2.05} />
            </span>
          </div>
          <strong>{formatSignedCount(audienceNet)}</strong>
          <span>
            <DeltaBadge metric={stats.comparison.deltas.audienceNet} />
            <b>
              +{formatCount(audienceJoined)} / -{formatCount(audienceLeft)}
            </b>
          </span>
        </article>

        <article className="channel-insights__kpi-card channel-insights__kpi-card--views">
          <div className="channel-insights__kpi-top">
            <small>{stats.meta.viewsAvailable ? 'Просм./пост' : 'Посты'}</small>
            <span className="channel-insights__kpi-icon" aria-hidden="true">
              <IconEye width={17} height={17} strokeWidth={2.05} />
            </span>
          </div>
          <strong>
            {stats.meta.viewsAvailable
              ? formatCompactCount(viewsPerPost)
              : formatCount(stats.official.content.posts)}
          </strong>
          <span>
            {stats.meta.viewsAvailable ? (
              <>
                <DeltaBadge metric={stats.comparison.deltas.averageViewsPerPost} />
                <b>
                  {formatCompactCount(resolveChannelStatsDisplayViews(stats))} {viewsMetricSuffix}
                </b>
              </>
            ) : (
              <DeltaBadge metric={stats.comparison.deltas.posts} />
            )}
          </span>
        </article>

        <article className="channel-insights__kpi-card channel-insights__kpi-card--reactions">
          <div className="channel-insights__kpi-top">
            <small>{stats.meta.viewsAvailable ? 'ER' : 'Реакции'}</small>
            <span className="channel-insights__kpi-icon" aria-hidden="true">
              <IconPercentageCircle width={17} height={17} strokeWidth={2.05} />
            </span>
          </div>
          <strong>
            {engagementRate !== null
              ? formatPercent(engagementRate)
              : formatCompactCount(stats.official.content.reactions)}
          </strong>
          <span>
            <DeltaBadge metric={stats.comparison.deltas.reactions} />
            <b>
              {stats.meta.viewsAvailable
                ? formatCompactCount(stats.official.content.reactions)
                : `${formatCount(stats.official.content.posts)} постов`}
            </b>
          </span>
        </article>
      </div>

      <ChannelSourceStrip stats={stats} />

      <article className="channel-fact-panel channel-top-posts-panel">
        <div className="channel-insights__panel-head">
          <div className="channel-insights__panel-copy">
            <strong>Топ публикаций</strong>
          </div>
        </div>
        <TopPostsChart stats={stats} />
      </article>

      <ChannelBestWindowsPanel stats={stats} />
    </section>
  );
}

export function ChannelStatsPage({ api }: { api: ApiTransport }) {
  const { chatId = '' } = useParams();
  const location = useLocation();
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const routeState = getRouteState(location.state);
  const [range, setRange] = useState<ChannelStatsRange>('7d');
  const [section, setSection] = useState<ChannelStatsSection>(() =>
    getInitialSection(location.search),
  );
  const [chartTab, setChartTab] = useState<ChartTab>('audience');
  const { isCompact: isHeaderCompact, isHidden: isHeaderHidden } = useAutoHideHeader({
    compactAfter: 12,
    hideAfter: 72,
    hideDistance: 44,
    revealDistance: 6,
  });

  const statsQuery = useQuery({
    queryKey: queryKeys.channelStats(chatId, range),
    queryFn: ({ signal }) =>
      getChannelStats(
        api,
        chatId,
        range,
        { signal },
        {
          includeActivityPreview: false,
          includeIntelligence: false,
        },
      ),
    enabled: Boolean(chatId),
    staleTime: 30_000,
    placeholderData: (previousData) => previousData,
    refetchInterval: (query) => (query.state.data?.meta.refreshQueued ? 5_000 : false),
    refetchOnWindowFocus: false,
  });
  const activityFeed = useMembershipActivityFeed({
    enabled: Boolean(chatId) && section === 'events',
    range,
    initialPage: null,
    loadPage: (query, request) => getChannelActivityFeed(api, chatId, query, request),
  });

  useEffect(() => {
    if (!chatId || section !== 'overview') {
      return undefined;
    }

    let cancelled = false;
    void readStatsSnapshot<ChannelStatsResponse>('channel', [chatId, range]).then((snapshot) => {
      if (cancelled || !snapshot) {
        return;
      }

      const queryKey = queryKeys.channelStats(chatId, range);
      if (!queryClient.getQueryData(queryKey)) {
        queryClient.setQueryData(queryKey, snapshot);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [chatId, queryClient, range, section]);

  useEffect(() => {
    if (!chatId || !statsQuery.data) {
      return;
    }

    saveStatsSnapshot('channel', [chatId, range], statsQuery.data);
  }, [chatId, range, statsQuery.data]);

  useEffect(() => {
    document.body.classList.add('channel-stats-page-open');

    return () => {
      document.body.classList.remove('channel-stats-page-open');
    };
  }, []);

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

  const stats = statsQuery.data ?? null;
  const loadedActivitySummary = useMemo(() => {
    const joined = activityFeed.items.reduce(
      (count, item) => count + (item.type === 'joined' ? 1 : 0),
      0,
    );
    const left = activityFeed.items.reduce(
      (count, item) => count + (item.type === 'left' ? 1 : 0),
      0,
    );

    return {
      total: activityFeed.items.length,
      joined,
      left,
      balance: joined - left,
    };
  }, [activityFeed.items]);

  const activitySummary = useMemo(() => {
    if (!stats) {
      return loadedActivitySummary;
    }

    const joined = stats.official.audience.joined;
    const left = stats.official.audience.left ?? 0;
    const balance = stats.official.audience.net ?? joined - left;

    return {
      total: joined + left,
      joined,
      left,
      balance,
    };
  }, [loadedActivitySummary, stats]);

  const activityBalance = activitySummary.balance;
  const activityBalanceTone =
    activityBalance > 0 ? 'success' : activityBalance < 0 ? 'danger' : 'neutral';
  const activityBalanceLabel =
    activityBalance > 0 ? 'Рост аудитории' : activityBalance < 0 ? 'Отток аудитории' : 'Без сдвига';
  const profileHandoffMutation = useMutation({
    mutationFn: ({ userId, displayName }: { userId: string; displayName: string }) =>
      handoffChannelMemberProfile(api, chatId, userId, { displayName }),
    onSuccess: (result) => {
      if (!openMaxBotLinkAndClose(result.botUrl)) {
        pushToast({
          tone: 'danger',
          title: 'Не удалось открыть бота',
        });
      }
    },
    onError: (error: unknown) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось открыть профиль',
        description: error instanceof Error ? error.message : 'Попробуйте ещё раз.',
      });
    },
  });

  const activateChannelProfile = (item: MembershipActivityItem) => {
    const normalizedUserId = item.userId.trim();
    if (!normalizedUserId || !chatId) {
      return;
    }

    const displayName = item.userDisplayName.trim() || 'Участник';
    const handoffUrl = item.profileHandoffUrl?.trim() ?? '';
    if (handoffUrl) {
      handoffChannelMemberProfileKeepalive(api, chatId, normalizedUserId, { displayName });
      if (openMaxBotLinkAndClose(handoffUrl)) {
        return;
      }
    }

    profileHandoffMutation.mutate({
      userId: normalizedUserId,
      displayName,
    });
  };

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

  if (section === 'overview' && statsQuery.isLoading && !stats) {
    return (
      <div className="page-stack page-enter">
        <GlassCard className="settings-section">
          <SkeletonCard lines={12} />
        </GlassCard>
      </div>
    );
  }

  if (section === 'overview' && statsQuery.error && !stats) {
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

  const handleSectionChange = (nextSection: ChannelStatsSection) => {
    if (nextSection === section) {
      return;
    }

    startTransition(() => {
      setSection(nextSection);
    });
  };
  const handleActivityFilterChange = (nextFilter: Parameters<typeof activityFeed.setFilter>[0]) => {
    if (nextFilter === activityFeed.filter) {
      return;
    }

    startTransition(() => {
      activityFeed.setFilter(nextFilter);
    });
  };
  const isBusy =
    section === 'events'
      ? activityFeed.isReloading || activityFeed.isLoadingMore
      : statsQuery.isFetching;

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
            avatarUrl={stats?.channel.avatarUrl ?? routeState.avatarUrl ?? null}
            className="compact-page-header__entity-avatar"
          />
        }
        compact={isHeaderCompact}
        hidden={isHeaderHidden}
        className="channel-insights__sticky-header"
        aside={
          isBusy ? (
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
        {/* Product rule: factual analytics only, no smart advice or "what to do next" copy. */}
        <SegmentedControl
          value={section}
          options={sectionOptions}
          onChange={(next) => handleSectionChange(next as ChannelStatsSection)}
          className="channel-insights__section-tabs"
        />

        {section === 'events' ? (
          <section className="channel-events-section stagger-in" aria-label="События канала">
            <div className="channel-events-section__head">
              <div className="channel-events-section__head-main">
                <div className="channel-insights__summary-copy channel-events-section__headline">
                  <h2>События</h2>
                  {stats ? <p>{formatPeriodRange(stats.period.from, stats.period.to)}</p> : null}
                </div>

                <div
                  className={`channel-events-section__balance channel-events-section__balance--${activityBalanceTone}`}
                  aria-label={`Баланс: ${formatSignedCount(activityBalance)}`}
                >
                  <small>Баланс</small>
                  <strong>{formatSignedCount(activityBalance)}</strong>
                  <span>{activityBalanceLabel}</span>
                </div>
              </div>

              <SegmentedControl
                value={range}
                options={periodOptions}
                onChange={(next) => setRange(next as ChannelStatsRange)}
                className="channel-insights__range"
              />
            </div>

            <div
              className="channel-events-section__metrics"
              aria-label="Сводка загруженных событий"
            >
              <span className="channel-events-section__metric channel-events-section__metric--total">
                <span className="channel-events-section__metric-icon" aria-hidden="true">
                  <IconActivity width={17} height={17} strokeWidth={2.05} />
                </span>
                <small>Событий</small>
                <strong>{formatCount(activitySummary.total)}</strong>
              </span>
              <span className="channel-events-section__metric channel-events-section__metric--joined">
                <span className="channel-events-section__metric-icon" aria-hidden="true">
                  <IconUserPlus width={17} height={17} strokeWidth={2.05} />
                </span>
                <small>Вошли</small>
                <strong>{formatCount(activitySummary.joined)}</strong>
              </span>
              <span className="channel-events-section__metric channel-events-section__metric--left">
                <span className="channel-events-section__metric-icon" aria-hidden="true">
                  <IconUserXmark width={17} height={17} strokeWidth={2.05} />
                </span>
                <small>Вышли</small>
                <strong>{formatCount(activitySummary.left)}</strong>
              </span>
            </div>

            <MembershipActivityFeed
              joinedLabel="каналу"
              leftLabel="канал"
              variant="immersive"
              filter={activityFeed.filter}
              onFilterChange={handleActivityFilterChange}
              items={activityFeed.items}
              hasMore={activityFeed.hasMore}
              isReloading={activityFeed.isReloading}
              isLoadingMore={activityFeed.isLoadingMore}
              error={activityFeed.error}
              onLoadMore={() => void activityFeed.loadMore()}
              onRetry={() => void activityFeed.retry()}
              onProfileActivate={activateChannelProfile}
            />
          </section>
        ) : stats ? (
          <ChannelStatsOverview
            stats={stats}
            range={range}
            chartTab={chartTab}
            onRangeChange={setRange}
            onChartTabChange={setChartTab}
          />
        ) : null}
      </div>
    </div>
  );
}
