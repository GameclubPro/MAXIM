import type { ChannelStatsRange, ChannelStatsResponse } from '@maxim/contracts';

type ChannelStatsIntelligence = NonNullable<ChannelStatsResponse['intelligence']>;
type ChannelStatsMetricDelta = ChannelStatsResponse['comparison']['deltas']['views'];
type ChannelStatsSignalTone = ChannelStatsResponse['signals']['insights'][number]['tone'];
type ChannelStatsSignal = ChannelStatsResponse['signals']['insights'][number];
type ChannelStatsBestWindow = ChannelStatsResponse['signals']['bestWindows'][number];
type ChannelStatsBenchmarkMetric = ChannelStatsIntelligence['benchmarks']['viewsPerPost'];
type ChannelStatsForecast = ChannelStatsIntelligence['forecast'];
type ChannelStatsCohort = ChannelStatsIntelligence['cohort'];
type ChannelStatsHeatmapCell = ChannelStatsIntelligence['publishingHeatmap'][number];

export type ChannelStatsIntelligenceTotals = {
  joined: number;
  left: number;
  net: number;
  posts: number;
  views: number;
  viewsTotal: number;
  averageViewsPerPost: number;
  reactions: number;
};

export type ChannelStatsIntelligenceMembershipRow = {
  event_type: string | null;
  user_id?: string | null;
};

export type ChannelStatsIntelligencePostMetric = {
  post: {
    publishedAt: Date;
    latestReactionsTotal: number;
  };
  viewsDelta: number;
  viewsCurrent: number;
};

export function buildChannelStatsIntelligence(params: {
  totals: ChannelStatsIntelligenceTotals;
  previousTotals: ChannelStatsIntelligenceTotals;
  comparison: ChannelStatsResponse['comparison'];
  signals: ChannelStatsResponse['signals'];
  membershipRows: ChannelStatsIntelligenceMembershipRow[];
  participantSeries: ChannelStatsResponse['official']['series']['participants'];
  postViewMetrics: ChannelStatsIntelligencePostMetric[];
  secondary: {
    commentAuthors: number;
    suggestionAuthors: number;
    comments: number;
    suggestions: number;
    postsWithButtons: number;
  };
  maxSnapshotAvailable: boolean;
  range: ChannelStatsRange;
}): ChannelStatsIntelligence {
  const benchmarks = buildChannelStatsBenchmarks(params.totals, params.previousTotals);
  const forecast = buildChannelStatsForecast(params.participantSeries);
  const cohort = buildChannelStatsCohort({
    totals: params.totals,
    membershipRows: params.membershipRows,
    secondary: params.secondary,
  });
  const publishingHeatmap = buildChannelStatsPublishingHeatmap(params.postViewMetrics);
  const patterns = buildChannelStatsPatterns({
    totals: params.totals,
    benchmarks,
    forecast,
    cohort,
    postViewMetrics: params.postViewMetrics,
    secondary: params.secondary,
    bestWindows: params.signals.bestWindows,
    range: params.range,
  });
  const headline = buildChannelStatsHeadline({
    totals: params.totals,
    comparison: params.comparison,
    signals: params.signals,
    forecast,
    patterns,
    maxSnapshotAvailable: params.maxSnapshotAvailable,
  });

  return {
    headline,
    benchmarks,
    forecast,
    cohort,
    publishingHeatmap,
    patterns,
  };
}

