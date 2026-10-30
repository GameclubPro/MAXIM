import type {
  StatsAudienceValue,
  StatsCoverage,
  StatsEntity,
  StatsExternalAudienceValue,
  StatsHealth,
  StatsHorizon,
  StatsMembershipSummary,
  StatsMembershipValue,
  StatsMetric,
  StatsMetricKey,
  StatsPeriod,
  StatsProvenance,
  StatsPublicationValue,
  StatsPurpose,
  StatsReachValue,
} from '@maxim/contracts/statistics-central';
import type {
  StatsAnalyticsAudienceDayChange,
  StatsAnalyticsAudienceGrowth,
  StatsAnalyticsAudienceValue,
  StatsAnalyticsChange,
  StatsAnalyticsComparability,
  StatsAnalyticsComparison,
  StatsAnalyticsFreshness,
  StatsAnalyticsHistoryRow,
  StatsAnalyticsMetric,
  StatsAnalyticsOwnerPublicationBreakdown,
  StatsAnalyticsPercentage,
  StatsAnalyticsPublicationFrequency,
  StatsAnalyticsPublicationValue,
  StatsAnalyticsQuality,
  StatsAnalyticsReachValue,
  StatsAnalyticsSelection,
  StatsAnalyticsWindow,
  StatsAnalyticsWindowValue,
} from '@maxim/contracts/statistics-analytics';
import { audienceGrowth, comparability, selectStats } from './stats-selector';
import { compareTimes } from './stats-common';
import type { StatsCandidate } from './stats-types';
import { unionStatsCoverage } from './stats-coverage';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const MOSCOW = 3 * HOUR;
const TOLERANCE = 900_000;
const metricOrder: StatsMetric[] = ['AUDIENCE', 'MEMBERSHIP', 'PUBLICATION_HOUR', 'REACH'];
const iso = (n: number) => new Date(n).toISOString();
const date = (n: number) => iso(n).slice(0, 10);
const utc = (n: number) => Math.floor(n / DAY) * DAY;
const moscow = (n: number) => utc(n + MOSCOW) - MOSCOW;
const unknownHealth = (): StatsHealth => ({
  state: 'UNKNOWN',
  lastAttemptAt: null,
  lastSuccessAt: null,
  nextExpectedAt: null,
  errorCode: null,
});
const selectionKey = (s: StatsAnalyticsSelection) => `${s.metric}:${s.horizon}`;
const scopeKey = (s: StatsMetricKey) =>
  `${s.metric}:${s.horizon}:${s.method.id}:${s.method.version}`;
const methodFor = (s: StatsAnalyticsSelection): StatsMetricKey => {
  if (s.metric === 'AUDIENCE')
    return { metric: 'AUDIENCE', horizon: 0, method: { id: 'AUDIENCE_SNAPSHOT', version: 1 } };
  if (s.metric === 'MEMBERSHIP')
    return {
      metric: 'MEMBERSHIP',
      horizon: 0,
      method: { id: 'OBSERVED_MEMBER_EVENTS', version: 1 },
    };
  if (s.metric === 'PUBLICATION_HOUR')
    return {
      metric: 'PUBLICATION_HOUR',
      horizon: 0,
      method: { id: 'PUBLICATION_DAY_HOURS', version: 1 },
    };
  return s.horizon === 0
    ? { metric: 'REACH', horizon: 0, method: { id: 'POST_PUBLICATION_DAY', version: 1 } }
    : {
        metric: 'REACH',
        horizon: s.horizon,
        method: { id: 'TIMED_POST_PUBLICATION_DAY', version: 1 },
      };
};
export type StatsAnalyticsWindowPlan = {
  selections: StatsAnalyticsSelection[];
  fromDay: string;
  toDay: string;
  retentionFloor: string;
  windows: Array<{
    selection: StatsAnalyticsSelection;
    current: StatsAnalyticsWindow;
    comparison: { current: StatsAnalyticsWindow; previous: StatsAnalyticsWindow } | null;
  }>;
};
function window(
  from: number,
  to: number,
  zone: 'UTC' | 'Europe/Moscow',
  asOf: number,
  retention: number,
): StatsAnalyticsWindow {
  const offset = zone === 'UTC' ? 0 : MOSCOW;
  return {
    calendarZone: zone,
    fromDay: date(from + offset),
    toDayExclusive: date(to + offset),
    from: iso(from),
    to: iso(to),
    availableFrom: iso(Math.max(from, retention)),
    observedUntil: iso(Math.min(to, asOf)),
  };
}
export function planAnalyticsWindows(
  asOf: string,
  periodDays: StatsPeriod,
  metrics: StatsMetric[],
  horizons: StatsHorizon[],
  includeComparison: boolean,
): StatsAnalyticsWindowPlan {
  const at = Date.parse(asOf),
    retention = utc(at) - 89 * DAY;
  const selections = metricOrder
    .filter((metric) => metrics.includes(metric))
    .flatMap<StatsAnalyticsSelection>((metric) =>
      metric === 'REACH'
        ? [...new Set(horizons)].sort((a, b) => a - b).map((horizon) => ({ metric, horizon }))
        : [{ metric, horizon: 0 }],
    );
  const windows = selections.map((selection) => {
    const zone = selection.metric === 'PUBLICATION_HOUR' ? 'Europe/Moscow' : 'UTC';
    const floor = zone === 'UTC' ? utc(at) : moscow(at);
    const current = window(floor - (periodDays - 1) * DAY, floor + DAY, zone, at, retention);
    let comparison: StatsAnalyticsWindowPlan['windows'][number]['comparison'] = null;
    if (
      includeComparison &&
      periodDays !== 90 &&
      selection.metric !== 'AUDIENCE' &&
      !(selection.metric === 'REACH' && selection.horizon === 0)
    ) {
      const end =
        selection.metric === 'REACH' ? utc(at - selection.horizon * HOUR - TOLERANCE) : floor;
      comparison = {
        current: window(end - periodDays * DAY, end, zone, at, retention),
        previous: window(end - 2 * periodDays * DAY, end - periodDays * DAY, zone, at, retention),
      };
    }
    return { selection, current, comparison };
  });
  const starts = windows.flatMap((w) => [
    Date.parse(w.current.from!) - (w.selection.metric === 'AUDIENCE' ? DAY : 0),
    ...(w.comparison ? [Date.parse(w.comparison.previous.from!)] : []),
  ]);
  return {
    selections,
    windows,
    fromDay: date(Math.max(retention, Math.min(...starts, utc(at)))),
    toDay: date(at),
    retentionFloor: date(retention),
  };
}
export type StatsAnalyticsCalculatorInput = {
  candidates: StatsCandidate[];
  asOf: string;
  periodDays: StatsPeriod;
  metrics: StatsMetric[];
  horizons: StatsHorizon[];
  includeComparison: boolean;
  includeHistory: boolean;
  entityKind: StatsEntity['kind'];
  health: Record<string, StatsHealth>;
  purpose?: StatsPurpose;
};
export type StatsAnalyticsHistorySlot = { day: string; selection: StatsAnalyticsSelection };
type Value =
  | StatsAnalyticsAudienceValue
  | StatsAnalyticsReachValue
  | StatsAnalyticsPublicationValue
  | StatsMembershipSummary;
