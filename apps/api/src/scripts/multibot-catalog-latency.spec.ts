import { evaluateCatalogLatency, parseCatalogLatencyTargets } from './multibot-catalog-latency';

describe('multibot catalog latency acceptance', () => {
  const targets = { p95Ms: 2000, p99Ms: 10000 };
  it('keeps a correctness-only run separate from explicit speed acceptance', () => {
    expect(parseCatalogLatencyTargets()).toBeNull();
    expect(evaluateCatalogLatency([25000], 1, null)).toMatchObject({
      status: 'not_evaluated',
      p95Ms: 25000,
    });
    expect(evaluateCatalogLatency([25000], 1, targets)).toMatchObject({
      status: 'failed',
      complete: true,
    });
  });
  it('accepts exact limits and fails either percentile beyond its budget', () => {
    const within = [...Array<number>(95).fill(100), ...Array<number>(4).fill(2000), 10000];
    expect(evaluateCatalogLatency(within, 100, targets)).toMatchObject({
      status: 'passed',
      p95Ms: 2000,
      p99Ms: 10000,
    });
    expect(
      evaluateCatalogLatency(
        [...Array<number>(95).fill(100), ...Array<number>(5).fill(2001)],
        100,
        targets,
      ).status,
    ).toBe('failed');
    expect(evaluateCatalogLatency([...within.slice(0, 99), 10001], 100, targets).status).toBe(
      'failed',
    );
  });
  it.each([[], [NaN], [-1], [Infinity], [1, 2]].map((values) => ({ values })))(
    'refuses incomplete or invalid completion clocks $values',
    ({ values }) => {
      expect(evaluateCatalogLatency(values, 1, targets)).toMatchObject({
        status: 'failed',
        complete: false,
        p95Ms: null,
        p99Ms: null,
      });
    },
  );
  it.each([
    '',
    '2000',
    '0,10000',
    '2000,1000',
    '-1,10000',
    '2.5,10000',
    '2000,10000,1',
    '9007199254740992,9007199254740992',
  ])('rejects malformed target %s before starting stores', (value) => {
    expect(() => parseCatalogLatencyTargets(value)).toThrow();
  });
  it('parses explicit targets without changing their scale', () => {
    expect(parseCatalogLatencyTargets('2000,10000')).toEqual(targets);
  });
});
