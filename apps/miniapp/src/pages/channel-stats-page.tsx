import type { ChannelStatsBucket, ChannelStatsRange, ChannelStatsResponse } from '@maxim/contracts';
import { useQuery } from '@tanstack/react-query';
import '../styles/lazy-pages.css';
import '../styles/dashboard-events.css';
import type { CSSProperties } from 'react';
import { Fragment, useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { CompactStickyHeader } from '../components/ui/compact-sticky-header';
import { EntityAvatar } from '../components/ui/entity-avatar';
import { GlassCard } from '../components/ui/glass-card';
import { SegmentedControl } from '../components/ui/segmented-control';
import { SkeletonCard } from '../components/ui/skeleton';
import { StatusState } from '../components/ui/status-state';
import { getChannelStats } from '../lib/api/channel-stats-client';
import type { ApiTransport } from '../lib/api/transport';
import { readChatTitle, saveChatTitle } from '../lib/chat-titles';
import { buildManagedEntitiesRoute, saveLastEntityId } from '../lib/last-chat';
import { queryKeys } from '../lib/query-keys';
import { useAutoHideHeader } from '../lib/use-auto-hide-header';

type ChannelStatsRouteState = {
  chatTitle: string;
  avatarUrl: string | null;
};

type ChartTab = 'audience' | 'views' | 'posts';

type ChartInsightTone = 'accent' | 'success' | 'danger' | 'warning' | 'neutral';
type ChannelStatsSignal = ChannelStatsResponse['signals']['insights'][number];

type ChannelDecisionCard = {
  code: string;
  label: string;
  value: string;
  meta: string | null;
  tone: ChartInsightTone;
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

const audienceTabOptions: Array<{ value: ChartTab; label: string }> = [
  { value: 'audience', label: 'Аудитория' },
  { value: 'views', label: 'Просмотры' },
  { value: 'posts', label: 'Посты' },
];

const dayShortLabels = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'] as const;
const heatmapHourLabels = [0, 6, 12, 18] as const;

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

function formatCompactCount(value: number | null): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '—';
  }

  return new Intl.NumberFormat('ru-RU', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value);
}

function formatSignedCompactCount(value: number | null): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '—';
  }

  if (value === 0) {
    return '0';
  }

  const formatted = formatCompactCount(Math.abs(value));
  return `${value > 0 ? '+' : '-'}${formatted}`;
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

function formatPostTime(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    return '';
  }

  return new Intl.DateTimeFormat('ru-RU', {
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

function formatBenchmarkDelta(
  metric: ChannelStatsResponse['intelligence']['benchmarks']['viewsPerPost'],
): string | null {
  if (typeof metric.deltaPercent !== 'number' || !Number.isFinite(metric.deltaPercent)) {
    return null;
  }

  const rounded = Math.round(metric.deltaPercent);
  if (rounded === 0) {
    return '0%';
  }

  return `${rounded > 0 ? '+' : ''}${rounded}%`;
}

function formatDecimal(value: number | null): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '—';
  }

  return new Intl.NumberFormat('ru-RU', {
    maximumFractionDigits: value > 0 && value < 10 ? 1 : 0,
  }).format(value);
}

function resolveNumberTone(value: number | null | undefined, inverse = false): ChartInsightTone {
  if (typeof value !== 'number' || !Number.isFinite(value) || value === 0) {
    return 'neutral';
  }

  const positive = inverse ? value < 0 : value > 0;
  return positive ? 'success' : 'warning';
}

function formatBestWindowValue(window: ChannelStatsResponse['signals']['bestWindows'][number]) {
  const day = dayShortLabels[window.dayOfWeek] ?? '';
  const hour = String(window.hour).padStart(2, '0');
  return `${day} ${hour}:00`.trim();
}

function formatBestWindowMeta(window: ChannelStatsResponse['signals']['bestWindows'][number]) {
  const views = formatCompactCount(window.averageViews);
  const reactions = formatCompactCount(window.averageReactions);
  return reactions === '—' || window.averageReactions === 0 ? views : `${views} · ${reactions}`;
}

function pushDecisionCard(cards: ChannelDecisionCard[], card: ChannelDecisionCard): void {
  if (
    cards.some(
      (item) =>
        item.code === card.code ||
        (item.label.toLocaleLowerCase('ru-RU') === card.label.toLocaleLowerCase('ru-RU') &&
          item.value.toLocaleLowerCase('ru-RU') === card.value.toLocaleLowerCase('ru-RU')),
    )
  ) {
    return;
  }

  cards.push(card);
}

