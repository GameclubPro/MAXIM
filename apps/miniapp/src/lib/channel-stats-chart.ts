export type AudienceChartActivePoint = {
  participantsCount: number | null;
  joined: number;
  left: number;
  cumulativeNet: number;
};

export type ViewsChartActivePoint = {
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

  return point.participantsCount ?? currentParticipants ?? point.cumulativeNet;
}

export function resolveAverageViewsFromSeries(
  points: readonly ViewsChartActivePoint[],
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

export function resolveInitialViewsChartIndex(points: readonly ViewsChartActivePoint[]): number {
  if (points.length === 0) {
    return 0;
  }

  const activeViewsIndex = findLastIndex(points, hasViewsChartPosts);
  return activeViewsIndex >= 0 ? activeViewsIndex : 0;
}

export function resolveNearestViewsChartIndex(
  points: readonly ViewsChartActivePoint[],
  targetIndex: number,
): number {
  if (points.length === 0) {
    return 0;
  }

  const safeIndex = Math.min(points.length - 1, Math.max(0, Math.round(targetIndex)));
  if (hasViewsChartPosts(points[safeIndex]!)) {
    return safeIndex;
  }

  let nearestIndex = -1;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < points.length; index += 1) {
    if (!hasViewsChartPosts(points[index]!)) {
      continue;
    }

    const distance = Math.abs(index - safeIndex);
    if (distance < nearestDistance) {
      nearestIndex = index;
      nearestDistance = distance;
    }
  }

  return nearestIndex >= 0 ? nearestIndex : safeIndex;
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

function hasViewsChartPosts(point: ViewsChartActivePoint): boolean {
  return typeof point.posts === 'number' && Number.isFinite(point.posts) && point.posts > 0;
}
