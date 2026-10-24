import type {
  StatsAudienceGrowth,
  StatsAudienceValue,
  StatsComparability,
  StatsDayKey,
  StatsHistoryRow,
  StatsMetricKey,
  StatsMetricResult,
  StatsPeriod,
  StatsReachValue,
  StatsRecentReachValue,
  StatsSummary,
  StatsSummaryCoverage,
  StatsSummaryRequest,
  StatsProvenance,
  StatsExternalAudienceValue,
  StatsMembershipValue,
  StatsPublicationValue,
  StatsHealth,
} from '@maxim/contracts/statistics-central';
import { compareTimes, keyOf, unknownHealth } from './stats-common';
import type { StatsCandidate } from './stats-types';

const actualAt = (r: StatsCandidate) =>
  'observedAt' in r.value
    ? (r.value.observedAt ?? '')
    : 'observedTo' in r.value
      ? (r.value.observedTo ?? '')
      : '';
const extent = (r: StatsCandidate) =>
  r.coverage.intervals.reduce((n, i) => n + Date.parse(i.to) - Date.parse(i.from), 0);
const rank = (r: StatsCandidate) =>
  r.coverage.state === 'COMPLETE' ? 2 : r.coverage.state === 'PARTIAL' ? 1 : 0;
export function selectStats(candidates: StatsCandidate[]): StatsCandidate[] {
  const groups = new Map<string, StatsCandidate[]>();
  for (const r of candidates) {
    const key = `${r.scope.day}:${r.scope.metric === 'AUDIENCE' ? 'AUDIENCE' : keyOf(r.scope)}`;
    const g = groups.get(key) ?? [];
    g.push(r);
    groups.set(key, g);
  }
  return [...groups.values()]
    .map(
      (g) =>
        g.sort((a, b) => {
          const availability = Number(!!a.unavailableReason) - Number(!!b.unavailableReason);
          if (availability) return availability;
          if (
            a.scope.metric === 'AUDIENCE' &&
            b.scope.metric === 'AUDIENCE' &&
            a.scope.method.id !== b.scope.method.id
          ) {
            const valid = (r: StatsCandidate) =>
              r.scope.method.id === 'AUDIENCE_SNAPSHOT' &&
              (r.value as StatsAudienceValue).value !== null &&
              !!(r.value as StatsAudienceValue).observedAt;
            const native = Number(valid(b)) - Number(valid(a));
            if (native) return native;
            return (
              Number(b.scope.method.id === 'MAXFRAME_EXTERNAL_CALENDAR') -
              Number(a.scope.method.id === 'MAXFRAME_EXTERNAL_CALENDAR')
            );
          }
          if (
            a.scope.method.id === 'AUDIENCE_SNAPSHOT' ||
            a.scope.method.id === 'RECENT_POST_SAMPLE_20'
          ) {
            const time = compareTimes(actualAt(b), actualAt(a));
            if (time) return time;
          }
          return (
            rank(b) - rank(a) ||
            Number(b.coverage.populationComplete) - Number(a.coverage.populationComplete) ||
            extent(b) - extent(a) ||
            Number(b.producer === 'MAXIM') - Number(a.producer === 'MAXIM')
          );
        })[0]!,
    )
    .sort(
      (a, b) =>
        a.scope.day.localeCompare(b.scope.day) || keyOf(a.scope).localeCompare(keyOf(b.scope)),
    );
}
export function comparability(key: StatsMetricKey): StatsComparability {
  const method = key.method.id;
  const axis =
    method === 'MAXFRAME_EXTERNAL_CALENDAR'
      ? 'EXTERNAL_CALENDAR_DAY'
      : key.metric === 'AUDIENCE' || method === 'RECENT_POST_SAMPLE_20'
        ? 'OBSERVATION_DAY'
        : key.metric === 'MEMBERSHIP'
          ? 'EVENT_DAY'
          : 'PUBLICATION_DAY';
  const calendarZone = axis === 'EXTERNAL_CALENDAR_DAY' ? 'UNSPECIFIED' : 'UTC';
  const k = `${keyOf(key)}:${axis}:${calendarZone}`;
  return {
    key: k,
    segmentId: k,
    axis,
    calendarZone,
    previousComparableDay: null,
    sourceTransition: false,
  };
}
const provenance = (r: StatsCandidate): StatsProvenance => ({
  producer: r.producer,
  method: r.scope.method,
  lineage: r.scope.method.id === 'MAXFRAME_EXTERNAL_CALENDAR' ? 'MAXFRAME_EXTERNAL' : 'NATIVE',
});
const dependencies = (rows: StatsCandidate[]) => [
  ...new Map(
    rows
      .flatMap((r) => r.dependencies ?? [])
      .map((d) => [`${d.sourceAuthorityId}:${keyOf(d.scope)}`, d]),
  ).values(),
];
export function audienceGrowth(
  a: StatsCandidate | undefined,
  b: StatsCandidate | undefined,
  completePeriod = false,
): StatsAudienceGrowth | null {
  if (
    !a ||
    !b ||
    a === b ||
    a.scope.method.id !== 'AUDIENCE_SNAPSHOT' ||
    b.scope.method.id !== 'AUDIENCE_SNAPSHOT'
  )
    return null;
  const av = a.value as StatsAudienceValue,
    bv = b.value as StatsAudienceValue;
  if (
    av.value === null ||
    bv.value === null ||
    !av.observedAt ||
    !bv.observedAt ||
    compareTimes(av.observedAt, bv.observedAt) >= 0
  )
    return null;
  return {
    comparabilityKey: comparability(a.scope).key,
    fromDay: a.scope.day,
    toDay: b.scope.day,
    fromObservedAt: av.observedAt,
    toObservedAt: bv.observedAt,
    delta: bv.value - av.value,
    sourceTransition: a.producer !== b.producer,
    completePeriod,
  };
}
export function historyRow(
  scope: StatsDayKey,
  row: StatsCandidate | undefined,
  previous?: StatsCandidate,
  unsupported = false,
): StatsHistoryRow {
  if (row?.unavailableReason)
    return { ...scope, state: 'UNKNOWN', reason: row.unavailableReason, health: row.health };
  if (!row)
    return {
      ...scope,
      state: 'UNKNOWN',
      reason: unsupported ? 'UNSUPPORTED' : 'NO_DATA',
      health: unknownHealth(),
    };
  const c = comparability(scope);
  c.previousComparableDay = previous?.scope.day ?? null;
  c.sourceTransition = !!previous && previous.producer !== row.producer;
  const base = {
    ...scope,
    state: 'VALUE',
    value: row.value,
    coverage: row.coverage,
    provenance: provenance(row),
    comparability: c,
    sourceAuthorityDependencies: row.dependencies ?? [],
    health: row.health,
  };
  return {
    ...base,
    ...(scope.method.id === 'AUDIENCE_SNAPSHOT'
      ? { growthFromPrevious: audienceGrowth(previous, row) }
      : {}),
  } as StatsHistoryRow;
}
function coverage(rows: StatsCandidate[], period: StatsPeriod): StatsSummaryCoverage {
  const knownDays = new Set(rows.map((r) => r.scope.day)).size,
    completeDays = new Set(
      rows.filter((r) => r.coverage.state === 'COMPLETE').map((r) => r.scope.day),
    ).size;
  return {
    state: completeDays === period ? 'COMPLETE' : knownDays ? 'PARTIAL' : 'UNKNOWN',
    requestedDays: period,
    knownDays,
    completeDays,
    populationComplete: completeDays === period && rows.every((r) => r.coverage.populationComplete),
  };
}
function latestHealth(rows: StatsCandidate[]): StatsHealth {
  return (
    rows
      .map((r) => r.health)
      .sort((a, b) =>
        (b.lastAttemptAt ?? b.lastSuccessAt ?? '').localeCompare(
          a.lastAttemptAt ?? a.lastSuccessAt ?? '',
        ),
      )[0] ?? unknownHealth()
  );
}
function available<T>(rows: StatsCandidate[], value: T, period: StatsPeriod): StatsMetricResult<T> {
  return {
    state: 'AVAILABLE',
    value,
    coverage: coverage(rows, period),
    provenance: [
      ...new Map(rows.map((r) => [`${r.producer}:${keyOf(r.scope)}`, provenance(r)])).values(),
    ],
    comparability: comparability(rows[0]!.scope),
    sourceAuthorityDependencies: dependencies(rows),
    health: latestHealth(rows),
  };
}
const unavailable = (
  reason: 'NO_DATA' | 'UNSUPPORTED' | 'NOT_REQUESTED' | 'NUMERIC_LIMIT' = 'NO_DATA',
): StatsMetricResult<never> => ({ state: 'UNAVAILABLE', reason, health: unknownHealth() });
const safe = (v: number) => Number.isSafeInteger(v) && v >= 0;
export function summarizeStats(
  rows: StatsCandidate[],
  period: StatsPeriod,
  kind: 'CHAT' | 'CHANNEL',
  metrics: StatsSummaryRequest['metrics'],
  horizons: StatsSummaryRequest['horizons'],
  health: Record<string, StatsHealth> = {},
): StatsSummary {
  const failures = rows.filter((r) => r.unavailableReason);
  rows = rows.filter((r) => !r.unavailableReason);
  const matching = (id: string, h = 0) =>
    rows.filter((r) => r.scope.method.id === id && r.scope.horizon === h);
  const result: StatsSummary = {
    audience: unavailable(),
    recentPostSample: unavailable(),
    reach: { current: unavailable(), at24h: unavailable(), at48h: unavailable() },
    membership: unavailable(),
    publications: unavailable(),
  };
  if (metrics.includes('AUDIENCE')) {
    const points = matching('AUDIENCE_SNAPSHOT')
      .filter(
        (r) =>
          (r.value as StatsAudienceValue).value !== null &&
          (r.value as StatsAudienceValue).observedAt,
      )
      .sort((a, b) => compareTimes(actualAt(a), actualAt(b)));
    const last = points.at(-1);
    if (last) {
      const v = last.value as StatsAudienceValue;
      result.audience = available(
        points,
        {
          metric: 'AUDIENCE',
          horizon: 0,
          method: { id: 'AUDIENCE_SNAPSHOT', version: 1 },
          value: v.value!,
          observedAt: v.observedAt!,
          growth: audienceGrowth(points[0], last, points.length === period),
        },
        period,
      );
    } else {
      const external = matching('MAXFRAME_EXTERNAL_CALENDAR').filter(
        (r) => (r.value as StatsExternalAudienceValue).value !== null,
      );
      const r = external.at(-1);
      if (r) {
        const v = r.value as StatsExternalAudienceValue;
        result.audience = available(
          external,
          {
            metric: 'AUDIENCE',
            horizon: 0,
            method: { id: 'MAXFRAME_EXTERNAL_CALENDAR', version: 1 },
            value: v.value!,
            day: r.scope.day,
            observedAt: null,
            fetchedAt: v.fetchedAt,
            calendarZone: 'UNSPECIFIED',
            growth: null,
          },
          period,
        );
      }
    }
  } else result.audience = unavailable('NOT_REQUESTED');
  const reach = (h: 0 | 24 | 48) => {
    if (kind === 'CHAT') return unavailable('UNSUPPORTED');
    if (!metrics.includes('REACH') || !horizons.includes(h)) return unavailable('NOT_REQUESTED');
    const selected = matching(h === 0 ? 'POST_PUBLICATION_DAY' : 'TIMED_POST_PUBLICATION_DAY', h);
    const valid = selected.filter((r) => (r.value as StatsReachValue).views !== null);
    if (!valid.length) return unavailable();
    const sum = valid.reduce((n, r) => n + BigInt((r.value as StatsReachValue).views!), 0n);
    const samples = valid.reduce((n, r) => n + (r.value as StatsReachValue).samples, 0);
    const posts = valid.every((r) => (r.value as StatsReachValue).posts !== null)
      ? valid.reduce((n, r) => n + (r.value as StatsReachValue).posts!, 0)
      : null;
    if (sum.toString().length > 30 || !safe(samples) || (posts !== null && !safe(posts)))
      return unavailable('NUMERIC_LIMIT');
    const from =
      valid
        .flatMap((r) =>
          (r.value as StatsReachValue).observedFrom
            ? [(r.value as StatsReachValue).observedFrom!]
            : [],
        )
        .sort(compareTimes)[0] ?? null;
    const to =
      valid
        .flatMap((r) =>
          (r.value as StatsReachValue).observedTo ? [(r.value as StatsReachValue).observedTo!] : [],
        )
        .sort()
        .at(-1) ?? null;
    const delays = valid.flatMap((r) =>
      (r.value as StatsReachValue).maxDelaySeconds === null
        ? []
        : [(r.value as StatsReachValue).maxDelaySeconds!],
    );
    return available(
      valid,
      {
        metric: 'REACH',
        horizon: h,
        method: { id: h === 0 ? 'POST_PUBLICATION_DAY' : 'TIMED_POST_PUBLICATION_DAY', version: 1 },
        views: sum.toString(),
        samples,
        posts,
        observedFrom: from,
        observedTo: to,
        maxDelaySeconds: delays.length ? Math.max(...delays) : null,
      },
      period,
    );
  };
  result.reach.current = reach(0) as StatsSummary['reach']['current'];
  result.reach.at24h = reach(24) as StatsSummary['reach']['at24h'];
  result.reach.at48h = reach(48) as StatsSummary['reach']['at48h'];
  if (kind === 'CHAT') result.recentPostSample = unavailable('UNSUPPORTED');
  else if (metrics.includes('REACH') && horizons.includes(0)) {
    const r = matching('RECENT_POST_SAMPLE_20')
      .sort((a, b) => compareTimes(actualAt(a), actualAt(b)))
      .at(-1);
    if (r)
      result.recentPostSample = available(
        [r],
        {
          metric: 'REACH',
          horizon: 0,
          method: { id: 'RECENT_POST_SAMPLE_20', version: 1 },
          ...(r.value as StatsRecentReachValue),
        },
        period,
      );
  } else result.recentPostSample = unavailable('NOT_REQUESTED');
  if (metrics.includes('MEMBERSHIP')) {
    const valid = matching('OBSERVED_MEMBER_EVENTS').filter(
      (r) =>
        (r.value as StatsMembershipValue).joined !== null ||
        (r.value as StatsMembershipValue).left !== null,
    );
    if (valid.length) {
      const values = valid.map((r) => r.value as StatsMembershipValue);
      const joined = values.every((v) => v.joined !== null)
        ? values.reduce((n, v) => n + v.joined!, 0)
        : null;
      const left = values.every((v) => v.left !== null)
        ? values.reduce((n, v) => n + v.left!, 0)
        : null;
      result.membership = available(
        valid,
        {
          metric: 'MEMBERSHIP',
          horizon: 0,
          method: { id: 'OBSERVED_MEMBER_EVENTS', version: 1 },
          joined,
          left,
          observedFrom:
            values.flatMap((v) => (v.observedFrom ? [v.observedFrom] : [])).sort(compareTimes)[0] ??
            null,
          observedTo:
            values
              .flatMap((v) => (v.observedTo ? [v.observedTo] : []))
              .sort()
              .at(-1) ?? null,
        },
        period,
      );
    }
  } else result.membership = unavailable('NOT_REQUESTED');
  if (kind === 'CHAT') result.publications = unavailable('UNSUPPORTED');
  else if (metrics.includes('PUBLICATION_HOUR')) {
    const valid = matching('PUBLICATION_DAY_HOURS');
    if (valid.length) {
      const values = valid.map((r) => r.value as StatsPublicationValue);
      const hours = Array.from({ length: 24 }, (_, i) =>
        values.every((v) => v.hours[i] !== null)
          ? values.reduce((n, v) => n + v.hours[i]!, 0)
          : null,
      );
      const count = hours.every((v) => v !== null)
        ? hours.reduce<number>((n, v) => n + v!, 0)
        : null;
      result.publications = available(
        valid,
        {
          metric: 'PUBLICATION_HOUR',
          horizon: 0,
          method: { id: 'PUBLICATION_DAY_HOURS', version: 1 },
          hours,
          count,
          observedFrom:
            values.flatMap((v) => (v.observedFrom ? [v.observedFrom] : [])).sort(compareTimes)[0] ??
            null,
          observedTo:
            values
              .flatMap((v) => (v.observedTo ? [v.observedTo] : []))
              .sort()
              .at(-1) ?? null,
        },
        period,
      );
    }
  } else result.publications = unavailable('NOT_REQUESTED');
  for (const [item, id, h] of [
    [result.audience, 'AUDIENCE_SNAPSHOT', 0],
    [result.recentPostSample, 'RECENT_POST_SAMPLE_20', 0],
    [result.reach.current, 'POST_PUBLICATION_DAY', 0],
    [result.reach.at24h, 'TIMED_POST_PUBLICATION_DAY', 24],
    [result.reach.at48h, 'TIMED_POST_PUBLICATION_DAY', 48],
    [result.membership, 'OBSERVED_MEMBER_EVENTS', 0],
    [result.publications, 'PUBLICATION_DAY_HOURS', 0],
  ] as const) {
    const current = Object.entries(health).find(
      ([k]) => k.split(':')[1] === String(h) && k.split(':')[2] === id,
    )?.[1];
    if (current && item.state === 'UNAVAILABLE' && item.reason === 'NO_DATA') item.health = current;
  }
  const guarded = <T>(
    value: StatsMetricResult<T>,
    method: string,
    horizon = 0,
  ): StatsMetricResult<T> =>
    failures.some((r) => r.scope.method.id === method && r.scope.horizon === horizon)
      ? unavailable('NUMERIC_LIMIT')
      : value;
  result.audience = guarded(result.audience, 'AUDIENCE_SNAPSHOT');
  result.recentPostSample = guarded(result.recentPostSample, 'RECENT_POST_SAMPLE_20');
  result.reach.current = guarded(result.reach.current, 'POST_PUBLICATION_DAY');
  result.reach.at24h = guarded(result.reach.at24h, 'TIMED_POST_PUBLICATION_DAY', 24);
  result.reach.at48h = guarded(result.reach.at48h, 'TIMED_POST_PUBLICATION_DAY', 48);
  result.membership = guarded(result.membership, 'OBSERVED_MEMBER_EVENTS');
  result.publications = guarded(result.publications, 'PUBLICATION_DAY_HOURS');
  return result;
}
