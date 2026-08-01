export type AudienceChartActivePoint = {
  participantsCount: number | null;
  joined: number;
  left: number;
  cumulativeNet: number;
};

export type ViewsSeriesPoint = {
  posts: number;
  views: number;
};

export type ChannelReachCoverage = 'unavailable' | 'insufficient' | 'ready';

export type ChannelReachSummary = {
  averageViews24h: number | null;
  averageViews48h: number | null;
  err48Percent: number | null;
  subscriberDenominator: number | null;
  sampleSize24h: number;
  sampleSize48h: number;
  coverage24h: ChannelReachCoverage;
  coverage48h: ChannelReachCoverage;
};

export type ChannelReachMetric = 'averageViews24h' | 'averageViews48h' | 'err48Percent';

export type ChannelReachMetricPresentation = {
  value: number | null;
  coverage: ChannelReachCoverage;
  sampleSize: number;
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
      views?: readonly ViewsSeriesPoint[];
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
  meta?: {
    viewsAvailable?: boolean;
  };
};

export function resolveChannelStatsAverageViews(stats: ViewsDisplayStats): number | null {
  if (stats.meta?.viewsAvailable === false) {
    return null;
  }

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

export function resolveChannelReachMetric(
  reach: ChannelReachSummary | null | undefined,
  metric: ChannelReachMetric,
): ChannelReachMetricPresentation {
  const is24HourMetric = metric === 'averageViews24h';
  const coverage = is24HourMetric ? reach?.coverage24h : reach?.coverage48h;
  const sampleSizeValue = is24HourMetric ? reach?.sampleSize24h : reach?.sampleSize48h;
  const sampleSize =
    typeof sampleSizeValue === 'number' && Number.isFinite(sampleSizeValue)
      ? Math.max(0, Math.trunc(sampleSizeValue))
      : 0;
  const normalizedCoverage: ChannelReachCoverage =
    coverage === 'ready' || coverage === 'insufficient' ? coverage : 'unavailable';

  if (normalizedCoverage !== 'ready') {
    return {
      value: null,
      coverage: normalizedCoverage,
      sampleSize,
    };
  }

  const rawValue = reach?.[metric];
  const hasValidValue = typeof rawValue === 'number' && Number.isFinite(rawValue) && rawValue >= 0;
  const hasValidErrDenominator =
    metric !== 'err48Percent' ||
    (typeof reach?.subscriberDenominator === 'number' &&
      Number.isFinite(reach.subscriberDenominator) &&
      reach.subscriberDenominator > 0);

  if (!hasValidValue || !hasValidErrDenominator) {
    return {
      value: null,
      coverage: 'unavailable',
      sampleSize,
    };
  }

  return {
    value: rawValue,
    coverage: 'ready',
    sampleSize,
  };
}

export function resolveChannelStatsSliderIndex(
  currentIndex: number,
  pointCount: number,
  key: string,
): number | null {
  if (pointCount <= 0) {
    return null;
  }

  const lastIndex = pointCount - 1;
  if (key === 'Home') {
    return 0;
  }
  if (key === 'End') {
    return lastIndex;
  }
  if (key === 'ArrowLeft' || key === 'ArrowDown') {
    return Math.max(0, Math.min(lastIndex, currentIndex - 1));
  }
  if (key === 'ArrowRight' || key === 'ArrowUp') {
    return Math.max(0, Math.min(lastIndex, currentIndex + 1));
  }

  return null;
}

export function resolveAudienceChartAverageGrowthLabel(bucket: string): 'В час' | 'В день' {
  return bucket === 'hour' ? 'В час' : 'В день';
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
  _currentParticipants: number | null,
  _totalNet: number,
  _preferMembershipFlow: boolean,
): number | null {
  return point.participantsCount;
}

export function shouldPreferMembershipFlowForAudienceChart(
  _points: readonly AudienceChartActivePoint[],
  _currentParticipants: number | null,
  _churnAvailable: boolean,
): boolean {
  return false;
}

export function resolveAverageViewsFromSeries(points: readonly ViewsSeriesPoint[]): number | null {
  const totals = points.reduce(
    (result, point) => {
      const posts =
        typeof point.posts === 'number' && Number.isFinite(point.posts)
          ? Math.max(0, Math.round(point.posts))
          : 0;
      const views =
        typeof point.views === 'number' && Number.isFinite(point.views)
          ? Math.max(0, Math.round(point.views))
          : 0;
      if (posts <= 0) {
        return result;
      }

      return {
        posts: result.posts + posts,
        views: result.views + views * posts,
      };
    },
    { posts: 0, views: 0 },
  );
  if (totals.posts === 0) {
    return null;
  }

  return Math.round(totals.views / totals.posts);
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