function pushSignalDecision(cards: ChannelDecisionCard[], signal: ChannelStatsSignal): void {
  pushDecisionCard(cards, {
    code: signal.code,
    label: signal.label,
    value: signal.value,
    meta: null,
    tone: signal.tone,
  });
}

function buildDecisionCards(stats: ChannelStatsResponse): ChannelDecisionCard[] {
  const cards: ChannelDecisionCard[] = [];

  for (const signal of stats.signals.alerts.slice(0, 1)) {
    pushSignalDecision(cards, signal);
  }

  const bestWindow = stats.signals.bestWindows[0];
  if (bestWindow && bestWindow.posts > 0) {
    pushDecisionCard(cards, {
      code: 'best-window',
      label: 'Публиковать',
      value: formatBestWindowValue(bestWindow),
      meta: formatBestWindowMeta(bestWindow),
      tone: 'success',
    });
  }

  const forecast = stats.intelligence.forecast;
  if (forecast.net !== null) {
    pushDecisionCard(cards, {
      code: 'forecast',
      label: `${forecast.horizonDays}д`,
      value: formatSignedCompactCount(forecast.net),
      meta:
        forecast.participants !== null
          ? `${formatCompactCount(forecast.participants)} всего`
          : null,
      tone: resolveNumberTone(forecast.net),
    });
  }

  const cohort = stats.intelligence.cohort;
  if (cohort.joined >= 3 && cohort.retentionRate !== null) {
    pushDecisionCard(cards, {
      code: 'retention',
      label: 'Новые',
      value: formatPercent(cohort.retentionRate),
      meta: `${formatCompactCount(cohort.retained)} удержано`,
      tone: resolveNumberTone(cohort.retentionRate - 65),
    });
  }

  const viewsPerPost = stats.intelligence.benchmarks.viewsPerPost;
  if (stats.meta.viewsAvailable && stats.official.content.posts > 0) {
    pushDecisionCard(cards, {
      code: 'views-per-post',
      label: 'Просм./пост',
      value: formatCompactCount(Math.round(viewsPerPost.current)),
      meta: formatBenchmarkDelta(viewsPerPost),
      tone: resolveNumberTone(viewsPerPost.deltaPercent),
    });
  }

  const engagementRate = stats.intelligence.benchmarks.engagementRate;
  if (stats.meta.viewsAvailable && stats.official.content.views > 0) {
    pushDecisionCard(cards, {
      code: 'engagement-rate',
      label: 'ER',
      value: formatPercent(engagementRate.current),
      meta: formatBenchmarkDelta(engagementRate),
      tone: resolveNumberTone(engagementRate.deltaPercent),
    });
  }

  for (const signal of [
    ...stats.intelligence.headline.secondary,
    ...stats.intelligence.patterns,
    ...stats.signals.insights,
  ]) {
    if (cards.length >= 3) {
      break;
    }
    pushSignalDecision(cards, signal);
  }

  return cards.slice(0, 3);
}

function ChannelDecisionStrip({ stats }: { stats: ChannelStatsResponse }) {
  const cards = buildDecisionCards(stats);

  if (cards.length === 0) {
    return null;
  }

  return (
    <div
      className={`channel-command-strip channel-insights__decision-strip ${
        stats.signals.alerts.length > 0 ? 'channel-insights__decision-strip--alerts' : ''
      }`}
      aria-label="Ключевые сигналы"
    >
      {cards.map((card) => (
        <article
          key={card.code}
          className={`channel-command-strip__item channel-command-strip__item--${card.tone}`}
        >
          <small>{card.label}</small>
          <strong>{card.value}</strong>
          {card.meta ? <em>{card.meta}</em> : null}
        </article>
      ))}
    </div>
  );
}

function collectUsefulSignals(stats: ChannelStatsResponse): ChannelStatsSignal[] {
  const result: ChannelStatsSignal[] = [];
  for (const signal of [
    ...stats.signals.alerts,
    ...stats.intelligence.patterns,
    ...stats.signals.insights,
    ...stats.intelligence.headline.secondary,
  ]) {
    if (result.some((item) => item.code === signal.code)) {
      continue;
    }
    result.push(signal);
    if (result.length >= 4) {
      break;
    }
  }
  return result;
}