function buildChannelStatsBenchmarks(
  totals: ChannelStatsIntelligenceTotals,
  previousTotals: ChannelStatsIntelligenceTotals,
): ChannelStatsIntelligence['benchmarks'] {
  const currentViewsPerPost = totals.posts > 0 ? Math.round(totals.viewsTotal / totals.posts) : 0;
  const previousViewsPerPost =
    previousTotals.posts > 0
      ? Math.round(previousTotals.viewsTotal / previousTotals.posts)
      : previousTotals.averageViewsPerPost;
  const currentReactionsPerPost =
    totals.posts > 0 ? roundChannelStatsNumber(totals.reactions / totals.posts, 1) : 0;
  const previousReactionsPerPost =
    previousTotals.posts > 0
      ? roundChannelStatsNumber(previousTotals.reactions / previousTotals.posts, 1)
      : 0;
  const currentEngagementRate =
    totals.views > 0 ? roundChannelStatsNumber((totals.reactions / totals.views) * 100, 2) : 0;
  const previousEngagementRate =
    previousTotals.views > 0
      ? roundChannelStatsNumber((previousTotals.reactions / previousTotals.views) * 100, 2)
      : 0;

  return {
    viewsPerPost: buildChannelStatsBenchmarkMetric(currentViewsPerPost, previousViewsPerPost),
    reactionsPerPost: buildChannelStatsBenchmarkMetric(
      currentReactionsPerPost,
      previousReactionsPerPost,
    ),
    engagementRate: buildChannelStatsBenchmarkMetric(currentEngagementRate, previousEngagementRate),
  };
}

function buildChannelStatsBenchmarkMetric(
  current: number,
  baseline: number,
): ChannelStatsBenchmarkMetric {
  const normalizedCurrent = roundChannelStatsNumber(Math.max(0, current), 2);
  const normalizedBaseline = roundChannelStatsNumber(Math.max(0, baseline), 2);
  const deltaPercent =
    normalizedBaseline > 0
      ? roundChannelStatsNumber(
          ((normalizedCurrent - normalizedBaseline) / normalizedBaseline) * 100,
          1,
        )
      : null;

  return {
    current: normalizedCurrent,
    baseline: normalizedBaseline,
    deltaPercent,
  };
}

function buildChannelStatsForecast(
  participantSeries: ChannelStatsResponse['official']['series']['participants'],
): ChannelStatsForecast {
  const points = participantSeries
    .map((point) => ({
      atMs: new Date(point.at).getTime(),
      participantsCount: point.participantsCount,
    }))
    .filter(
      (point): point is { atMs: number; participantsCount: number } =>
        Number.isFinite(point.atMs) && typeof point.participantsCount === 'number',
    );

  if (points.length < 2) {
    return {
      horizonDays: 30,
      participants: null,
      net: null,
      confidence: 'low',
    };
  }

  const first = points[0]!;
  const last = points[points.length - 1]!;
  const coveredDays = Math.max(1, (last.atMs - first.atMs) / (24 * 60 * 60 * 1000));
  const net = last.participantsCount - first.participantsCount;
  const projectedNet = Math.round((net / coveredDays) * 30);
  const absoluteDeltas = points
    .slice(1)
    .map((point, index) => Math.abs(point.participantsCount - points[index]!.participantsCount));
  const averageDelta =
    absoluteDeltas.length > 0
      ? absoluteDeltas.reduce((sum, value) => sum + value, 0) / absoluteDeltas.length
      : 0;
  const volatility = Math.abs(net) > 0 ? averageDelta / Math.abs(net) : averageDelta;
  const confidence: ChannelStatsForecast['confidence'] =
    points.length >= 10 && volatility <= 0.5
      ? 'high'
      : points.length >= 4 && volatility <= 1.2
        ? 'medium'
        : 'low';

  return {
    horizonDays: 30,
    participants: Math.max(0, last.participantsCount + projectedNet),
    net: projectedNet,
    confidence,
  };
}

