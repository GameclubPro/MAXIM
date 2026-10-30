import {
  analyticsBenchmarkDistribution,
  summarizeAnalyticsBenchmarkPlan,
  runStatisticsAnalyticsBenchmark,
} from './benchmark-statistics-analytics';

describe('bounded canonical analytics benchmark guards', () => {
  it('refuses a shortened profile, invalid samples and weakened latency results', () => {
    expect(() => analyticsBenchmarkDistribution(Array(99).fill(1))).toThrow('Incomplete');
    expect(() => analyticsBenchmarkDistribution(Array(100).fill(Number.NaN))).toThrow('Invalid');
    expect(() => analyticsBenchmarkDistribution(Array(100).fill(2001))).toThrow('p95');
    expect(() => analyticsBenchmarkDistribution([...Array(98).fill(1), 5001, 5001])).toThrow('p99');
    expect(analyticsBenchmarkDistribution(Array(100).fill(1))).toMatchObject({
      count: 100,
      p95Ms: 1,
      p99Ms: 1,
    });
  });
  it('rejects plans that process another entity history', () => {
    expect(() =>
      summarizeAnalyticsBenchmarkPlan({
        'Node Type': 'Seq Scan',
        'Relation Name': 'stats_measurements',
        'Actual Rows': 90,
        'Actual Loops': 1,
        'Rows Removed by Filter': 8910,
      }),
    ).toThrow('unrelated history');
  });
});
const databaseUrl =
  process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL || process.env.MAXIM_TEST_POSTGRES_URL;
(databaseUrl ? test : test.skip)(
  'fixed 90-day native analytics benchmark',
  async () => {
    const result = await runStatisticsAnalyticsBenchmark(databaseUrl!, (value) =>
      console.log(JSON.stringify(value)),
    );
    expect(result.summary.count).toBe(100);
    expect(result.histories).toBe(20);
    expect(result.fixture).toEqual({ entities: 1000, measurements: 9000, posts: 21600 });
  },
  13 * 60_000,
);
