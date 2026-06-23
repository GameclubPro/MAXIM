import type { MembershipActivityItem } from '@maxim/contracts';
import type {
  ChannelStatsBucket,
  ChannelStatsRange,
  ChannelStatsResponse,
  ChannelStatsSummary,
} from '@maxim/contracts/channel-stats';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity as IconActivity,
  ArrowUpCircle as IconArrowUpCircle,
  GraphUp as IconGraphUp,
  Group as IconGroup,
  StatsUpSquare as IconStatsUpSquare,
  UserPlus as IconUserPlus,
  UserXmark as IconUserXmark,
} from 'iconoir-react';
import '../styles/channel-stats.css';
import '../styles/channel-stats-route-polish.css';
import '../styles/channel-stats-executive.css';
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
  isChannelStatsResponseForRange,
  resolveAudienceChartDisplayValue,
  resolveInitialAudienceChartIndex,
  shouldRenderChannelStatsPointMarkers,
} from '../lib/channel-stats-chart';
import { useAutoHideHeader } from '../lib/use-auto-hide-header';
import { useMembershipActivityFeed } from '../lib/use-membership-activity-feed';

type ChannelStatsRouteState = {
  chatTitle: string;
  avatarUrl: string | null;
};

type ChannelStatsSection = 'overview' | 'events';

type AudienceChartPoint = {
  at: string;
  participantsCount: number | null;
  displayValue: number;
  deltaFromPrevious: number | null;
  deltaPercentFromPrevious: number | null;
  joined: number;
  left: number;
  net: number;
  cumulativeNet: number;
  x: number;
  y: number;
  joinedFlowY: number;
  leftFlowY: number;
};

type PreviousAudienceChartPoint = {
  at: string;
  participantsCount: number | null;
  displayValue: number;
  joined: number;
  left: number;
  net: number;
  cumulativeNet: number;
  x: number;
  y: number;
};

const periodOptions: Array<{ value: ChannelStatsRange; label: string }> = [
  { value: '24h', label: '24ч' },
  { value: '7d', label: '7д' },
  { value: '30d', label: '30д' },
];

const sectionOptions: Array<{ value: ChannelStatsSection; label: string }> = [
  { value: 'overview', label: 'Обзор' },
  { value: 'events', label: 'События' },
];

const dayShortLabels = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'] as const;
const CHART_VIEWBOX_WIDTH = 390;
const CHART_VIEWBOX_HEIGHT = 210;
const AUDIENCE_CHART_LEFT_PAD = 26;
const AUDIENCE_CHART_RIGHT_PAD = 6;

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

  if (Math.abs(value) < 100_000) {
    return formatCount(value);
  }

  return new Intl.NumberFormat('ru-RU', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value);
}

function formatDenseCount(value: number): string {
  const absolute = Math.abs(value);

  if (absolute < 100_000) {
    return new Intl.NumberFormat('ru-RU', { useGrouping: false }).format(value);
  }

  return new Intl.NumberFormat('ru-RU', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value);
}

function formatSummaryTableDate(value: string): string {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})/u.exec(value);
  if (dateOnly) {
    return `${dateOnly[3]}.${dateOnly[2]}`;
  }

  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    return '—';
  }

  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
  }).format(parsed);
}

function formatChartDayMonth(value: string | null): string {
  if (!value) {
    return '—';
  }

  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})/u.exec(value);
  if (dateOnly) {
    return `${dateOnly[3]}.${dateOnly[2]}`;
  }

  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    return '—';
  }

  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
  }).format(parsed);
}

function formatMoscowDateKey(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    return '';
  }

  return new Date(parsed.getTime() + 3 * 60 * 60 * 1_000).toISOString().slice(0, 10);
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

  const formatted = new Intl.NumberFormat('ru-RU').format(Math.abs(value));
  if (value > 0) {
    return `+${formatted}`;
  }

  if (value < 0) {
    return `-${formatted}`;
  }

  return '0';
}

function formatDenseSignedCount(value: number | null): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '—';
  }

  if (value > 0) {
    return `+${formatDenseCount(value)}`;
  }

  if (value < 0) {
    return `-${formatDenseCount(Math.abs(value))}`;
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

function formatSignedPercent(value: number | null, maximumFractionDigits = 2): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '—';
  }

  const formatted = new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: 0,
    maximumFractionDigits,
  })
    .format(Math.abs(value))
    .replace(',', '.');

  if (value > 0) {
    return `+${formatted}%`;
  }

  if (value < 0) {
    return `-${formatted}%`;
  }

  return '0%';
}