function buildChannelStatsCohort(params: {
  totals: ChannelStatsIntelligenceTotals;
  membershipRows: ChannelStatsIntelligenceMembershipRow[];
  secondary: {
    commentAuthors: number;
    suggestionAuthors: number;
  };
}): ChannelStatsCohort {
  const joinedUsers = new Set<string>();
  const latestEventByJoinedUser = new Map<string, string>();

  for (const row of params.membershipRows) {
    const userId = row.user_id?.trim();
    if (!userId) {
      continue;
    }

    if (row.event_type === 'user_added') {
      joinedUsers.add(userId);
      latestEventByJoinedUser.set(userId, 'user_added');
    } else if (row.event_type === 'user_removed' && joinedUsers.has(userId)) {
      latestEventByJoinedUser.set(userId, 'user_removed');
    }
  }

  const sampleSize = joinedUsers.size;
  const joined = sampleSize > 0 ? sampleSize : params.totals.joined;
  const retained =
    sampleSize > 0
      ? Array.from(joinedUsers).filter(
          (userId) => latestEventByJoinedUser.get(userId) !== 'user_removed',
        ).length
      : Math.max(0, params.totals.joined - params.totals.left);
  const participated = Math.min(
    joined,
    params.secondary.commentAuthors + params.secondary.suggestionAuthors,
  );

  return {
    joined,
    retained,
    participated,
    reactions: params.totals.reactions,
    retentionRate: joined > 0 ? roundChannelStatsNumber((retained / joined) * 100, 1) : null,
    participationRate:
      joined > 0 ? roundChannelStatsNumber((participated / joined) * 100, 1) : null,
    reactionsPerJoined:
      joined > 0 ? roundChannelStatsNumber(params.totals.reactions / joined, 1) : null,
    sampleSize,
  };
}

function buildChannelStatsPublishingHeatmap(
  postViewMetrics: ChannelStatsIntelligencePostMetric[],
): ChannelStatsHeatmapCell[] {
  const grouped = new Map<
    string,
    {
      dayOfWeek: number;
      hour: number;
      posts: number;
      views: number;
      reactions: number;
    }
  >();

  for (const metric of postViewMetrics) {
    const { dayOfWeek, hour } = resolveChannelStatsMoscowWindow(metric.post.publishedAt);
    const key = `${dayOfWeek}:${hour}`;
    const current = grouped.get(key) ?? {
      dayOfWeek,
      hour,
      posts: 0,
      views: 0,
      reactions: 0,
    };
    current.posts += 1;
    current.views += Math.max(0, metric.viewsDelta || metric.viewsCurrent);
    current.reactions += toSafeInteger(metric.post.latestReactionsTotal);
    grouped.set(key, current);
  }

  const cells = Array.from({ length: 7 * 24 }, (_, index) => {
    const dayOfWeek = Math.floor(index / 24);
    const hour = index % 24;
    const current = grouped.get(`${dayOfWeek}:${hour}`);
    const averageViews =
      current && current.posts > 0 ? Math.round(current.views / current.posts) : 0;
    const averageReactions =
      current && current.posts > 0 ? Math.round(current.reactions / current.posts) : 0;
    return {
      dayOfWeek,
      hour,
      posts: current?.posts ?? 0,
      averageViews,
      averageReactions,
      score: averageViews + averageReactions * 12 + (current?.posts ?? 0) * 4,
      tone: 'neutral' as ChannelStatsSignalTone,
    };
  });
  const maxScore = Math.max(...cells.map((cell) => cell.score), 0);

  return cells.map((cell) => {
    const ratio = maxScore > 0 ? cell.score / maxScore : 0;
    const tone: ChannelStatsSignalTone =
      ratio >= 0.72 ? 'success' : ratio >= 0.42 ? 'accent' : ratio >= 0.18 ? 'warning' : 'neutral';

    return {
      ...cell,
      tone,
    };
  });
}

