import type { StatsAudienceValue, StatsReachValue } from '@maxim/contracts/statistics-central';
import { allKeys } from './stats-common';
import { historyRow, selectStats, summarizeStats } from './stats-selector';
import type { StatsCandidate } from './stats-types';
const health = {
  state: 'UNKNOWN' as const,
  lastAttemptAt: null,
  lastSuccessAt: null,
  nextExpectedAt: null,
  errorCode: null,
};
const fact = (
  producer: 'MAXIM' | 'EXCHANGE',
  day: string,
  views: string,
  samples: number,
  complete: boolean,
): StatsCandidate => ({
  producer,
  scope: { metric: 'REACH', horizon: 0, method: { id: 'POST_PUBLICATION_DAY', version: 1 }, day },
  value: {
    views,
    samples,
    posts: samples,
    observedFrom: '2026-10-24T12:00:00Z',
    observedTo: '2026-10-24T12:01:00Z',
    maxDelaySeconds: null,
  },
  coverage: {
    state: complete ? 'COMPLETE' : 'PARTIAL',
    intervals: [],
    populationComplete: complete,
  },
  health,
});
describe('central source selection invariants', () => {
  it('keeps full day over a partial hour in either producer direction and never stitches partial sums', () => {
    const full = fact('MAXIM', '2026-10-23', '100', 10, true),
      hour = fact('EXCHANGE', '2026-10-23', '20', 2, false);
    expect(selectStats([full, hour])[0]!.value).toEqual(full.value);
    expect(
      selectStats([
        { ...full, producer: 'EXCHANGE' },
        { ...hour, producer: 'MAXIM' },
      ])[0]!.producer,
    ).toBe('EXCHANGE');
    const selected = selectStats([{ ...full, coverage: hour.coverage }, hour]);
    expect(selected).toHaveLength(1);
    expect((selected[0]!.value as StatsReachValue).views).toBe('100');
  });
  it('sums exact weighted numerators beyond int64 across 90 valid daily facts', () => {
    const rows = Array.from({ length: 90 }, (_, i) =>
      fact(
        'EXCHANGE',
        new Date(Date.UTC(2026, 6, 1 + i)).toISOString().slice(0, 10),
        '4611686014132420609',
        2147483647,
        true,
      ),
    );
    const result = summarizeStats(rows, 90, 'CHANNEL', ['REACH'], [0]);
    expect(result.reach.current.state).toBe('AVAILABLE');
    if (result.reach.current.state === 'AVAILABLE') {
      expect(result.reach.current.value.views).toBe((4611686014132420609n * 90n).toString());
      expect(result.reach.current.value.samples).toBe(2147483647 * 90);
    }
  });
  it('chooses actual freshest audience including microseconds and MAXIM only on an actual tie', () => {
    const audience = (
      producer: 'MAXIM' | 'EXCHANGE',
      observedAt: string,
      value: number,
    ): StatsCandidate => ({
      ...fact(producer, '2026-10-24', '0', 0, true),
      scope: {
        metric: 'AUDIENCE',
        horizon: 0,
        method: { id: 'AUDIENCE_SNAPSHOT', version: 1 },
        day: '2026-10-24',
      },
      value: { value, observedAt },
    });
    const old = audience('MAXIM', '2026-10-24T12:00:00Z', 1),
      fresh = audience('EXCHANGE', '2026-10-24T12:00:00.000001Z', 2);
    expect((selectStats([old, fresh])[0]!.value as StatsAudienceValue).value).toBe(2);
    expect(selectStats([old, { ...fresh, value: old.value }])[0]!.producer).toBe('MAXIM');
  });
  it('returns one audience per day with external fallback, preserving incompatible calendar', () => {
    const external: StatsCandidate = {
      ...fact('EXCHANGE', '2026-10-24', '0', 0, false),
      scope: {
        metric: 'AUDIENCE',
        horizon: 0,
        method: { id: 'MAXFRAME_EXTERNAL_CALENDAR', version: 1 },
        day: '2026-10-24',
      },
      value: {
        value: 90,
        observedAt: null,
        fetchedAt: '2026-10-24T12:00:00Z',
        calendarZone: 'UNSPECIFIED',
        lineage: 'MAXFRAME_EXTERNAL',
      },
    };
    const native: StatsCandidate = {
      ...external,
      producer: 'MAXIM',
      scope: {
        metric: 'AUDIENCE',
        horizon: 0,
        method: { id: 'AUDIENCE_SNAPSHOT', version: 1 },
        day: '2026-10-24',
      },
      value: { value: 80, observedAt: '2026-10-24T11:00:00Z' },
    };
    expect(selectStats([external, native])).toHaveLength(1);
    expect(selectStats([external, native])[0]!.scope.method.id).toBe('AUDIENCE_SNAPSHOT');
    const row = selectStats([
      external,
      { ...native, value: { value: null, observedAt: null } },
    ])[0]!;
    expect(row.scope.method.id).toBe('MAXFRAME_EXTERNAL_CALENDAR');
    const history = historyRow(row.scope, row);
    expect(history.state === 'VALUE' && history.comparability.calendarZone).toBe('UNSPECIFIED');
  });
  it('keeps missing periods unknown, zero measured, and membership separate from audience growth', () => {
    const scope = { ...allKeys[0]!, day: '2026-10-24' } as StatsCandidate['scope'];
    expect(historyRow(scope, undefined).state).toBe('UNKNOWN');
    const zero = fact('EXCHANGE', '2026-10-24', '0', 0, true);
    const summary = summarizeStats([zero], 7, 'CHANNEL', ['REACH', 'MEMBERSHIP'], [0]);
    expect(summary.reach.current.state === 'AVAILABLE' && summary.reach.current.value.views).toBe(
      '0',
    );
    expect(summary.membership.state).toBe('UNAVAILABLE');
  });
  it('isolates unsupported native numerators to one metric and lets a valid independent source replace them', () => {
    const invalid = {
      ...fact('MAXIM', '2026-10-23', '0', 0, false),
      unavailableReason: 'NUMERIC_LIMIT' as const,
    };
    const unknown = historyRow(invalid.scope, invalid);
    expect(unknown).toMatchObject({ state: 'UNKNOWN', reason: 'NUMERIC_LIMIT' });
    const before = summarizeStats(
      [invalid, fact('EXCHANGE', '2026-10-24', '10', 1, true)],
      7,
      'CHANNEL',
      ['REACH', 'MEMBERSHIP'],
      [0],
    );
    expect(before.reach.current).toMatchObject({ state: 'UNAVAILABLE', reason: 'NUMERIC_LIMIT' });
    expect(before.membership).toMatchObject({ state: 'UNAVAILABLE', reason: 'NO_DATA' });
    const selected = selectStats([invalid, fact('EXCHANGE', '2026-10-23', '20', 2, false)]);
    expect(selected[0]!.producer).toBe('EXCHANGE');
    expect(summarizeStats(selected, 7, 'CHANNEL', ['REACH'], [0]).reach.current.state).toBe(
      'AVAILABLE',
    );
  });
});