type Fold = StatsAnalyticsWindowValue<Value>;
const provenance = (r: StatsCandidate): StatsProvenance => ({
  producer: r.producer,
  method: r.scope.method,
  lineage: r.scope.method.id === 'MAXFRAME_EXTERNAL_CALENDAR' ? 'MAXFRAME_EXTERNAL' : 'NATIVE',
});
const uniqueProvenance = (rows: StatsCandidate[]) => [
  ...new Map(rows.map((r) => [`${r.producer}:${scopeKey(r.scope)}`, provenance(r)])).values(),
];
const actualAt = (r: StatsCandidate) =>
  'observedAt' in r.value ? r.value.observedAt : r.value.observedTo;
function latestHealth(rows: StatsCandidate[], explicit?: StatsHealth): StatsHealth {
  return (
    [...(explicit ? [explicit] : []), ...rows.map((r) => r.health)].sort((a, b) =>
      compareTimes(
        b.lastAttemptAt ?? b.lastSuccessAt ?? '',
        a.lastAttemptAt ?? a.lastSuccessAt ?? '',
      ),
    )[0] ?? unknownHealth()
  );
}
function freshness(
  observed: string | null,
  metric: StatsMetric,
  at: number,
): StatsAnalyticsFreshness {
  if (!observed) return { state: 'UNKNOWN', staleAt: null };
  const stale = Date.parse(observed) + (metric === 'REACH' ? HOUR : 48 * HOUR);
  return { state: at < stale ? 'FRESH' : 'STALE', staleAt: iso(stale) };
}
function normalizedIntervals(
  intervals: StatsCoverage['intervals'],
  from: number,
  to: number,
): StatsCoverage['intervals'] {
  return unionStatsCoverage(intervals, iso(from), iso(to));
}
function covers(intervals: StatsCoverage['intervals'], from: number, to: number): boolean {
  const union = normalizedIntervals(intervals, from, to);
  return (
    union.length === 1 &&
    compareTimes(union[0]!.from, iso(from)) === 0 &&
    compareTimes(union[0]!.to, iso(to)) === 0
  );
}
function round(n: bigint, d: bigint): bigint {
  if (d <= 0n) throw new Error('Nonpositive statistics denominator');
  return n < 0n ? -round(-n, d) : (2n * n + d) / (2n * d);
}
function decimal(n: bigint, d: bigint, places: number): string {
  const v = round(n * 10n ** BigInt(places), d),
    negative = v < 0n,
    magnitude = (negative ? -v : v).toString().padStart(places + 1, '0');
  return `${negative ? '-' : ''}${magnitude.slice(0, -places)}.${magnitude.slice(-places)}`;
}
function percentage(n: bigint, baseline: bigint): StatsAnalyticsPercentage {
  return baseline === 0n
    ? { state: 'UNAVAILABLE', reason: 'ZERO_BASELINE' }
    : { state: 'AVAILABLE', value: decimal(n * 100n, baseline, 2) };
}
const average = (views: string | null, samples: number) =>
  views === null || samples === 0 ? null : round(BigInt(views), BigInt(samples)).toString();