function buildChannelStatsPatterns(params: {
  totals: ChannelStatsIntelligenceTotals;
  benchmarks: ChannelStatsIntelligence['benchmarks'];
  forecast: ChannelStatsForecast;
  cohort: ChannelStatsCohort;
  postViewMetrics: ChannelStatsIntelligencePostMetric[];
  secondary: {
    comments: number;
    suggestions: number;
    postsWithButtons: number;
  };
  bestWindows: ChannelStatsBestWindow[];
  range: ChannelStatsRange;
}): ChannelStatsSignal[] {
  const patterns: ChannelStatsSignal[] = [];
  const addPattern = (
    code: string,
    label: string,
    value: string,
    tone: ChannelStatsSignalTone,
    at: string | null = null,
  ) => {
    patterns.push({ code, label, value, tone, at });
  };

  const bestWindow = params.bestWindows[0] ?? null;
  if (bestWindow) {
    addPattern('best-window', 'Окно', formatChannelStatsWindowValue(bestWindow), 'success');
  }

  const viewsDelta = params.benchmarks.viewsPerPost.deltaPercent;
  if (typeof viewsDelta === 'number' && Math.abs(viewsDelta) >= 12) {
    addPattern(
      viewsDelta >= 0 ? 'views-norm-up' : 'views-norm-down',
      'Посты',
      formatChannelStatsPercentValue(viewsDelta),
      viewsDelta >= 0 ? 'success' : 'warning',
    );
  }

  const topMetric = params.postViewMetrics
    .slice()
    .sort(
      (left, right) =>
        right.viewsDelta - left.viewsDelta ||
        right.viewsCurrent - left.viewsCurrent ||
        right.post.latestReactionsTotal - left.post.latestReactionsTotal,
    )[0];
  if (topMetric && params.benchmarks.viewsPerPost.current > 0) {
    const topViews = topMetric.viewsDelta || topMetric.viewsCurrent;
    const topDelta = buildChannelStatsBenchmarkMetric(
      topViews,
      params.benchmarks.viewsPerPost.current,
    ).deltaPercent;
    if (typeof topDelta === 'number' && topDelta >= 25) {
      addPattern(
        'top-post-lift',
        'Хит',
        formatChannelStatsPercentValue(topDelta),
        'accent',
        topMetric.post.publishedAt.toISOString(),
      );
    }
  }

  const engagementDelta = params.benchmarks.engagementRate.deltaPercent;
  if (typeof engagementDelta === 'number' && Math.abs(engagementDelta) >= 15) {
    addPattern(
      engagementDelta >= 0 ? 'engagement-up' : 'engagement-down',
      'Реакции',
      formatChannelStatsPercentValue(engagementDelta),
      engagementDelta >= 0 ? 'success' : 'warning',
    );
  }

  const appActions = params.secondary.comments + params.secondary.suggestions;
  if (params.secondary.postsWithButtons > 0 && appActions > 0) {
    addPattern(
      'buttons-app-actions',
      'Кнопки',
      formatChannelStatsCompactCount(appActions),
      'accent',
    );
  }

  if (params.forecast.net !== null && params.forecast.net !== 0) {
    addPattern(
      'forecast',
      'Прогноз',
      formatChannelStatsSignedInteger(params.forecast.net),
      params.forecast.net > 0 ? 'success' : 'warning',
    );
  }

  if (params.cohort.retentionRate !== null && params.cohort.joined >= 3) {
    if (params.cohort.retentionRate >= 80) {
      addPattern(
        'cohort-retention',
        'Когорта',
        `${Math.round(params.cohort.retentionRate)}%`,
        'success',
      );
    } else if (params.cohort.retentionRate < 55) {
      addPattern(
        'cohort-retention-low',
        'Когорта',
        `${Math.round(params.cohort.retentionRate)}%`,
        'warning',
      );
    }
  }

  if (params.range !== '24h' && params.totals.posts === 0) {
    addPattern('content-pause', 'Пауза', '0 постов', 'warning');
  }

  return patterns.slice(0, 5);
}

