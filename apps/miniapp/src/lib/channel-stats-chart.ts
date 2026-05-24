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
