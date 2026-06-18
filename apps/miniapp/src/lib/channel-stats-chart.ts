import type { ChannelStatsViewMode } from '@maxim/contracts/channel-stats';

export type AudienceChartActivePoint = {
  participantsCount: number | null;
  joined: number;
  left: number;
  cumulativeNet: number;
};

export type ViewsChartActivePoint = {
  views: number;
  cumulativeViews: number;
};

export type ViewsDisplayStats = {
  official: {
    content: {
      posts: number;
      views: number;
      viewsTotal: number;
      viewsMode: ChannelStatsViewMode;
    };
    series?: {
      views?: readonly ViewsChartActivePoint[];
    };
  };
  comparison?: {
    deltas?: {
      averageViewsPerPost?: {
        current: number;
      };
    };
  };
};

export function resolveChannelStatsDisplayViews(stats: ViewsDisplayStats): number {
  return stats.official.content.views;
}

export function resolveChannelStatsAverageViews(stats: ViewsDisplayStats): number {
  const seriesAverage = resolveAverageViewsFromSeries(stats.official.series?.views ?? []);
  if (seriesAverage !== null) {
    return seriesAverage;
  }

  const posts = Math.max(0, Math.round(stats.official.content.posts));
  if (posts === 0) {
    return 0;
  }

  return Math.round(resolveChannelStatsDisplayViews(stats) / posts);
}

export function resolveAverageViewsFromSeries(
  points: readonly ViewsChartActivePoint[],
): number | null {
  const values = points
    .map((point) => point.views)
    .filter((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0);
  if (values.length === 0) {
    return null;
  }

  const total = values.reduce((sum, value) => sum + value, 0);
  return Math.round(total / values.length);
}

export function shouldUseChannelStatsPeriodViews(stats: ViewsDisplayStats): boolean {
  void stats;
  return true;
}

export function resolveChannelStatsViewsModeLabel(stats: ViewsDisplayStats): string {
  void stats;
  return 'за период';
}

export function resolveInitialAudienceChartIndex(
  points: readonly AudienceChartActivePoint[],
): number {
  if (points.length === 0) {
    return 0;
  }

  const activeGrowthIndex = findLastIndex(
    points,
    (point) => point.cumulativeNet !== 0 || point.joined > 0 || point.left > 0,
  );
  if (activeGrowthIndex >= 0) {
    return activeGrowthIndex;
  }

  const knownAudienceIndex = findLastIndex(
    points,
    (point) =>
      typeof point.participantsCount === 'number' && Number.isFinite(point.participantsCount),
  );
  return knownAudienceIndex >= 0 ? knownAudienceIndex : points.length - 1;
}

export function resolveInitialViewsChartIndex(points: readonly ViewsChartActivePoint[]): number {
  if (points.length === 0) {
    return 0;
  }

  const activeViewsIndex = findLastIndex(points, (point) => point.views > 0);
  if (activeViewsIndex >= 0) {
    return activeViewsIndex;
  }

  const cumulativeViewsIndex = findLastIndex(points, (point) => point.cumulativeViews > 0);
  return cumulativeViewsIndex >= 0 ? cumulativeViewsIndex : points.length - 1;
}

function findLastIndex<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index]!)) {
      return index;
    }
  }

  return -1;
}