function buildChannelStatsHeadline(params: {
  totals: ChannelStatsIntelligenceTotals;
  comparison: ChannelStatsResponse['comparison'];
  signals: ChannelStatsResponse['signals'];
  forecast: ChannelStatsForecast;
  patterns: ChannelStatsSignal[];
  maxSnapshotAvailable: boolean;
}): ChannelStatsIntelligence['headline'] {
  const primaryFromAlert = params.signals.alerts[0] ?? null;
  const primary: ChannelStatsSignal =
    primaryFromAlert ??
    (params.totals.net !== 0
      ? {
          code: params.totals.net > 0 ? 'headline-growth' : 'headline-loss',
          label: params.totals.net > 0 ? 'Рост' : 'Отток',
          value: formatChannelStatsSignedInteger(params.totals.net),
          tone: params.totals.net > 0 ? 'success' : 'danger',
          at: null,
        }
      : params.comparison.deltas.views.absolute !== 0
        ? {
            code: 'headline-views',
            label: 'Просмотры',
            value: formatChannelStatsDeltaValue(params.comparison.deltas.views),
            tone: resolveChannelStatsDeltaTone(params.comparison.deltas.views, false),
            at: null,
          }
        : {
            code: params.maxSnapshotAvailable ? 'headline-stable' : 'headline-snapshot',
            label: params.maxSnapshotAvailable ? 'Стабильно' : 'MAX',
            value: params.maxSnapshotAvailable ? '0' : 'нет снимка',
            tone: params.maxSnapshotAvailable ? 'neutral' : 'warning',
            at: null,
          });

  const secondary = params.patterns.filter((pattern) => pattern.code !== primary.code).slice(0, 2);

  if (secondary.length < 2 && params.forecast.net !== null && params.forecast.net !== 0) {
    secondary.push({
      code: 'headline-forecast',
      label: '+30д',
      value: formatChannelStatsSignedInteger(params.forecast.net),
      tone: params.forecast.net > 0 ? 'success' : 'warning',
      at: null,
    });
  }

  return {
    primary,
    secondary: secondary.slice(0, 2),
  };
}

function resolveChannelStatsMoscowWindow(date: Date): { dayOfWeek: number; hour: number } {
  const moscowDate = new Date(date.getTime() + 3 * 60 * 60 * 1000);
  return {
    dayOfWeek: moscowDate.getUTCDay(),
    hour: moscowDate.getUTCHours(),
  };
}

function resolveChannelStatsDeltaTone(
  metric: ChannelStatsMetricDelta,
  inverse: boolean,
): ChannelStatsSignalTone {
  if (metric.absolute === 0) {
    return 'neutral';
  }

  const positive = inverse ? metric.absolute < 0 : metric.absolute > 0;
  return positive ? 'success' : 'warning';
}

function formatChannelStatsDeltaValue(metric: ChannelStatsMetricDelta): string {
  if (typeof metric.percent === 'number' && Math.abs(metric.percent) >= 1) {
    const rounded = Math.round(metric.percent);
    return `${rounded > 0 ? '+' : ''}${rounded}%`;
  }

  if (metric.absolute !== 0) {
    return formatChannelStatsSignedInteger(metric.absolute);
  }

  return '0';
}

function formatChannelStatsSignedInteger(value: number): string {
  const normalized = toSafeInteger(value);
  return normalized > 0 ? `+${normalized}` : String(normalized);
}

function formatChannelStatsCompactCount(value: number): string {
  return new Intl.NumberFormat('ru-RU', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(Math.max(0, toSafeInteger(value)));
}

function formatChannelStatsPercentValue(value: number): string {
  const rounded = Math.round(value);
  return `${rounded > 0 ? '+' : ''}${rounded}%`;
}

function formatChannelStatsWindowValue(window: ChannelStatsBestWindow): string {
  const days = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
  const day = days[window.dayOfWeek] ?? '';
  return `${day} ${String(window.hour).padStart(2, '0')}:00`;
}

function roundChannelStatsNumber(value: number, fractionDigits: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  const multiplier = 10 ** Math.max(0, Math.min(4, Math.trunc(fractionDigits)));
  return Math.round(value * multiplier) / multiplier;
}

function toSafeInteger(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }

  if (typeof value === 'bigint') {
    return Number(value);
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
  }

  return 0;
}