function ChannelSignalStrip({ stats }: { stats: ChannelStatsResponse }) {
  const signals = collectUsefulSignals(stats);

  if (signals.length === 0) {
    return null;
  }

  return (
    <div
      className={`channel-insights__signal-strip ${
        stats.signals.alerts.length > 0 ? 'channel-insights__signal-strip--alerts' : ''
      }`}
      aria-label="Сигналы"
    >
      {signals.map((signal) => (
        <span
          key={signal.code}
          className={`channel-insights__signal channel-insights__signal--${signal.tone}`}
        >
          <small>{signal.label}</small>
          <strong>{signal.value}</strong>
        </span>
      ))}
    </div>
  );
}

function ChannelBenchmarkRail({ stats }: { stats: ChannelStatsResponse }) {
  const benchmarks: Array<{
    code: string;
    label: string;
    value: string;
    delta: string | null;
    tone: ChartInsightTone;
  }> = [];
  const { viewsPerPost, reactionsPerPost, engagementRate } = stats.intelligence.benchmarks;

  if (stats.meta.viewsAvailable && stats.official.content.posts > 0) {
    benchmarks.push({
      code: 'views-per-post',
      label: 'Просм./пост',
      value: formatCompactCount(Math.round(viewsPerPost.current)),
      delta: formatBenchmarkDelta(viewsPerPost),
      tone: resolveNumberTone(viewsPerPost.deltaPercent),
    });
  }

  if (stats.official.content.posts > 0) {
    benchmarks.push({
      code: 'reactions-per-post',
      label: 'Реакц./пост',
      value: formatDecimal(reactionsPerPost.current),
      delta: formatBenchmarkDelta(reactionsPerPost),
      tone: resolveNumberTone(reactionsPerPost.deltaPercent),
    });
  }

  if (stats.meta.viewsAvailable && stats.official.content.views > 0) {
    benchmarks.push({
      code: 'engagement-rate',
      label: 'ER',
      value: formatPercent(engagementRate.current),
      delta: formatBenchmarkDelta(engagementRate),
      tone: resolveNumberTone(engagementRate.deltaPercent),
    });
  }

  if (benchmarks.length === 0) {
    return null;
  }

  return (
    <div className="channel-benchmark-rail channel-insights__benchmark-rail">
      {benchmarks.map((benchmark) => (
        <article
          key={benchmark.code}
          className={`channel-benchmark-rail__item is-${benchmark.tone}`}
        >
          <small>{benchmark.label}</small>
          <strong>{benchmark.value}</strong>
          {benchmark.delta ? <em>{benchmark.delta}</em> : null}
        </article>
      ))}
    </div>
  );
}

function ChannelForecastCohort({ stats }: { stats: ChannelStatsResponse }) {
  const forecast = stats.intelligence.forecast;
  const cohort = stats.intelligence.cohort;
  const hasForecast = forecast.net !== null || forecast.participants !== null;
  const hasCohort = cohort.sampleSize > 0 || cohort.joined > 0;

  if (!hasForecast && !hasCohort) {
    return null;
  }

  const cohortSteps = [
    {
      code: 'joined',
      label: 'Пришли',
      value: formatCount(cohort.joined),
      width: cohort.joined > 0 ? 100 : 0,
      tone: 'accent',
    },
    {
      code: 'retained',
      label: 'Остались',
      value: formatPercent(cohort.retentionRate),
      width: clamp(cohort.retentionRate ?? 0, 0, 100),
      tone: resolveNumberTone((cohort.retentionRate ?? 0) - 65),
    },
    {
      code: 'participated',
      label: 'Вовлеклись',
      value: formatPercent(cohort.participationRate),
      width: clamp(cohort.participationRate ?? 0, 0, 100),
      tone: resolveNumberTone((cohort.participationRate ?? 0) - 20),
    },
  ] as const;

  return (
    <div
      className={`channel-intel-grid channel-insights__intel-grid ${
        hasForecast && hasCohort ? '' : 'channel-insights__intel-grid--single'
      }`}
    >
      {hasForecast ? (
        <article className={`channel-forecast-card is-${resolveNumberTone(forecast.net ?? 0)}`}>
          <small>{forecast.horizonDays}д</small>
          <strong>
            {forecast.net !== null
              ? formatSignedCompactCount(forecast.net)
              : formatCompactCount(forecast.participants)}
          </strong>
          <span>
            {forecast.participants !== null
              ? `${formatCompactCount(forecast.participants)} всего`
              : forecast.confidence}
          </span>
        </article>
      ) : null}

      {hasCohort ? (
        <article className="channel-cohort-card channel-cohort-card--wide">
          <div className="channel-cohort-card__head">
            <small>Новые</small>
            <strong>{formatCompactCount(cohort.sampleSize || cohort.joined)}</strong>
          </div>
          <div className="channel-cohort-card__steps">
            {cohortSteps.map((step) => (
              <div key={step.code} className={`channel-cohort-step is-${step.tone}`}>
                <small>{step.label}</small>
                <strong>{step.value}</strong>
                <span className="channel-cohort-step__bar" aria-hidden="true">
                  <i style={{ width: `${Math.max(4, step.width)}%` }} />
                </span>
              </div>
            ))}
          </div>
        </article>
      ) : null}
    </div>
  );
}