function formatSignedDecimalCount(value: number | null, maximumFractionDigits = 2): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '—';
  }

  const formatted = new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: Number.isInteger(value) ? 0 : Math.min(2, maximumFractionDigits),
    maximumFractionDigits,
  })
    .format(Math.abs(value))
    .replace(',', '.');

  if (value > 0) {
    return `+${formatted}`;
  }

  if (value < 0) {
    return `-${formatted}`;
  }

  return formatted;
}

function readNullableCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function resolveChannelStatsSummary(stats: ChannelStatsResponse): ChannelStatsSummary {
  const maybeSummary = (stats as Partial<ChannelStatsResponse>).summary;
  if (maybeSummary) {
    const subscribers = maybeSummary.subscribers;
    return {
      ...maybeSummary,
      subscribers: {
        ...subscribers,
        todayJoined: subscribers.todayJoined ?? null,
        todayLeft: subscribers.todayLeft ?? null,
      },
      daily: maybeSummary.daily.map((row) => {
        return {
          ...row,
          joined: readNullableCount(row.joined),
          left: readNullableCount(row.left),
        };
      }),
    };
  }

  const currentSubscribers = stats.channel.participantsCount;
  const joined = stats.official.audience.joined ?? 0;
  const left = stats.official.audience.left ?? 0;
  const weekDelta = stats.official.audience.net ?? joined - left;
  const displayViews = stats.official.content.views;
  const perPost =
    stats.official.content.posts > 0
      ? Math.round(displayViews / stats.official.content.posts)
      : null;
  const resolveTopPostsAverageSince = (hours: number) => {
    const toMs = new Date(stats.period.to).getTime();
    if (!Number.isFinite(toMs)) {
      return null;
    }

    const fromMs = toMs - hours * 60 * 60 * 1000;
    const posts = stats.official.content.topPosts.filter((post) => {
      const publishedAtMs = new Date(post.publishedAt).getTime();
      return Number.isFinite(publishedAtMs) && publishedAtMs >= fromMs && publishedAtMs <= toMs;
    });
    if (posts.length === 0) {
      return null;
    }

    const views = posts.reduce((total, post) => total + Math.max(0, post.viewsDelta), 0);
    return Math.round(views / posts.length);
  };
  const last24hAverage = resolveTopPostsAverageSince(24) ?? perPost;
  const last48hAverage = resolveTopPostsAverageSince(48) ?? last24hAverage;
  const er24 =
    displayViews > 0
      ? Math.round((stats.official.content.reactions / displayViews) * 10_000) / 100
      : null;
  const dailyByDate = new Map<string, number | null>();
  stats.official.series.participants
    .slice()
    .sort((leftPoint, rightPoint) => leftPoint.at.localeCompare(rightPoint.at))
    .forEach((point) => {
      const date = formatMoscowDateKey(point.at);
      if (date) {
        dailyByDate.set(date, point.participantsCount);
      }
    });
  const todayDate = formatMoscowDateKey(stats.period.to);
  if (todayDate && typeof currentSubscribers === 'number') {
    dailyByDate.set(todayDate, currentSubscribers);
  }
  const dailySource = Array.from(dailyByDate.entries())
    .sort(([leftDate], [rightDate]) => leftDate.localeCompare(rightDate))
    .slice(-16);
  const membershipByDate = new Map<string, { joined: number; left: number }>();
  stats.official.series.membership.forEach((point) => {
    const date = formatMoscowDateKey(point.at);
    if (!date) {
      return;
    }

    const current = membershipByDate.get(date) ?? { joined: 0, left: 0 };
    current.joined += point.joined;
    current.left += point.left ?? 0;
    membershipByDate.set(date, current);
  });
  const daily = dailySource.map(([date, subscribers], index, rows) => {
    const previous = index > 0 ? rows[index - 1]?.[1] : null;
    const flow = membershipByDate.get(date) ?? null;

    return {
      date,
      subscribers,
      delta:
        subscribers === null || previous === null || previous === undefined
          ? null
          : subscribers - previous,
      joined: flow?.joined ?? null,
      left: flow?.left ?? null,
    };
  });

  return {
    subscribers: {
      current: currentSubscribers,
      todayDelta: daily.at(-1)?.delta ?? null,
      todayJoined: null,
      todayLeft: null,
      weekDelta,
      sixteenDaysDelta: weekDelta,
    },
    views: {
      perPost,
      last24h: last24hAverage,
      last48h: last48hAverage,
      er24,
    },
    daily,
  };
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

function getSignedTone(value: number | null): 'positive' | 'negative' | 'neutral' {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 'neutral';
  }

  if (value > 0) {
    return 'positive';
  }

  if (value < 0) {
    return 'negative';
  }

  return 'neutral';
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
  const plotRight =
    rect.left + (rect.width * (CHART_VIEWBOX_WIDTH - rightPad)) / CHART_VIEWBOX_WIDTH;
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
  previousPoints: PreviousAudienceChartPoint[];
  linePath: string;
  areaPath: string;
  joinedFlowPath: string;
  joinedFlowLinePath: string;
  leftFlowPath: string;
  leftFlowLinePath: string;
  previousLinePath: string;
  hasLine: boolean;
  hasPreviousLine: boolean;
  hasJoinedFlow: boolean;
  hasLeftFlow: boolean;
  guideYs: number[];
  dividerY: number;
  activityRailY: number;
  eventRailY: number;
  zeroY: number;
  height: number;
  leftPad: number;
  rightPad: number;
  plotTop: number;
  plotBottom: number;
  floorY: number;
  axisLabels: Array<{ y: number; label: string }>;
} {
  const participantSeries = stats.official.series.participants;
  const membershipSeries = stats.official.series.membership;
  const previousParticipantSeries = stats.comparison.series?.participants ?? [];
  const previousMembershipSeries = stats.comparison.series?.membership ?? [];
  const currentParticipants = readNullableCount(stats.channel.participantsCount);
  const pointCount = Math.max(
    participantSeries.length,
    membershipSeries.length,
    currentParticipants !== null ? 1 : 0,
  );
  if (pointCount === 0) {
    return {
      points: [],
      previousPoints: [],
      linePath: '',
      areaPath: '',
      joinedFlowPath: '',
      joinedFlowLinePath: '',
      leftFlowPath: '',
      leftFlowLinePath: '',
      previousLinePath: '',
      hasLine: false,
      hasPreviousLine: false,
      hasJoinedFlow: false,
      hasLeftFlow: false,
      guideYs: [],
      dividerY: 112,
      activityRailY: 132,
      eventRailY: 158,
      zeroY: 132,
      height: CHART_VIEWBOX_HEIGHT,
      leftPad: AUDIENCE_CHART_LEFT_PAD,
      rightPad: AUDIENCE_CHART_RIGHT_PAD,
      plotTop: 30,
      plotBottom: 164,
      floorY: 176,
      axisLabels: [],
    };
  }

  const width = CHART_VIEWBOX_WIDTH;
  const height = CHART_VIEWBOX_HEIGHT;
  const leftPad = AUDIENCE_CHART_LEFT_PAD;
  const rightPad = AUDIENCE_CHART_RIGHT_PAD;
  const lineTop = 28;
  const lineBottom = 158;
  const lineFloor = 174;
  const dividerY = lineBottom;
  const activityRailY = 174;
  const eventRailY = 190;
  const plotWidth = width - leftPad - rightPad;

  let cumulativeNet = 0;
  const basePoints = Array.from({ length: pointCount }, (_, index) => {
    const participant = participantSeries[index] ?? participantSeries.at(-1) ?? null;
    const membership = membershipSeries[index] ?? null;
    const at = membership?.at ?? participant?.at ?? new Date().toISOString();
    const joined = membership?.joined ?? 0;
    const left = membership?.left ?? 0;
    const net = joined - left;
    cumulativeNet += net;
    const x =
      pointCount === 1 ? width / 2 : leftPad + (plotWidth * index) / Math.max(1, pointCount - 1);

    return {
      at,
      participantsCount: participant?.participantsCount ?? null,
      joined,
      left,
      net,
      cumulativeNet,
      x,
      y: lineBottom,
      joinedFlowY: activityRailY,
      leftFlowY: activityRailY,
    };
  });
  const totalNet = basePoints.at(-1)?.cumulativeNet ?? 0;
  const preferMembershipFlow =
    stats.meta.churnAvailable &&
    currentParticipants !== null &&
    membershipSeries.some((point) => point.joined > 0 || (point.left ?? 0) > 0);
  const rawPoints = basePoints.map((point, index, points) => {
    const displayValue = resolveAudienceChartDisplayValue(
      point,
      currentParticipants,
      totalNet,
      preferMembershipFlow,
    );
    const previousDisplayValue =
      index > 0
        ? resolveAudienceChartDisplayValue(
            points[index - 1]!,
            currentParticipants,
            totalNet,
            preferMembershipFlow,
          )
        : null;
    const deltaFromPrevious =
      previousDisplayValue === null ? null : Math.round(displayValue - previousDisplayValue);
    const deltaPercentFromPrevious =
      previousDisplayValue !== null && previousDisplayValue > 0 && deltaFromPrevious !== null
        ? (deltaFromPrevious / previousDisplayValue) * 100
        : null;

    return {
      ...point,
      displayValue,
      deltaFromPrevious,
      deltaPercentFromPrevious,
    };
  });

  const previousPointCount = Math.max(
    previousParticipantSeries.length,
    previousMembershipSeries.length,
  );
  let previousCumulativeNet = 0;
  const previousBasePoints = Array.from({ length: previousPointCount }, (_, index) => {
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
  const previousCurrentParticipants = previousParticipantSeries.at(-1)?.participantsCount ?? null;
  const rawPreviousPoints = previousBasePoints.map((point) => ({
    ...point,
    displayValue:
      point.participantsCount ??
      previousCurrentParticipants ??
      point.cumulativeNet,
  }));
  const hasPreviousDisplayValues = rawPreviousPoints.some(
    (point) => point.participantsCount !== null || previousCurrentParticipants !== null,
  );
  const displayValues = [
    ...rawPoints.map((point) => point.displayValue),
    ...(hasPreviousDisplayValues ? rawPreviousPoints.map((point) => point.displayValue) : []),
  ];
  const rawMinValue = Math.min(...displayValues);
  const rawMaxValue = Math.max(...displayValues);
  const valueSpan = Math.max(1, rawMaxValue - rawMinValue);
  const valuePadding = Math.max(1, valueSpan * 0.18);
  const minValue = Math.max(0, rawMinValue - valuePadding);
  const maxValue = rawMaxValue + valuePadding;
  const valueRange = Math.max(1, maxValue - minValue);
  const resolveValueY = (value: number) =>
    lineTop + ((maxValue - value) / valueRange) * (lineBottom - lineTop);
  const points = rawPoints.map((point) => ({
    ...point,
    y: resolveValueY(point.displayValue),
  }));
  const previousPoints = rawPreviousPoints.map((point) => ({
    ...point,
    y: resolveValueY(point.displayValue),
  }));

  const linePath = buildAudiencePath(points.map((point) => ({ x: point.x, y: point.y })));
  const previousLinePath = buildAudiencePath(
    previousPoints.map((point) => ({ x: point.x, y: point.y })),
  );
  const joinedFlowLinePath = '';
  const leftFlowLinePath = '';
  const zeroY = lineBottom;
  const guideYs = [
    lineTop,
    Math.round(lineTop + (lineBottom - lineTop) * 0.25),
    Math.round(lineTop + (lineBottom - lineTop) * 0.5),
    Math.round(lineTop + (lineBottom - lineTop) * 0.75),
    lineBottom,
  ];
  const axisLabels = guideYs.map((y) => {
    const ratio = (y - lineTop) / Math.max(1, lineBottom - lineTop);
    const value = maxValue - ratio * valueRange;
    return {
      y: y + 4,
      label: formatDenseCount(Math.round(value)),
    };
  }).filter((label, index, labels) => {
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
    joinedFlowPath: '',
    joinedFlowLinePath,
    leftFlowPath: '',
    leftFlowLinePath,
    previousLinePath,
    hasLine: points.length > 0,
    hasPreviousLine: hasPreviousDisplayValues && previousPoints.length > 0,
    hasJoinedFlow: false,
    hasLeftFlow: false,
    guideYs,
    dividerY,
    activityRailY,
    eventRailY,
    zeroY,
    height,
    leftPad,
    rightPad,
    plotTop: lineTop,
    plotBottom: lineBottom,
    floorY: lineFloor,
    axisLabels,
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
    stats.meta.churnAvailable,
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
  const activeComparablePreviousPoint = chart.hasPreviousLine ? activePreviousPoint : null;
  const renderPointMarkers = shouldRenderChannelStatsPointMarkers(
    stats.period.range,
    chart.points.length,
  );
  const graphClassName = `channel-stats-graph channel-stats-graph--audience-reference ${
    renderPointMarkers ? '' : 'channel-stats-graph--continuous'
  }`.trim();

  const firstPoint = chart.points[0] ?? null;
  const lastPoint = chart.points.at(-1) ?? null;
  const totalGrowth =
    firstPoint && lastPoint ? Math.round(lastPoint.displayValue - firstPoint.displayValue) : null;
  const averageGrowth =
    totalGrowth !== null ? totalGrowth / Math.max(1, chart.points.length - 1) : null;
  const detailLabelIndices =
    !renderPointMarkers
      ? new Set<number>()
      : labels.length <= 11
      ? new Set(labels.map((_, index) => index))
      : resolveSparseLabelIndices(labels.length, safeActiveIndex);
  const xAxisLabelIndices =
    labels.length <= 12
      ? new Set(labels.map((_, index) => index))
      : resolveSparseLabelIndices(labels.length, safeActiveIndex);
  const activeParticipantsLabel = formatCount(activePoint?.displayValue ?? null);
  const activeDelta = activePoint?.deltaFromPrevious ?? activePoint?.net ?? null;
  const activeDeltaLabel = formatSignedCount(activeDelta);
  const activePercentLabel = formatSignedPercent(activePoint?.deltaPercentFromPrevious ?? null, 1);
  const activeBucketLabel = stats.period.bucket === 'hour' ? 'За час' : 'За день';
  const activeGuideLabel = activePoint
    ? `${formatChartDetailDate(
        activePoint.at,
        stats.period.bucket,
      )}: ${formatCount(
        activePoint.displayValue,
      )} подписчиков, ${activeBucketLabel.toLocaleLowerCase(
        'ru-RU',
      )} ${activeDeltaLabel}, ${formatCount(activePoint.joined)} пришли, ${formatCount(
        activePoint.left,
      )} ушли`
    : 'Данные по аудитории недоступны';
  const tooltipX = activePoint ? clamp((activePoint.x / CHART_VIEWBOX_WIDTH) * 100, 15, 85) : 50;
  const tooltipStyle = { '--tooltip-x': `${tooltipX}%` } as CSSProperties;
  const axisLabelX = Math.max(16, chart.leftPad - 5);
  const periodLabel =
    firstPoint && lastPoint
      ? `${formatChartDayMonth(firstPoint.at)} — ${formatChartDayMonth(lastPoint.at)}`
      : '—';

  return (
    <div className={graphClassName}>
      {chart.points.length === 0 ? (
        <div className="channel-stats-graph__empty">Пока нет данных за период.</div>
      ) : (
        <>
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
            <div className="channel-audience-board__heading">
              <span aria-hidden="true" />
              <strong>Подписчики</strong>
            </div>

            <div className="channel-audience-board__metrics">
              <span className="channel-audience-metric">
                <IconGroup aria-hidden focusable="false" width={24} height={24} strokeWidth={2} />
                <b>{formatCount(firstPoint?.displayValue ?? null)}</b>
                <small>{firstPoint ? formatChartDayMonth(firstPoint.at) : '—'}</small>
                <em>Начало периода</em>
              </span>
              <span className="channel-audience-metric">
                <IconArrowUpCircle
                  aria-hidden
                  focusable="false"
                  width={25}
                  height={25}
                  strokeWidth={2}
                />
                <b>{formatCount(lastPoint?.displayValue ?? null)}</b>
                <small>{lastPoint ? formatChartDayMonth(lastPoint.at) : '—'}</small>
                <em>Конец периода</em>
              </span>
            </div>

            <div className="channel-audience-board__plot">
              {activePoint && isTooltipVisible ? (
                <div className="channel-stats-graph__tooltip" style={tooltipStyle}>
                  <small>{formatChartDetailDate(activePoint.at, stats.period.bucket)}</small>
                  <strong>{activeParticipantsLabel} подписчиков</strong>
                  <span>
                    {activeBucketLabel} {activeDeltaLabel} · {activePercentLabel}
                  </span>
                  {activeComparablePreviousPoint ? (
                    <em>Предыдущий: {formatCount(activeComparablePreviousPoint.displayValue)}</em>
                  ) : null}
                </div>
              ) : null}

              <svg
                viewBox={`0 0 ${CHART_VIEWBOX_WIDTH} ${chart.height}`}
                className="channel-stats-graph__svg"
                aria-hidden
              >
                <defs>
                  <linearGradient
                    id="channel-audience-line"
                    x1={chart.leftPad}
                    x2={CHART_VIEWBOX_WIDTH - chart.rightPad}
                    y1={chart.plotTop}
                    y2={chart.plotBottom}
                  >
                    <stop offset="0" stopColor="#24b767" />
                    <stop offset="0.48" stopColor="#139b48" />
                    <stop offset="1" stopColor="#0c8d3f" />
                  </linearGradient>
                  <linearGradient
                    id="channel-audience-area"
                    x1="0"
                    x2="0"
                    y1={chart.plotTop}
                    y2={chart.floorY}
                  >
                    <stop offset="0" stopColor="#16a34a" stopOpacity="0.28" />
                    <stop offset="0.58" stopColor="#16a34a" stopOpacity="0.12" />
                    <stop offset="1" stopColor="#16a34a" stopOpacity="0" />
                  </linearGradient>
                </defs>
                {chart.axisLabels.map((label) => (
                  <text
                    key={`${label.label}-${label.y}`}
                    x={axisLabelX}
                    y={label.y}
                    className="channel-stats-graph__axis-text"
                    textAnchor="end"
                  >
                    {label.label}
                  </text>
                ))}
                {xAxisLabelIndices.size > 1
                  ? chart.points.map((point, index) =>
                      xAxisLabelIndices.has(index) ? (
                        <line
                          key={`audience-v-guide-${point.at}-${index}`}
                          x1={point.x}
                          y1={chart.plotTop}
                          x2={point.x}
                          y2={chart.plotBottom}
                          className="channel-stats-graph__grid channel-stats-graph__grid--vertical"
                        />
                      ) : null,
                    )
                  : null}
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
                  y1={chart.plotBottom}
                  x2={CHART_VIEWBOX_WIDTH - chart.rightPad}
                  y2={chart.plotBottom}
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
                {activePoint && isTooltipVisible ? (
                  <line
                    x1={activePoint.x}
                    y1={chart.plotTop}
                    x2={activePoint.x}
                    y2={chart.plotBottom}
                    className="channel-stats-graph__active-guide"
                  />
                ) : null}
                {chart.hasPreviousLine ? (
                  <path
                    d={chart.previousLinePath}
                    className="channel-stats-graph__line channel-stats-graph__line--previous"
                  />
                ) : null}
                {chart.hasLine ? (
                  <path
                    d={chart.linePath}
                    className="channel-stats-graph__line channel-stats-graph__line--audience"
                  />
                ) : null}
                {chart.points.map((point, index) => {
                  const showDetails = detailLabelIndices.has(index);
                  const showDate = xAxisLabelIndices.has(index);
                  const labelY = Math.max(12, point.y - 13);
                  const deltaY = Math.min(chart.floorY - 13, point.y + 21);
                  const detailLabelX = clamp(
                    point.x,
                    chart.leftPad + 10,
                    CHART_VIEWBOX_WIDTH - chart.rightPad - 10,
                  );
                  const dateTextAnchor =
                    index === 0 ? 'start' : index === chart.points.length - 1 ? 'end' : 'middle';
                  const deltaTone = getSignedTone(point.deltaFromPrevious);

                  return (
                    <g
                      key={labels[index]?.at ?? index}
                      className={`channel-stats-graph__point-group ${
                        safeActiveIndex === index ? 'is-active' : ''
                      } ${showDetails ? 'has-detail' : ''}`}
                    >
                      {showDetails ? (
                        <>
                          <text
                            x={detailLabelX}
                            y={labelY}
                            textAnchor="middle"
                            className="channel-stats-graph__point-value"
                          >
                            {formatCompactCount(Math.round(point.displayValue))}
                          </text>
                          {point.deltaFromPrevious !== null ? (
                            <>
                              <text
                                x={detailLabelX}
                                y={deltaY}
                                textAnchor="middle"
                                className={`channel-stats-graph__point-delta is-${deltaTone}`}
                              >
                                {formatSignedCount(point.deltaFromPrevious)}
                              </text>
                              <text
                                x={detailLabelX}
                                y={deltaY + 11}
                                textAnchor="middle"
                                className={`channel-stats-graph__point-percent is-${deltaTone}`}
                              >
                                {formatSignedPercent(point.deltaPercentFromPrevious, 1)}
                              </text>
                            </>
                          ) : null}
                        </>
                      ) : null}
                      {renderPointMarkers ? (
                        <circle
                          cx={point.x}
                          cy={point.y}
                          r={safeActiveIndex === index ? 4.2 : 3.4}
                          className={`channel-stats-graph__dot ${
                            safeActiveIndex === index ? 'is-active' : ''
                          }`}
                        />
                      ) : null}
                      {showDate ? (
                        <text
                          x={point.x}
                          y="202"
                          textAnchor={dateTextAnchor}
                          className="channel-stats-graph__x-label"
                        >
                          {formatChartDayMonth(point.at)}
                        </text>
                      ) : null}
                    </g>
                  );
                })}
              </svg>
            </div>

            <div className="channel-audience-board__legend">
              <span className={`is-${getSignedTone(totalGrowth)}`}>
                <IconGraphUp aria-hidden focusable="false" width={18} height={18} strokeWidth={2} />
                <b>{formatSignedCount(totalGrowth)}</b>
                <em>Прирост</em>
              </span>
              <span className={`is-${getSignedTone(averageGrowth)}`}>
                <IconStatsUpSquare
                  aria-hidden
                  focusable="false"
                  width={18}
                  height={18}
                  strokeWidth={2}
                />
                <b>{formatSignedDecimalCount(averageGrowth)}</b>
                <em>В день</em>
              </span>
            </div>
          </div>

          <output className="channel-stats-graph__sr" aria-live="polite">
            {activeComparablePreviousPoint
              ? `${activeGuideLabel}. Прошлый период: ${formatCount(
                  activeComparablePreviousPoint.displayValue,
                )}. Период ${periodLabel}.`
              : `${activeGuideLabel}. Период ${periodLabel}.`}
          </output>
        </>
      )}
    </div>
  );
}

function TopPostsChart({ stats }: { stats: ChannelStatsResponse }) {
  const posts = stats.official.content.topPosts;
  const resolvePostViews = (
    post: ChannelStatsResponse['official']['content']['topPosts'][number],
  ) => post.viewsDelta;

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
          const valueLabel = formatCompactCount(value);
          const detailParts = [`${formatCount(value)} просмотров за период`];
          const hasPreview = Boolean(post.previewUrl);

          const row = (
            <>
              <div
                className={`channel-posts-chart__preview ${
                  hasPreview ? 'channel-posts-chart__preview--image' : ''
                }`}
                aria-hidden="true"
              >
                {post.previewUrl ? (
                  <img src={post.previewUrl} alt="" loading="lazy" decoding="async" />
                ) : (
                  <span>#{index + 1}</span>
                )}
              </div>
              <div className="channel-posts-chart__content">
                <div className="channel-posts-chart__row-head">
                  <span className="channel-posts-chart__rank">#{index + 1}</span>
                  <span className="channel-posts-chart__title">
                    {formatPostDateTime(post.publishedAt)}
                  </span>
                </div>
                <div className="channel-posts-chart__metrics" aria-hidden="true">
                  <span>
                    <small>Просмотры</small>
                    <strong>{valueLabel}</strong>
                  </span>
                </div>
              </div>
            </>
          );
          const rowLabel = `Публикация ${index + 1}, ${formatPostDateTime(
            post.publishedAt,
          )}: ${detailParts.join(', ')}`;

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
  onRangeChange,
}: {
  stats: ChannelStatsResponse;
  range: ChannelStatsRange;
  onRangeChange: (range: ChannelStatsRange) => void;
}) {
  const summary = resolveChannelStatsSummary(stats);
  const summaryDailyRows = summary.daily.slice(-9).reverse();

  return (
    <section
      className="channel-insights__summary channel-insights__summary--command stagger-in"
      aria-label="Сводка по каналу"
    >
      <div className="channel-insights__overview-top">
        <div className="channel-insights__primary-stack">
          <div className="channel-insights__summary-metrics">
            <article className="channel-summary-card channel-summary-card--subscribers">
              <header>
                <small>Подписчиков</small>
                <strong>{formatCount(summary.subscribers.current)}</strong>
              </header>
              <div className="channel-summary-card__rows">
                <span>
                  <small>Сегодня</small>
                  <b className={`is-${getSignedTone(summary.subscribers.todayDelta)}`}>
                    {formatSignedCount(summary.subscribers.todayDelta)}
                  </b>
                </span>
                <span>
                  <small>За неделю</small>
                  <b className={`is-${getSignedTone(summary.subscribers.weekDelta)}`}>
                    {formatSignedCount(summary.subscribers.weekDelta)}
                  </b>
                </span>
                <span>
                  <small>За 16 дней</small>
                  <b className={`is-${getSignedTone(summary.subscribers.sixteenDaysDelta)}`}>
                    {formatSignedCount(summary.subscribers.sixteenDaysDelta)}
                  </b>
                </span>
              </div>
            </article>

            <article className="channel-summary-card channel-summary-card--views">
              <header>
                <small>Просмотров на пост</small>
                <strong>{formatCount(summary.views.perPost)}</strong>
              </header>
              <div className="channel-summary-card__rows">
                <span>
                  <small>За 24ч</small>
                  <b>{formatCompactCount(summary.views.last24h)}</b>
                </span>
                <span>
                  <small>За 48ч</small>
                  <b>{formatCompactCount(summary.views.last48h)}</b>
                </span>
                <span>
                  <small>ER24</small>
                  <b>{formatPercent(summary.views.er24)}</b>
                </span>
              </div>
            </article>
          </div>

          <article
            className="channel-insights__chart-card channel-insights__chart-card--executive channel-insights__chart-card--audience"
          >
            <header className="channel-insights__chart-header">
              <strong className="channel-insights__chart-title">Подписчики</strong>

              <div className="channel-insights__chart-controls">
                <SegmentedControl
                  value={range}
                  options={periodOptions}
                  onChange={(next) => onRangeChange(next as ChannelStatsRange)}
                  className="channel-insights__range"
                  ariaLabel="Период графика"
                />
              </div>
            </header>

            <AudienceChart stats={stats} />
          </article>
        </div>

        {summaryDailyRows.length > 0 ? (
          <article className="channel-summary-table-card" aria-label="Динамика подписчиков">
            <table className="channel-summary-table">
              <thead>
                <tr>
                  <th>День</th>
                  <th>Подписчиков</th>
                  <th>Прирост</th>
                  <th>Движение</th>
                </tr>
              </thead>
              <tbody>
                {summaryDailyRows.map((row) => {
                  const joined = row.joined ?? null;
                  const left = row.left ?? null;
                  const hasFlow = joined !== null || left !== null;
                  const joinedFlow = joined ?? 0;
                  const leftFlow = left ?? 0;

                  return (
                    <tr key={row.date}>
                      <td className="channel-summary-table__date">
                        <time dateTime={row.date}>{formatSummaryTableDate(row.date)}</time>
                      </td>
                      <td className="channel-summary-table__total">
                        <span className="channel-summary-table__total-value">
                          {formatCount(row.subscribers)}
                        </span>
                      </td>
                      <td
                        className={`channel-summary-table__growth is-${getSignedTone(row.delta)}`}
                      >
                        <span className="channel-summary-table__growth-value">
                          {formatDenseSignedCount(row.delta)}
                        </span>
                      </td>
                      <td className="channel-summary-table__movement">
                        {hasFlow ? (
                          <span className="channel-summary-table__movement-pair">
                            <span
                              className={`channel-summary-table__movement-pill ${
                                joined === null ? 'is-neutral' : 'is-positive'
                              }`}
                            >
                              <span aria-hidden="true">↗</span>
                              <em>{formatDenseCount(joinedFlow)}</em>
                            </span>
                            <span
                              className={`channel-summary-table__movement-pill ${
                                left === null ? 'is-neutral' : 'is-negative'
                              }`}
                            >
                              <span aria-hidden="true">↘</span>
                              <em>{formatDenseCount(leftFlow)}</em>
                            </span>
                          </span>
                        ) : (
                          <span className="channel-summary-table__movement-empty">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </article>
        ) : null}
      </div>

      <div className="channel-insights__detail-grid">
        <article className="channel-fact-panel channel-top-posts-panel">
          <div className="channel-insights__panel-head">
            <div className="channel-insights__panel-copy">
              <strong>Топ публикаций</strong>
            </div>
          </div>
          <TopPostsChart stats={stats} />
        </article>

        <ChannelBestWindowsPanel stats={stats} />
      </div>
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
      if (cancelled || !isChannelStatsResponseForRange(snapshot, chatId, range)) {
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
    if (!isChannelStatsResponseForRange(statsQuery.data, chatId, range)) {
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
  const stats = isChannelStatsResponseForRange(statsQuery.data, chatId, range)
    ? statsQuery.data
    : null;

  useEffect(() => {
    if (!chatId || !resolvedTitle) {
      return;
    }

    saveChatTitle(chatId, resolvedTitle);
  }, [chatId, resolvedTitle]);

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

  if (section === 'overview' && !stats && (statsQuery.isLoading || statsQuery.isFetching)) {
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
            onRangeChange={setRange}
          />
        ) : null}
      </div>
    </div>
  );
}
