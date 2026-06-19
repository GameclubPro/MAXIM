export type AudienceChartActivePoint = {
  participantsCount: number | null;
  joined: number;
  left: number;
  cumulativeNet: number;
};

export type ViewsChartActivePoint = {
  views: number;
};

export type ViewsDisplayStats = {
  channel?: {
    id?: string;
  };
  period?: {
    range?: string;
  };
  official: {
    content: {
      posts: number;
      views: number;
    };
    series?: {
      views?: readonly ViewsChartActivePoint[];
    };
  };
  summary?: {
    views?: {
      perPost?: number | null;
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

export function resolveChannelStatsAverageViews(stats: ViewsDisplayStats): number {
  const periodAverage = stats.comparison?.deltas?.averageViewsPerPost?.current;
  if (typeof periodAverage === 'number' && Number.isFinite(periodAverage) && periodAverage >= 0) {
    return Math.round(periodAverage);
  }

  const posts = Math.max(0, Math.round(stats.official.content.posts));
  if (posts > 0) {
    return Math.round(stats.official.content.views / posts);
  }

  const seriesAverage = resolveAverageViewsFromSeries(stats.official.series?.views ?? []);
  if (seriesAverage !== null) {
    return seriesAverage;
  }

  const perPost = stats.summary?.views?.perPost;
  if (typeof perPost === 'number' && Number.isFinite(perPost) && perPost >= 0) {
    return Math.round(perPost);
  }

  return 0;
}

export function isChannelStatsResponseForRange<T extends ViewsDisplayStats>(
  stats: T | null | undefined,
  chatId: string,
  range: string,
): stats is T {
  return Boolean(stats && stats.channel?.id === chatId && stats.period?.range === range);
}

export function resolveAudienceChartDisplayValue(
  point: AudienceChartActivePoint,
  currentParticipants: number | null,
  totalNet: number,
  preferMembershipFlow: boolean,
): number {
  const flowValue =
    currentParticipants !== null ? currentParticipants - (totalNet - point.cumulativeNet) : null;

  if (preferMembershipFlow && flowValue !== null) {
    return flowValue;
  }

  return point.participantsCount ?? flowValue ?? point.cumulativeNet;
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
  return activeViewsIndex >= 0 ? activeViewsIndex : points.length - 1;
}

export function shouldRenderChannelStatsPointMarkers(range: string, pointCount: number): boolean {
  if (pointCount <= 0 || range === '24h') {
    return false;
  }

  return pointCount <= 16;
}

function findLastIndex<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index]!)) {
      return index;
    }
  }

  return -1;
}
