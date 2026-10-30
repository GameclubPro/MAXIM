import {
  calculateStatsAnalytics,
  calculateStatsAnalyticsHistory,
  planAnalyticsWindows,
  type StatsAnalyticsCalculatorInput,
} from './stats-analytics-calculator';
import {
  statsAnalyticsMetricSchema,
  statsAnalyticsHistoryRowSchema,
} from '@maxim/contracts/statistics-analytics-validation';
import type { StatsCandidate } from './stats-types';
import type { StatsHealth, StatsHorizon } from '@maxim/contracts/statistics-central';

const health: StatsHealth = {
  state: 'OK',
  lastAttemptAt: '2026-10-30T12:00:00Z',
  lastSuccessAt: '2026-10-30T12:00:00Z',
  nextExpectedAt: null,
  errorCode: null,
};
const at = '2026-10-30T12:00:00Z';
const dayMs = 86_400_000;
const iso = (n: number) => new Date(n).toISOString();
const input = (
  overrides: Partial<StatsAnalyticsCalculatorInput> = {},
): StatsAnalyticsCalculatorInput => ({
  candidates: [],
  asOf: at,
  periodDays: 7,
  metrics: ['AUDIENCE'],
  horizons: [],
  includeComparison: true,
  includeHistory: true,
  entityKind: 'CHANNEL',
  health: {},
  ...overrides,
});
function audience(
  day: string,
  value: number,
  producer: StatsCandidate['producer'] = 'MAXIM',
): StatsCandidate {
  return {
    producer,
    scope: { metric: 'AUDIENCE', horizon: 0, method: { id: 'AUDIENCE_SNAPSHOT', version: 1 }, day },
    value: { value, observedAt: `${day}T10:00:00Z` },
    coverage: { state: 'COMPLETE', intervals: [], populationComplete: true },
    health,
  };
}
function reach(
  day: string,
  views: string,
  samples: number,
  horizon: StatsHorizon = 24,
): StatsCandidate {
  const start = Date.parse(`${day}T00:00:00Z`);
  const scope: StatsCandidate['scope'] =
    horizon === 0
      ? { metric: 'REACH', horizon: 0, method: { id: 'POST_PUBLICATION_DAY', version: 1 }, day }
      : { metric: 'REACH', horizon, method: { id: 'TIMED_POST_PUBLICATION_DAY', version: 1 }, day };
  return {
    producer: 'MAXIM',
    scope,
    value: {
      views,
      samples,
      posts: samples,
      observedFrom: iso(start + horizon * 3_600_000),
      observedTo: iso(start + horizon * 3_600_000 + 60_000),
      maxDelaySeconds: horizon ? 60 : null,
    },
    coverage: {
      state: 'COMPLETE',
      intervals: [{ from: iso(start), to: iso(start + dayMs) }],
      populationComplete: true,
    },
    health,
  };
}
function publication(day: string, hour: number, count: number, complete = false): StatsCandidate {
  const start = Date.parse(`${day}T00:00:00Z`),
    hours: Array<number | null> = Array.from({ length: 24 }, () => (complete ? 0 : null));
  hours[hour] = count;
  return {
    producer: 'MAXIM',
    scope: {
      metric: 'PUBLICATION_HOUR',
      horizon: 0,
      method: { id: 'PUBLICATION_DAY_HOURS', version: 1 },
      day,
    },
    value: { hours, observedFrom: null, observedTo: null },
    coverage: {
      state: complete ? 'COMPLETE' : 'PARTIAL',
      intervals: complete ? [{ from: iso(start), to: iso(start + dayMs) }] : [],
      populationComplete: complete,
    },
    health,
  };
}
function timedWindows(
  currentViews = '8',
  previousViews = '7',
  currentSamples = 5,
  previousSamples = 5,
): StatsCandidate[] {
  const plan = planAnalyticsWindows(at, 7, ['REACH'], [24], true).windows[0]!.comparison!;
  const rows: StatsCandidate[] = [];
  for (const [w, views, samples] of [
    [plan.current, currentViews, currentSamples],
    [plan.previous, previousViews, previousSamples],
  ] as const) {
    for (let n = 0; n < 7; n++)
      rows.push(
        reach(
          iso(Date.parse(w.from!) + n * dayMs).slice(0, 10),
          n === 0 ? views : '0',
          n === 0 ? samples : 0,
        ),
      );
  }
  return rows;
}
function validated(result: ReturnType<typeof calculateStatsAnalytics>) {
  for (const m of result.metrics)
    expect(statsAnalyticsMetricSchema.safeParse(m)).toEqual(
      expect.objectContaining({ success: true }),
    );
  for (const r of result.rows)
    expect(statsAnalyticsHistoryRowSchema.safeParse(r)).toEqual(
      expect.objectContaining({ success: true }),
    );
  return result;
}
describe('canonical statistics analytics', () => {
  it('normalizes mixed metric selections without dropping non-reach horizon zero', () => {
    const plan = planAnalyticsWindows(at, 7, ['REACH', 'AUDIENCE'], [48], true);
    expect(plan.selections).toEqual([
      { metric: 'AUDIENCE', horizon: 0 },
      { metric: 'REACH', horizon: 48 },
    ]);
  });
  it('pins mature windows at the 15-minute equality and clips 90-day reads', () => {
    expect(
      planAnalyticsWindows('2026-10-30T00:14:59.999Z', 7, ['REACH'], [24], true).windows[0]!
        .comparison!.current.to,
    ).toBe('2026-10-28T00:00:00.000Z');
    expect(
      planAnalyticsWindows('2026-10-30T00:15:00Z', 7, ['REACH'], [24], true).windows[0]!.comparison!
        .current.to,
    ).toBe('2026-10-29T00:00:00.000Z');
    const plan = planAnalyticsWindows('2026-10-30T00:10:00Z', 90, ['PUBLICATION_HOUR'], [], true);
    expect(plan.windows[0]!.comparison).toBeNull();
    expect(
      Date.parse(plan.windows[0]!.current.availableFrom!) -
        Date.parse(plan.windows[0]!.current.from!),
    ).toBe(3 * 3_600_000);
    expect(plan.fromDay).toBe(plan.retentionFloor);
  });
  it('uses real audience observations for period growth but rejects a daily change across a gap', () => {
    const result = validated(
      calculateStatsAnalytics(
        input({
          periodDays: 30,
          candidates: [audience('2026-10-01', 100), audience('2026-10-30', 120, 'EXCHANGE')],
        }),
      ),
    );
    expect(result.metrics[0]).toMatchObject({
      growth: {
        state: 'AVAILABLE',
        value: { delta: 20, observationCount: 2, completePeriod: false, sourceTransition: true },
        percent: { value: '20.00' },
      },
    });
    expect(result.rows.at(-1)).toMatchObject({
      changeFromPrevious: {
        value: null,
        reason: 'GAP_IN_OBSERVATIONS',
        interval: { fromDay: '2026-10-01', toDay: '2026-10-30' },
      },
    });
  });
  it('preserves the prior point across a history page boundary', () => {
    const rows = calculateStatsAnalyticsHistory({
      ...input({ candidates: [audience('2026-10-29', 100), audience('2026-10-30', 103)] }),
      slots: [{ day: '2026-10-30', selection: { metric: 'AUDIENCE', horizon: 0 } }],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ changeFromPrevious: { value: 3, reason: null } });
  });
  it('selects one producer before summing and uses unrounded means for percent and delta', () => {
    const rows = timedWindows('8', '7');
    rows.push({
      ...rows[0]!,
      producer: 'EXCHANGE',
      value: { ...(rows[0]!.value as object), views: '100' } as StatsCandidate['value'],
    });
    const result = validated(
      calculateStatsAnalytics(input({ metrics: ['REACH'], horizons: [24], candidates: rows })),
    );
    expect(result.metrics[0]!.comparison).toMatchObject({
      state: 'AVAILABLE',
      changes: [{ field: 'AVERAGE_VIEWS', absolute: '0', percent: { value: '14.29' } }],
    });
  });
  it('rounds signed rational differences away from zero only once', () => {
    const result = validated(
      calculateStatsAnalytics(
        input({ metrics: ['REACH'], horizons: [24], candidates: timedWindows('5', '15', 10, 10) }),
      ),
    );
    expect(result.metrics[0]!.comparison).toMatchObject({
      state: 'AVAILABLE',
      changes: [{ absolute: '-1', percent: { value: '-66.67' } }],
    });
  });
  it('retains exact large totals and rejects fewer than five samples', () => {
    const large = '9007199254740993',
      samples = 5_000_000;
    const result = validated(
      calculateStatsAnalytics(
        input({
          metrics: ['REACH'],
          horizons: [24],
          candidates: timedWindows(large, large, samples, samples),
        }),
      ),
    );
    expect(result.metrics[0]!.comparison).toMatchObject({
      state: 'AVAILABLE',
      current: { value: { views: large, averageViews: '1801439851' } },
    });
    expect(
      calculateStatsAnalytics(
        input({ metrics: ['REACH'], horizons: [24], candidates: timedWindows('8', '7', 4, 5) }),
      ).metrics[0]!.comparison,
    ).toMatchObject({ state: 'UNAVAILABLE', reason: 'INSUFFICIENT_SAMPLES' });
  });
  it('keeps absolute zero-baseline changes and refuses partial comparisons', () => {
    const rows = timedWindows('8', '0');
    expect(
      validated(
        calculateStatsAnalytics(input({ metrics: ['REACH'], horizons: [24], candidates: rows })),
      ).metrics[0]!.comparison,
    ).toMatchObject({
      state: 'AVAILABLE',
      changes: [{ absolute: '2', percent: { state: 'UNAVAILABLE', reason: 'ZERO_BASELINE' } }],
    });
    rows[0]!.coverage = { state: 'PARTIAL', intervals: [], populationComplete: false };
    expect(
      calculateStatsAnalytics(input({ metrics: ['REACH'], horizons: [24], candidates: rows }))
        .metrics[0]!.comparison,
    ).toMatchObject({ state: 'UNAVAILABLE', reason: 'INCOMPLETE_COVERAGE' });
  });
  it('preserves today partial five plus yesterday complete two without widening coverage', () => {
    const result = validated(
      calculateStatsAnalytics(
        input({
          metrics: ['PUBLICATION_HOUR'],
          candidates: [
            publication('2026-10-28', 0, 0, true),
            publication('2026-10-29', 10, 2, true),
            publication('2026-10-30', 10, 5),
          ],
        }),
      ),
    );
    expect(result.metrics[0]!.current).toMatchObject({
      state: 'AVAILABLE',
      value: {
        count: 7,
        observedTo: '2026-10-30T11:00:00.000Z',
        frequency: {
          postsOnCompleteDates: 2,
          completeDates: 1,
          averagePostsPerCompleteDate: '2.0',
        },
      },
    });
    expect(result.rows.at(-1)).toMatchObject({
      state: 'VALUE',
      value: { count: 5 },
      coverage: { state: 'PARTIAL' },
    });
    expect(result.publicationBreakdown?.activeDays).toBeNull();
    expect(result.publicationBreakdown?.peakHour).toBeNull();
  });
  it('unions neighboring proof intervals and leaves a 1ms gap incomplete', () => {
    const a = publication('2026-10-28', 22, 0),
      b = publication('2026-10-29', 10, 2);
    a.coverage = {
      state: 'PARTIAL',
      intervals: [{ from: '2026-10-28T21:00:00Z', to: '2026-10-29T00:00:00Z' }],
      populationComplete: true,
    };
    b.coverage = {
      state: 'PARTIAL',
      intervals: [{ from: '2026-10-29T00:00:00Z', to: '2026-10-29T21:00:00Z' }],
      populationComplete: true,
    };
    const args = input({ metrics: ['PUBLICATION_HOUR'], candidates: [a, b] });
    expect(calculateStatsAnalytics(args).rows.find((r) => r.day === '2026-10-29')).toMatchObject({
      coverage: { state: 'COMPLETE', populationComplete: true },
    });
    b.coverage.intervals[0]!.from = '2026-10-29T00:00:00.001Z';
    expect(calculateStatsAnalytics(args).rows.find((r) => r.day === '2026-10-29')).toMatchObject({
      coverage: { state: 'PARTIAL', populationComplete: false },
    });
  });
  it('preserves a microsecond coverage gap instead of inventing a complete zero hour', () => {
    const a = publication('2026-10-28', 22, 0),
      b = publication('2026-10-29', 10, 0);
    for (const row of [a, b]) if ('hours' in row.value) row.value.hours.fill(null);
    a.coverage = {
      state: 'PARTIAL',
      populationComplete: true,
      intervals: [{ from: '2026-10-28T21:00:00Z', to: '2026-10-29T00:00:00Z' }],
    };
    b.coverage = {
      state: 'PARTIAL',
      populationComplete: true,
      intervals: [{ from: '2026-10-29T00:00:00.000001Z', to: '2026-10-29T21:00:00Z' }],
    };
    const row = calculateStatsAnalytics(
      input({ metrics: ['PUBLICATION_HOUR'], candidates: [a, b] }),
    ).rows.find((entry) => entry.day === '2026-10-29');
    expect(row).toMatchObject({
      state: 'VALUE',
      coverage: { state: 'PARTIAL', populationComplete: false },
    });
    if (!row || row.state !== 'VALUE' || row.metric !== 'PUBLICATION_HOUR')
      throw new Error('Expected publication row');
    expect(row.value.hours[3]).toBeNull();
    expect(row.coverage.intervals).toHaveLength(2);
    expect(row.coverage.intervals[1]!.from).toBe('2026-10-29T00:00:00.000001Z');
  });
  it('does not invent external observation freshness, growth, public rows or chat counters', () => {
    const external: StatsCandidate = {
      ...audience('2026-10-30', 100),
      scope: {
        metric: 'AUDIENCE',
        horizon: 0,
        method: { id: 'MAXFRAME_EXTERNAL_CALENDAR', version: 1 },
        day: '2026-10-30',
      },
      value: {
        value: 100,
        observedAt: null,
        fetchedAt: at,
        calendarZone: 'UNSPECIFIED',
        lineage: 'MAXFRAME_EXTERNAL',
      },
    };
    const result = validated(
      calculateStatsAnalytics(input({ candidates: [external], purpose: 'PUBLISHED_AGGREGATE' })),
    );
    expect(result.rows).toEqual([]);
    expect(result.metrics[0]!.current).toMatchObject({
      state: 'AVAILABLE',
      window: { calendarZone: 'UNSPECIFIED', from: null, observedUntil: null },
      quality: { freshness: { state: 'UNKNOWN' } },
    });
    expect(result.metrics[0]).toMatchObject({
      growth: { state: 'UNAVAILABLE', reason: 'INCOMPATIBLE_METHOD' },
    });
    expect(
      validated(
        calculateStatsAnalytics(
          input({
            entityKind: 'CHAT',
            metrics: ['MEMBERSHIP', 'PUBLICATION_HOUR', 'REACH'],
            horizons: [0],
          }),
        ),
      ).metrics.every((m) => m.capability === 'UNSUPPORTED'),
    ).toBe(true);
  });
  it('keeps observation age independent from last-attempt error and excludes future observations', () => {
    const point = audience('2026-10-25', 100);
    const failure: StatsHealth = { ...health, state: 'ERROR', errorCode: 'SOURCE_UNAVAILABLE' };
    const result = validated(
      calculateStatsAnalytics(
        input({
          candidates: [point, audience('2026-10-31', 200)],
          health: { 'AUDIENCE:0:AUDIENCE_SNAPSHOT:1': failure },
        }),
      ),
    );
    expect(result.metrics[0]!.current).toMatchObject({
      state: 'AVAILABLE',
      value: { value: 100 },
      quality: { freshness: { state: 'STALE' }, health: { state: 'ERROR' } },
    });
  });
  it('weights unequal daily samples and never substitutes the recent twenty-post cohort', () => {
    const rows = [reach('2026-10-27', '10', 1), reach('2026-10-28', '180', 9)];
    const result = validated(
      calculateStatsAnalytics(
        input({ metrics: ['REACH'], horizons: [24], candidates: rows, includeComparison: false }),
      ),
    );
    expect(result.metrics[0]!.current).toMatchObject({
      value: { views: '190', samples: 10, averageViews: '19' },
    });
    const recent: StatsCandidate = {
      ...reach('2026-10-29', '900', 5, 0),
      scope: {
        day: '2026-10-29',
        metric: 'REACH',
        horizon: 0,
        method: { id: 'RECENT_POST_SAMPLE_20', version: 1 },
      },
      value: {
        ...(reach('2026-10-29', '900', 5, 0)
          .value as import('@maxim/contracts/statistics-central').StatsReachValue),
        publicationFrom: '2026-10-01T00:00:00Z',
        publicationTo: '2026-10-29T00:00:00Z',
      },
    };
    const current = validated(
      calculateStatsAnalytics(
        input({
          metrics: ['REACH'],
          horizons: [0],
          candidates: [reach('2026-10-29', '10', 5, 0), recent],
        }),
      ),
    );
    expect(current.metrics[0]!.current).toMatchObject({
      value: { views: '10', averageViews: '2' },
    });
    expect(current.metrics[0]!.comparison).toMatchObject({ reason: 'VARIABLE_POST_AGE' });
  });
  it('keeps future publication hours unknown and the Moscow retention edge incomplete', () => {
    const row = publication('2026-10-30', 11, 5);
    (row.value as import('@maxim/contracts/statistics-central').StatsPublicationValue).hours[12] =
      99;
    const result = validated(
      calculateStatsAnalytics(
        input({ metrics: ['PUBLICATION_HOUR'], candidates: [row], periodDays: 90 }),
      ),
    );
    expect(result.metrics[0]!.current).toMatchObject({ value: { count: 5 } });
    expect(result.rows.at(-1)).toMatchObject({ state: 'VALUE', value: { count: 5 } });
    const last = result.rows.at(-1)!;
    expect(last.state === 'VALUE' && 'hours' in last.value && last.value.hours[15]).toBeNull();
    expect(result.rows[0]!.window.availableFrom).toBe('2026-08-02T00:00:00.000Z');
    expect(result.rows[0]!.window.from).toBe('2026-08-01T21:00:00.000Z');
  });
  it('rejects post-cutoff submillisecond points and marks a round-trip producer transition', () => {
    const future = audience('2026-10-30', 999);
    future.value = { value: 999, observedAt: '2026-10-30T12:00:00.000001Z' };
    const result = validated(
      calculateStatsAnalytics(
        input({
          candidates: [
            audience('2026-10-27', 100),
            audience('2026-10-28', 110, 'EXCHANGE'),
            audience('2026-10-29', 120),
            future,
          ],
        }),
      ),
    );
    expect(result.metrics[0]!.current).toMatchObject({
      value: { value: 120 },
      quality: { comparability: { sourceTransition: true } },
    });
    expect(result.metrics[0]).toMatchObject({
      growth: { value: { sourceTransition: true, observationCount: 3 } },
    });
  });
  it('keeps missing native values unavailable without inventing complete dates', () => {
    const point = audience('2026-10-29', 100);
    point.value = { value: null, observedAt: null };
    expect(
      validated(calculateStatsAnalytics(input({ candidates: [point] }))).metrics[0]!.current,
    ).toMatchObject({
      state: 'UNAVAILABLE',
      quality: {
        coverage: { state: 'UNKNOWN', knownDays: 0, completeDays: 0, populationComplete: false },
      },
    });
  });
});