function ChannelPublishingHeatmap({ stats }: { stats: ChannelStatsResponse }) {
  const cells = stats.intelligence.publishingHeatmap;

  if (cells.length === 0) {
    return null;
  }

  const maxScore = Math.max(...cells.map((cell) => cell.score), 1);
  const cellsByKey = new Map(cells.map((cell) => [`${cell.dayOfWeek}:${cell.hour}`, cell]));
  const bestWindow = stats.signals.bestWindows.find((window) => window.posts > 0) ?? null;

  return (
    <div className="channel-heatmap channel-insights__heatmap">
      <div className="channel-heatmap__head">
        <small>Окна</small>
        {bestWindow ? <strong>{formatBestWindowValue(bestWindow)}</strong> : null}
      </div>
      <div className="channel-heatmap__grid" aria-label="Окна публикаций">
        <span className="channel-heatmap__corner" aria-hidden="true" />
        {Array.from({ length: 24 }, (_, hour) => (
          <span key={`hour-${hour}`} className="channel-heatmap__hour">
            {heatmapHourLabels.includes(hour as (typeof heatmapHourLabels)[number]) ? hour : ''}
          </span>
        ))}
        {dayShortLabels.map((day, dayOfWeek) => (
          <Fragment key={day}>
            <span key={`${day}-label`} className="channel-heatmap__day">
              {day}
            </span>
            {Array.from({ length: 24 }, (_, hour) => {
              const cell = cellsByKey.get(`${dayOfWeek}:${hour}`) ?? null;
              const heat = cell ? clamp(cell.score / maxScore, 0.12, 1) : 0;
              const title = cell
                ? `${day} ${String(hour).padStart(2, '0')}:00 · ${formatCompactCount(
                    cell.averageViews,
                  )}`
                : `${day} ${String(hour).padStart(2, '0')}:00`;

              return (
                <span
                  key={`${day}-${hour}`}
                  className={`channel-heatmap__cell ${
                    cell && cell.posts > 0 ? `has-posts is-${cell.tone}` : ''
                  }`}
                  style={{ '--heat': heat } as CSSProperties}
                  title={title}
                />
              );
            })}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

function ChannelUsefulStats({ stats }: { stats: ChannelStatsResponse }) {
  return (
    <div className="channel-insights__useful-grid">
      <ChannelSignalStrip stats={stats} />
      <ChannelBenchmarkRail stats={stats} />
      <ChannelForecastCohort stats={stats} />
      <ChannelPublishingHeatmap stats={stats} />
    </div>
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
  const maxMembershipActivity = Math.max(
    ...chart.points.map((point) => point.joined + point.left),
    0,
  );
  const graphMarkers = resolveGraphMarkerPositions(
    stats.signals.markers,
    chart.points.map((point) => ({ at: point.at, x: point.x })),
    (marker) => marker.type !== 'post',
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
              {graphMarkers.map((marker) => (
                <g key={`${marker.code}-${marker.at}`} aria-hidden="true">
                  <path
                    d={`M ${marker.x.toFixed(2)} 101 l 5 5 l -5 5 l -5 -5 Z`}
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
  const graphMarkers = resolveGraphMarkerPositions(
    stats.signals.markers,
    chart.bars.map((bar) => ({ at: bar.at, x: bar.x })),
    (marker) => marker.type === 'post' || marker.type === 'peak',
  );
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
            </div>
          </div>

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
              {graphMarkers.map((marker) => (
                <g key={`${marker.code}-${marker.at}`} aria-hidden="true">
                  <path
                    d={`M ${marker.x.toFixed(2)} 170 l 4.8 -8.4 l 4.8 8.4 Z`}
                    className={`channel-stats-graph__marker channel-stats-graph__marker--${marker.tone}`}
                  >
                    <title>{`${marker.label} ${marker.value}`}</title>
                  </path>
                </g>
              ))}
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
      <div className="channel-posts-chart__list">
        {posts.map((post, index) => {
          const value = post.viewsDelta || post.views;
          const width = maxViews > 0 ? Math.max(8, Math.round((value / maxViews) * 100)) : 8;
          const row = (
            <>
              <div className="channel-posts-chart__row-head">
                <span className="channel-posts-chart__rank">#{index + 1}</span>
                <span className="channel-posts-chart__title">
                  {formatPostTime(post.publishedAt)}
                </span>
                <strong>{formatCompactCount(value)}</strong>
              </div>
              <div className="channel-posts-chart__bar" aria-hidden="true">
                <span style={{ width: `${width}%` }} />
              </div>
              <div className="channel-posts-chart__row-meta">
                <small>{formatCount(post.reactions)} реакций</small>
                {post.viewsDelta > 0 && post.viewsDelta !== post.views ? (
                  <small>{formatCompactCount(post.views)} всего</small>
                ) : null}
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
  const audienceJoined = stats.official.audience.joined ?? 0;
  const audienceLeft = stats.official.audience.left ?? 0;
  const audienceNet = stats.official.audience.net ?? audienceJoined - audienceLeft;
  const netTone = audienceNet > 0 ? 'success' : audienceNet < 0 ? 'danger' : 'neutral';
  const engagementRate =
    stats.meta.viewsAvailable && stats.official.content.views > 0
      ? (stats.official.content.reactions / stats.official.content.views) * 100
      : null;
  const viewsPerPost =
    stats.meta.viewsAvailable && stats.official.content.posts > 0
      ? Math.round(stats.intelligence.benchmarks.viewsPerPost.current)
      : null;
  const primarySignal = stats.intelligence.headline.primary;
  const chartTitle =
    effectiveChartTab === 'audience'
      ? 'Аудитория'
      : effectiveChartTab === 'views'
        ? 'Просмотры'
        : 'Посты';

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
              <div className="channel-insights__status-row channel-insights__status-row--headline">
                <span
                  className={`channel-insights__headline-badge channel-insights__headline-badge--${primarySignal.tone}`}
                >
                  <small>{primarySignal.label}</small>
                  <strong>{primarySignal.value}</strong>
                </span>
                <span
                  className={`channel-insights__score channel-insights__score--${stats.health.tone}`}
                  aria-label={`Оценка канала ${stats.health.score} из 100`}
                >
                  {stats.health.score}
                </span>
              </div>
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
              <small>Подписчики</small>
              <strong>{formatCompactCount(stats.channel.participantsCount)}</strong>
              <span>{formatCount(stats.channel.participantsCount)}</span>
            </article>

            <article
              className={`channel-insights__kpi-card channel-insights__kpi-card--${netTone}`}
            >
              <small>Прирост</small>
              <strong>{formatSignedCount(audienceNet)}</strong>
              <span>
                <DeltaBadge metric={stats.comparison.deltas.audienceNet} />
                <b>
                  +{formatCount(audienceJoined)} / -{formatCount(audienceLeft)}
                </b>
              </span>
            </article>

            <article className="channel-insights__kpi-card channel-insights__kpi-card--views">
              <small>{stats.meta.viewsAvailable ? 'Просм./пост' : 'Посты'}</small>
              <strong>
                {stats.meta.viewsAvailable
                  ? formatCompactCount(viewsPerPost)
                  : formatCount(stats.official.content.posts)}
              </strong>
              <span>
                {stats.meta.viewsAvailable ? (
                  <>
                    <DeltaBadge metric={stats.comparison.deltas.averageViewsPerPost} />
                    <b>{formatCompactCount(stats.official.content.views)} всего</b>
                  </>
                ) : (
                  <DeltaBadge metric={stats.comparison.deltas.posts} />
                )}
              </span>
            </article>

            <article className="channel-insights__kpi-card channel-insights__kpi-card--reactions">
              <small>{stats.meta.viewsAvailable ? 'ER' : 'Реакции'}</small>
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

          <ChannelDecisionStrip stats={stats} />

          <article className="channel-insights__chart-card">
            <div className="channel-insights__panel-head">
              <div className="channel-insights__panel-copy">
                <strong>{chartTitle}</strong>
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

          <ChannelUsefulStats stats={stats} />
        </section>
      </div>
    </div>
  );
}