const safe = (n: number) => Number.isSafeInteger(n) && n >= 0;
const totalSafe = (s: string | null) => s === null || /^(0|[1-9][0-9]{0,29})$/u.test(s);
const sumNullable = (values: Array<number | null>) =>
  values.some((n) => n !== null) ? values.reduce<number>((sum, n) => sum + (n ?? 0), 0) : null;
function prepare(input: StatsAnalyticsCalculatorInput) {
  const at = Date.parse(input.asOf),
    retention = utc(at) - 89 * DAY;
  const plan = planAnalyticsWindows(
    input.asOf,
    input.periodDays,
    input.metrics,
    input.horizons,
    input.includeComparison,
  );
  const candidates = selectStats(
    input.candidates.filter((r) => {
      if (r.scope.day < plan.retentionFloor || r.scope.day > date(at)) return false;
      if (
        !plan.selections.some((s) => s.metric === r.scope.metric && s.horizon === r.scope.horizon)
      )
        return false;
      if (r.scope.method.id === 'RECENT_POST_SAMPLE_20') return false;
      if (r.scope.metric === 'PUBLICATION_HOUR') return true;
      const observed = actualAt(r);
      return (
        (!observed || compareTimes(observed, input.asOf) <= 0) &&
        (!('fetchedAt' in r.value) || compareTimes(r.value.fetchedAt, input.asOf) <= 0)
      );
    }),
  );
  return { at, retention, plan, candidates };
}
type Prepared = ReturnType<typeof prepare>;
function matching(p: Prepared, s: StatsAnalyticsSelection): StatsCandidate[] {
  return p.candidates.filter((r) => r.scope.metric === s.metric && r.scope.horizon === s.horizon);
}
function comparable(scope: StatsMetricKey): StatsAnalyticsComparability {
  const c = comparability(scope);
  if (scope.metric === 'PUBLICATION_HOUR')
    return {
      ...c,
      key: c.key.replace(/UTC$/u, 'Europe/Moscow'),
      segmentId: c.segmentId.replace(/UTC$/u, 'Europe/Moscow'),
      calendarZone: 'Europe/Moscow',
    };
  return c;
}
function rowWindow(day: string, metric: StatsMetric, p: Prepared): StatsAnalyticsWindow {
  const offset = metric === 'PUBLICATION_HOUR' ? MOSCOW : 0,
    from = Date.parse(`${day}T00:00:00Z`) - offset;
  return window(from, from + DAY, offset ? 'Europe/Moscow' : 'UTC', p.at, p.retention);
}
function audienceChange(
  row: StatsCandidate | undefined,
  previous: StatsCandidate | undefined,
): StatsAnalyticsAudienceDayChange {
  if (!row || !('observedAt' in row.value) || row.value.value === null || !row.value.observedAt)
    return {
      value: null,
      reason:
        row?.scope.method.id === 'MAXFRAME_EXTERNAL_CALENDAR'
          ? 'INCOMPATIBLE_METHOD'
          : 'NO_CURRENT_OBSERVATION',
      interval: null,
    };
  if (!previous) return { value: null, reason: 'NO_PREVIOUS_OBSERVATION', interval: null };
  const change = audienceGrowth(previous, row);
  if (!change) return { value: null, reason: 'INCOMPATIBLE_METHOD', interval: null };
  const interval = {
    fromDay: change.fromDay,
    toDay: change.toDay,
    fromObservedAt: change.fromObservedAt,
    toObservedAt: change.toObservedAt,
  };
  if (
    Date.parse(`${row.scope.day}T00:00:00Z`) - Date.parse(`${previous.scope.day}T00:00:00Z`) !==
    DAY
  )
    return { value: null, reason: 'GAP_IN_OBSERVATIONS', interval };
  return { value: change.delta, reason: null, interval };
}
function publicationDay(p: Prepared, day: string, rows: StatsCandidate[]) {
  const w = rowWindow(day, 'PUBLICATION_HOUR', p),
    from = Date.parse(w.from!),
    to = Date.parse(w.to!);
  const relevant = rows.filter((r) => {
    const a = Date.parse(`${r.scope.day}T00:00:00Z`);
    return a < to && a + DAY > from;
  });
  const intervals = normalizedIntervals(
    relevant.flatMap((r) => r.coverage.intervals),
    Math.max(from, p.retention),
    Math.min(to, p.at),
  );
  const hours: Array<number | null> = Array.from({ length: 24 }, () => null);
  const measuredBounds: number[] = [];
  const contributors = new Set<StatsCandidate>();
  for (let hour = 0; hour < 24; hour++) {
    const start = from + hour * HOUR,
      end = start + HOUR;
    if (start < p.retention || start >= p.at) continue;
    const row = relevant.find((r) => r.scope.day === date(start));
    const value = row?.value as StatsPublicationValue | undefined;
    const measured = value?.hours[new Date(start).getUTCHours()] ?? null;
    if (measured !== null && !row?.unavailableReason) {
      hours[hour] = measured;
      measuredBounds.push(start, Math.min(end, p.at));
      if (row) contributors.add(row);
    } else if (end <= p.at && covers(intervals, start, end)) hours[hour] = 0;
  }
  for (const row of relevant)
    if (row.coverage.intervals.some((i) => Date.parse(i.from) < to && Date.parse(i.to) > from))
      contributors.add(row);
  const full = to <= p.at && from >= p.retention && covers(intervals, from, to);
  const known = hours.some((n) => n !== null);
  const coverage: StatsCoverage = {
    state: full ? 'COMPLETE' : known || intervals.length ? 'PARTIAL' : 'UNKNOWN',
    intervals,
    populationComplete: full && [...contributors].every((r) => r.coverage.populationComplete),
  };
  const bounds = [
    ...measuredBounds,
    ...intervals.flatMap((i) => [Date.parse(i.from), Date.parse(i.to)]),
  ];
  return {
    window: w,
    value: {
      hours,
      count: sumNullable(hours),
      observedFrom: bounds.length ? iso(Math.min(...bounds)) : null,
      observedTo: bounds.length ? iso(Math.max(...bounds)) : null,
    },
    coverage,
    contributors: [...contributors],
    numericLimit:
      relevant.some((r) => r.unavailableReason) ||
      !hours.every((n) => n === null || safe(n)) ||
      !safe(sumNullable(hours) ?? 0),
  };
}
function dayRows(
  input: StatsAnalyticsCalculatorInput,
  p: Prepared,
  slots?: StatsAnalyticsHistorySlot[],
): StatsAnalyticsHistoryRow[] {
  const wanted = slots && new Set(slots.map((s) => `${s.day}:${selectionKey(s.selection)}`));
  const result: StatsAnalyticsHistoryRow[] = [];
  for (const { selection, current } of p.plan.windows) {
    const rows = matching(p, selection),
      supported = input.entityKind === 'CHANNEL' || selection.metric === 'AUDIENCE';
    for (
      let dayAt = Date.parse(`${current.fromDay}T00:00:00Z`);
      dayAt < Date.parse(`${current.toDayExclusive}T00:00:00Z`);
      dayAt += DAY
    ) {
      const day = date(dayAt);
      if (wanted && !wanted.has(`${day}:${selectionKey(selection)}`)) continue;
      const row = rows.find((r) => r.scope.day === day),
        scope = row?.scope ?? { ...methodFor(selection), day };
      const base = {
        ...scope,
        day,
        window: rowWindow(day, selection.metric, p),
        health: latestHealth(row ? [row] : [], input.health[scopeKey(scope)]),
        freshness: freshness(row ? actualAt(row) : null, selection.metric, p.at),
      };
      const previous = rows
        .filter((r) => r.scope.day < day && 'observedAt' in r.value && r.value.value !== null)
        .at(-1);
      const extra =
        selection.metric === 'AUDIENCE'
          ? { changeFromPrevious: audienceChange(row, previous) }
          : {};
      if (!supported) {
        result.push({
          ...base,
          ...extra,
          state: 'UNKNOWN',
          reason: 'UNSUPPORTED',
        } as StatsAnalyticsHistoryRow);
        continue;
      }
      if (selection.metric === 'PUBLICATION_HOUR') {
        const publication = publicationDay(p, day, rows);
        const b = {
          ...base,
          window: publication.window,
          health: latestHealth(publication.contributors, input.health[scopeKey(scope)]),
          freshness: freshness(publication.value.observedTo, selection.metric, p.at),
        };
        result.push(
          publication.numericLimit || publication.value.count === null
            ? ({
                ...b,
                state: 'UNKNOWN',
                reason: publication.numericLimit ? 'NUMERIC_LIMIT' : 'NO_DATA',
              } as StatsAnalyticsHistoryRow)
            : ({
                ...b,
                state: 'VALUE',
                value: publication.value,
                coverage: publication.coverage,
                provenance: uniqueProvenance(publication.contributors),
                comparability: comparable(scope),
              } as StatsAnalyticsHistoryRow),
        );
        continue;
      }
      if (!row || row.unavailableReason) {
        result.push({
          ...base,
          ...extra,
          state: 'UNKNOWN',
          reason: row?.unavailableReason ?? 'NO_DATA',
        } as StatsAnalyticsHistoryRow);
        continue;
      }
      const c = comparable(scope);
      c.previousComparableDay = previous?.scope.day ?? null;
      c.sourceTransition = !!previous && previous.producer !== row.producer;
      if (scope.method.id === 'MAXFRAME_EXTERNAL_CALENDAR')
        base.window = {
          ...base.window,
          calendarZone: 'UNSPECIFIED',
          from: null,
          to: null,
          availableFrom: null,
          observedUntil: null,
        };
      const value =
        selection.metric === 'REACH'
          ? {
              ...(row.value as StatsReachValue),
              averageViews: average(
                (row.value as StatsReachValue).views,
                (row.value as StatsReachValue).samples,
              ),
            }
          : row.value;
      result.push({
        ...base,
        ...extra,
        state: 'VALUE',
        value,
        coverage: row.coverage,
        provenance: [provenance(row)],
        comparability: c,
      } as StatsAnalyticsHistoryRow);
    }
  }
  return result.sort(
    (a, b) =>
      a.day.localeCompare(b.day) ||
      metricOrder.indexOf(a.metric) - metricOrder.indexOf(b.metric) ||
      a.horizon - b.horizon,
  );
}
function days(w: StatsAnalyticsWindow): string[] {
  const result: string[] = [];
  for (
    let at = Date.parse(`${w.fromDay}T00:00:00Z`);
    at < Date.parse(`${w.toDayExclusive}T00:00:00Z`);
    at += DAY
  )
    result.push(date(at));
  return result;
}
function frequency(posts: number, completeDates: number): StatsAnalyticsPublicationFrequency {
  return {
    postsOnCompleteDates: posts,
    completeDates,
    averagePostsPerCompleteDate: completeDates
      ? decimal(BigInt(posts), BigInt(completeDates), 1)
      : null,
  };
}
function fold(
  input: StatsAnalyticsCalculatorInput,
  p: Prepared,
  selection: StatsAnalyticsSelection,
  w: StatsAnalyticsWindow,
): Fold {
  let rows = matching(p, selection).filter(
    (r) => r.scope.day >= w.fromDay && r.scope.day < w.toDayExclusive,
  );
  const scope = methodFor(selection),
    supported = input.entityKind === 'CHANNEL' || selection.metric === 'AUDIENCE';
  const requested = days(w);
  const emptyQuality: StatsAnalyticsQuality = {
    coverage: {
      state: 'UNKNOWN',
      requestedDays: input.periodDays,
      knownDays: 0,
      completeDays: 0,
      populationComplete: false,
    },
    comparability: null,
    provenance: [],
    health: latestHealth(rows, input.health[scopeKey(scope)]),
    freshness: { state: 'UNKNOWN', staleAt: null },
  };
  const unavailable = (
    reason: 'NO_DATA' | 'NUMERIC_LIMIT' | 'UNSUPPORTED',
    quality = emptyQuality,
  ): Fold => ({ window: w, quality, state: 'UNAVAILABLE', reason });
  if (!supported) return unavailable('UNSUPPORTED');
  let known = 0,
    complete = 0,
    populationComplete = false;
  let value: Value | undefined,
    valueWindow = w;
  let observed: string | null = null;
  if (selection.metric === 'PUBLICATION_HOUR') {
    const publicationDays = requested.map((d) => publicationDay(p, d, matching(p, selection)));
    rows = [...new Set(publicationDays.flatMap((d) => d.contributors))];
    if (publicationDays.some((d) => d.numericLimit)) return unavailable('NUMERIC_LIMIT');
    known = publicationDays.filter((d) => d.value.count !== null).length;
    const completed = publicationDays.filter(
      (d) => d.coverage.state === 'COMPLETE' && d.coverage.populationComplete,
    );
    complete = completed.length;
    populationComplete = complete === requested.length;
    const hours = Array.from({ length: 24 }, (_, hour) =>
      sumNullable(publicationDays.map((d) => d.value.hours[hour]!)),
    );
    const count = sumNullable(publicationDays.map((d) => d.value.count));
    const extents = publicationDays
      .flatMap((d) => [d.value.observedFrom, d.value.observedTo])
      .filter((v): v is string => v !== null)
      .sort();
    observed = extents.at(-1) ?? null;
    if (count !== null)
      value = {
        metric: 'PUBLICATION_HOUR',
        horizon: 0,
        method: { id: 'PUBLICATION_DAY_HOURS', version: 1 },
        count,
        hours,
        observedFrom: extents[0] ?? null,
        observedTo: observed,
        frequency: frequency(
          completed.reduce((sum, d) => sum + (d.value.count ?? 0), 0),
          complete,
        ),
      };
  } else {
    if (rows.some((r) => r.unavailableReason)) return unavailable('NUMERIC_LIMIT');
    if (selection.metric === 'AUDIENCE') {
      const points = rows
        .filter(
          (r) =>
            r.scope.method.id === 'AUDIENCE_SNAPSHOT' &&
            (r.value as StatsAudienceValue).value !== null &&
            !!(r.value as StatsAudienceValue).observedAt,
        )
        .sort((a, b) => compareTimes(actualAt(a)!, actualAt(b)!));
      const last =
        points.at(-1) ??
        rows
          .filter(
            (r) =>
              r.scope.method.id === 'MAXFRAME_EXTERNAL_CALENDAR' &&
              (r.value as StatsExternalAudienceValue).value !== null,
          )
          .at(-1);
      if (last) {
        rows =
          last.scope.method.id === 'AUDIENCE_SNAPSHOT'
            ? points
            : rows.filter((r) => r.scope.method.id === 'MAXFRAME_EXTERNAL_CALENDAR');
        const a = last.value as StatsAudienceValue | StatsExternalAudienceValue;
        if (last.scope.method.id === 'MAXFRAME_EXTERNAL_CALENDAR' && 'fetchedAt' in a) {
          value = {
            metric: 'AUDIENCE',
            horizon: 0,
            method: { id: 'MAXFRAME_EXTERNAL_CALENDAR', version: 1 },
            value: a.value!,
            day: last.scope.day,
            observedAt: null,
            fetchedAt: a.fetchedAt,
            calendarZone: 'UNSPECIFIED',
          };
          valueWindow = {
            ...w,
            calendarZone: 'UNSPECIFIED',
            from: null,
            to: null,
            availableFrom: null,
            observedUntil: null,
          };
        } else {
          value = {
            metric: 'AUDIENCE',
            horizon: 0,
            method: { id: 'AUDIENCE_SNAPSHOT', version: 1 },
            value: a.value!,
            observedAt: a.observedAt!,
          };
          observed = a.observedAt;
        }
      }
    } else if (selection.metric === 'REACH') {
      const values = rows.map((r) => r.value as StatsReachValue);
      const samples = values.reduce((sum, r) => sum + r.samples, 0),
        views = values.some((v) => v.views !== null)
          ? values.reduce((sum, r) => sum + BigInt(r.views ?? '0'), 0n).toString()
          : null;
      const posts =
        rows.length && values.every((r) => r.posts !== null)
          ? values.reduce((sum, r) => sum + r.posts!, 0)
          : null;
      if (!safe(samples) || !safe(posts ?? 0) || !totalSafe(views))
        return unavailable('NUMERIC_LIMIT');
      const from =
        values
          .map((r) => r.observedFrom)
          .filter((t): t is string => t !== null)
          .sort()[0] ?? null;
      observed =
        values
          .map((r) => r.observedTo)
          .filter((t): t is string => t !== null)
          .sort()
          .at(-1) ?? null;
      const delays = values.map((r) => r.maxDelaySeconds).filter((n): n is number => n !== null);
      if (rows.length && (views !== null || posts !== null))
        value = {
          ...scope,
          views,
          samples,
          posts,
          observedFrom: from,
          observedTo: observed,
          maxDelaySeconds: delays.length ? Math.max(...delays) : null,
          averageViews: average(views, samples),
        } as StatsAnalyticsReachValue;
    } else {
      const values = rows.map((r) => r.value as StatsMembershipValue);
      const joined = sumNullable(values.map((v) => v.joined)),
        left = sumNullable(values.map((v) => v.left));
      if (!safe(joined ?? 0) || !safe(left ?? 0)) return unavailable('NUMERIC_LIMIT');
      observed =
        values
          .map((r) => r.observedTo)
          .filter((t): t is string => t !== null)
          .sort()
          .at(-1) ?? null;
      if (joined !== null || left !== null)
        value = {
          metric: 'MEMBERSHIP',
          horizon: 0,
          method: { id: 'OBSERVED_MEMBER_EVENTS', version: 1 },
          joined,
          left,
          observedFrom:
            values
              .map((r) => r.observedFrom)
              .filter((t): t is string => t !== null)
              .sort(compareTimes)[0] ?? null,
          observedTo: observed,
        };
    }
    const knownRows = rows.filter((r) =>
      selection.metric === 'AUDIENCE'
        ? (r.value as StatsAudienceValue).value !== null &&
          (r.scope.method.id === 'MAXFRAME_EXTERNAL_CALENDAR' ||
            !!(r.value as StatsAudienceValue).observedAt)
        : selection.metric === 'REACH'
          ? (r.value as StatsReachValue).views !== null ||
            (r.value as StatsReachValue).posts !== null
          : (r.value as StatsMembershipValue).joined !== null ||
            (r.value as StatsMembershipValue).left !== null,
    );
    known = new Set(knownRows.map((r) => r.scope.day)).size;
    const completed = knownRows.filter((r) => {
      const start = Date.parse(`${r.scope.day}T00:00:00Z`),
        end = start + DAY;
      return (
        end <= p.at &&
        r.coverage.state === 'COMPLETE' &&
        (selection.metric === 'AUDIENCE' || covers(r.coverage.intervals, start, end))
      );
    });
    complete = new Set(completed.map((r) => r.scope.day)).size;
    populationComplete =
      complete === requested.length && completed.every((r) => r.coverage.populationComplete);
  }
  const quality: StatsAnalyticsQuality = {
    coverage: {
      state: complete === requested.length ? 'COMPLETE' : known ? 'PARTIAL' : 'UNKNOWN',
      requestedDays: input.periodDays,
      knownDays: known,
      completeDays: Math.min(complete, known),
      populationComplete,
    },
    comparability: value
      ? { ...comparable(value), sourceTransition: new Set(rows.map((r) => r.producer)).size > 1 }
      : null,
    provenance: uniqueProvenance(rows),
    health: latestHealth(rows, input.health[scopeKey(value ?? scope)]),
    freshness: freshness(observed, selection.metric, p.at),
  };
  return value
    ? { window: valueWindow, quality, state: 'AVAILABLE', value }
    : unavailable('NO_DATA', quality);
}
function growth(
  p: Prepared,
  selection: StatsAnalyticsSelection,
  w: StatsAnalyticsWindow,
): StatsAnalyticsAudienceGrowth {
  const rows = matching(p, selection).filter(
    (r) => r.scope.day >= w.fromDay && r.scope.day < w.toDayExclusive && !r.unavailableReason,
  );
  const points = rows
    .filter(
      (r) =>
        r.scope.method.id === 'AUDIENCE_SNAPSHOT' &&
        (r.value as StatsAudienceValue).value !== null &&
        !!(r.value as StatsAudienceValue).observedAt,
    )
    .sort((a, b) => compareTimes(actualAt(a)!, actualAt(b)!));
  const first = points[0],
    last = points.at(-1);
  const change = audienceGrowth(
    first,
    last,
    days(w).every((d) => points.some((r) => r.scope.day === d)),
  );
  if (!change || !first || !last)
    return {
      state: 'UNAVAILABLE',
      reason: points.length
        ? 'INSUFFICIENT_OBSERVATIONS'
        : rows.length
          ? 'INCOMPATIBLE_METHOD'
          : 'NO_DATA',
    };
  const fromValue = (first.value as StatsAudienceValue).value!,
    toValue = (last.value as StatsAudienceValue).value!;
  return {
    state: 'AVAILABLE',
    value: {
      ...change,
      sourceTransition: points.some(
        (point, index) => index > 0 && point.producer !== points[index - 1]!.producer,
      ),
      fromValue,
      toValue,
      observationCount: points.length,
    },
    percent: percentage(BigInt(toValue - fromValue), BigInt(fromValue)),
  };
}
function comparison(
  input: StatsAnalyticsCalculatorInput,
  p: Prepared,
  w: StatsAnalyticsWindowPlan['windows'][number],
): StatsAnalyticsComparison<Value> {
  if (!input.includeComparison) return { state: 'NOT_REQUESTED' };
  const unavailable = (
    reason: Extract<StatsAnalyticsComparison<Value>, { state: 'UNAVAILABLE' }>['reason'],
  ): StatsAnalyticsComparison<Value> => ({ state: 'UNAVAILABLE', reason, windows: w.comparison });
  if (input.entityKind === 'CHAT' && w.selection.metric !== 'AUDIENCE')
    return unavailable('UNSUPPORTED');
  if (w.selection.metric === 'AUDIENCE') return unavailable('AUDIENCE_USES_GROWTH');
  if (w.selection.metric === 'REACH' && w.selection.horizon === 0)
    return unavailable('VARIABLE_POST_AGE');
  if (input.periodDays === 90 || !w.comparison) return unavailable('OUTSIDE_RETENTION');
  const current = fold(input, p, w.selection, w.comparison.current),
    previous = fold(input, p, w.selection, w.comparison.previous);
  if (current.state !== 'AVAILABLE' || previous.state !== 'AVAILABLE')
    return unavailable(
      (current.state === 'UNAVAILABLE' && current.reason === 'NUMERIC_LIMIT') ||
        (previous.state === 'UNAVAILABLE' && previous.reason === 'NUMERIC_LIMIT')
        ? 'NUMERIC_LIMIT'
        : 'NO_DATA',
    );
  if (current.quality.comparability?.key !== previous.quality.comparability?.key)
    return unavailable('INCOMPATIBLE_METHOD');
  if (
    ![current, previous].every(
      (v) => v.quality.coverage.state === 'COMPLETE' && v.quality.coverage.populationComplete,
    )
  )
    return unavailable('INCOMPLETE_COVERAGE');
  const changes: StatsAnalyticsChange[] = [];
  const a = current.value,
    b = previous.value;
  if (a.metric === 'REACH' && b.metric === 'REACH') {
    if (a.posts === null || b.posts === null || a.samples !== a.posts || b.samples !== b.posts)
      return unavailable('INCOMPLETE_COVERAGE');
    if (a.samples < 5 || b.samples < 5) return unavailable('INSUFFICIENT_SAMPLES');
    if (a.views === null || b.views === null) return unavailable('NO_DATA');
    const cross = BigInt(a.views) * BigInt(b.samples) - BigInt(b.views) * BigInt(a.samples);
    const absolute = round(cross, BigInt(a.samples) * BigInt(b.samples)).toString();
    if (absolute.replace('-', '').length > 30) return unavailable('NUMERIC_LIMIT');
    changes.push({
      field: 'AVERAGE_VIEWS',
      absolute,
      percent: percentage(cross, BigInt(b.views) * BigInt(a.samples)),
    });
  } else if (a.metric === 'PUBLICATION_HOUR' && b.metric === 'PUBLICATION_HOUR') {
    if (a.count === null || b.count === null) return unavailable('NO_DATA');
    changes.push({
      field: 'PUBLICATIONS',
      absolute: a.count - b.count,
      percent: percentage(BigInt(a.count - b.count), BigInt(b.count)),
    });
  } else if (a.metric === 'MEMBERSHIP' && b.metric === 'MEMBERSHIP') {
    if (a.joined === null || a.left === null || b.joined === null || b.left === null)
      return unavailable('NO_DATA');
    changes.push(
      {
        field: 'JOINED',
        absolute: a.joined - b.joined,
        percent: percentage(BigInt(a.joined - b.joined), BigInt(b.joined)),
      },
      {
        field: 'LEFT',
        absolute: a.left - b.left,
        percent: percentage(BigInt(a.left - b.left), BigInt(b.left)),
      },
    );
  } else return unavailable('INCOMPATIBLE_METHOD');
  return {
    state: 'AVAILABLE',
    current: { window: current.window, value: a, quality: current.quality },
    previous: { window: previous.window, value: b, quality: previous.quality },
    changes,
  };
}
function publicationBreakdown(
  input: StatsAnalyticsCalculatorInput,
  p: Prepared,
): StatsAnalyticsOwnerPublicationBreakdown | null {
  const selected = p.plan.windows.find((w) => w.selection.metric === 'PUBLICATION_HOUR');
  if (
    !input.includeHistory ||
    input.purpose === 'PUBLISHED_AGGREGATE' ||
    input.entityKind === 'CHAT' ||
    !selected
  )
    return null;
  const values = days(selected.current).map((day) => ({
    day,
    ...publicationDay(p, day, matching(p, selected.selection)),
  }));
  const weekday = (day: string) => (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;
  const weekdays = Array.from({ length: 7 }, (_, day) => {
    const complete = values.filter(
      (v) =>
        weekday(v.day) === day && v.coverage.state === 'COMPLETE' && v.coverage.populationComplete,
    );
    return {
      weekday: day,
      ...frequency(
        complete.reduce((sum, v) => sum + (v.value.count ?? 0), 0),
        complete.length,
      ),
    };
  });
  const heatmap = Array.from({ length: 168 }, (_, index) => {
    const bins = values
      .filter((v) => weekday(v.day) === Math.floor(index / 24))
      .map((v) => v.value.hours[index % 24] ?? null);
    return bins.length && bins.every((v) => v !== null)
      ? bins.reduce<number>((sum, v) => sum + (v ?? 0), 0)
      : null;
  });
  const activeDays = values.every(
    (v) =>
      (v.value.count ?? 0) > 0 ||
      (v.coverage.state === 'COMPLETE' && v.coverage.populationComplete),
  )
    ? values.filter((v) => (v.value.count ?? 0) > 0).length
    : null;
  const hourly = Array.from({ length: 24 }, (_, hour) =>
    values.map((v) => v.value.hours[hour] ?? null),
  );
  const sums = hourly.map((v) =>
    v.every((n) => n !== null) ? v.reduce<number>((sum, n) => sum + (n ?? 0), 0) : null,
  );
  const max = Math.max(...sums.map((n) => n ?? 0));
  const peakHour = sums.every((n) => n !== null) && max > 0 ? sums.indexOf(max) : null;
  return { weekdays, heatmap, activeDays, peakHour };
}
export function calculateStatsAnalyticsHistory(
  input: StatsAnalyticsCalculatorInput & { slots?: StatsAnalyticsHistorySlot[] },
): StatsAnalyticsHistoryRow[] {
  return input.includeHistory && input.purpose !== 'PUBLISHED_AGGREGATE'
    ? dayRows(input, prepare(input), input.slots)
    : [];
}
export function calculateStatsAnalytics(input: StatsAnalyticsCalculatorInput): {
  metrics: StatsAnalyticsMetric[];
  rows: StatsAnalyticsHistoryRow[];
  publicationBreakdown: StatsAnalyticsOwnerPublicationBreakdown | null;
} {
  const p = prepare(input);
  const metrics = p.plan.windows.map(
    (w) =>
      ({
        ...w.selection,
        unit:
          w.selection.metric === 'AUDIENCE'
            ? 'PEOPLE'
            : w.selection.metric === 'REACH'
              ? 'VIEWS_PER_POST'
              : w.selection.metric === 'PUBLICATION_HOUR'
                ? 'POSTS'
                : 'EVENTS',
        capability:
          input.entityKind === 'CHANNEL' || w.selection.metric === 'AUDIENCE'
            ? 'SUPPORTED'
            : 'UNSUPPORTED',
        current: fold(input, p, w.selection, w.current),
        comparison: comparison(input, p, w),
        ...(w.selection.metric === 'AUDIENCE' ? { growth: growth(p, w.selection, w.current) } : {}),
      }) as StatsAnalyticsMetric,
  );
  return {
    metrics,
    rows: input.includeHistory && input.purpose !== 'PUBLISHED_AGGREGATE' ? dayRows(input, p) : [],
    publicationBreakdown: publicationBreakdown(input, p),
  };
}
