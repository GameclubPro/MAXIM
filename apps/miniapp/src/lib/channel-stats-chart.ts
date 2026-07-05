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
  currentParticipants: number | null,
  totalNet: number,
  preferMembershipFlow: boolean,
): number | null {
  const flowValue =
    currentParticipants !== null ? currentParticipants - (totalNet - point.cumulativeNet) : null;

  if (preferMembershipFlow && flowValue !== null) {
    return flowValue;
  }

  return point.participantsCount ?? currentParticipants;
}

export function shouldPreferMembershipFlowForAudienceChart(
  points: readonly AudienceChartActivePoint[],
  currentParticipants: number | null,
  churnAvailable: boolean,
): boolean {
  if (!churnAvailable || currentParticipants === null) {
    return false;
  }

  const firstFlowIndex = points.findIndex((point) => point.joined > 0 || point.left > 0);
  if (firstFlowIndex < 0) {
    return false;
  }

  return points
    .slice(0, firstFlowIndex + 1)
    .some(
      (point) =>
        typeof point.participantsCount === 'number' && Number.isFinite(point.participantsCount),
    );
}

export function resolveAverageViewsFromSeries(
  points: readonly ViewsSeriesPoint[],
): number | null {
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
