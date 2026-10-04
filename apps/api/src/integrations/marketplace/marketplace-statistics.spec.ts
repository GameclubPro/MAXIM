import {
  buildMarketplacePostBuckets,
  canonicalMarketplaceRows,
  marketplaceRowsHash,
  parseMarketplacePost,
  validHorizon,
  type MarketplacePostSample,
} from './marketplace-statistics';

describe('marketplace statistics provenance', () => {
  const publishedAt = new Date('2026-09-01T23:30:00Z');
  const post: MarketplacePostSample = {
    messageId: 'test-post',
    publishedAt,
    views: 500,
    observedAt: new Date('2026-09-04T00:00:00Z'),
    views24: 200,
    captured24: new Date('2026-09-02T23:45:00Z'),
    views48: null,
    captured48: null,
  };
  it('accepts measured 24h +15m but rejects older late captures', () => {
    expect(validHorizon(post, 24)?.views).toBe(200);
    expect(validHorizon({ ...post, captured24: new Date('2026-09-02T23:45:01Z') }, 24)).toBeNull();
    expect(validHorizon({ ...post, captured24: new Date('2026-09-02T23:29:59Z') }, 24)).toBeNull();
  });
  it('preserves missing views and actual UTC publication cohort', () => {
    const rows = buildMarketplacePostBuckets([post], new Date('2026-09-04T00:00:00Z'), true);
    expect(rows.find((row) => row.metric === 'REACH' && row.horizon === 48)).toEqual(
      expect.objectContaining({
        bucket: '2026-09-01T00:00:00.000Z',
        posts: 1,
        samples: 0,
        views: 0,
        incomplete: true,
        observedAt: null,
      }),
    );
    expect(rows.find((row) => row.metric === 'REACH' && row.horizon === 24)).toEqual(
      expect.objectContaining({
        posts: 1,
        samples: 1,
        views: 200,
        maxDelaySeconds: 900,
        incomplete: false,
      }),
    );
  });
  it('omits content and distinguishes missing counters from measured zero', () => {
    const input = {
      body: { mid: 'post', text: 'not-exported' },
      timestamp: publishedAt.getTime(),
      stat: {},
    };
    expect(parseMarketplacePost(input)).toEqual({ messageId: 'post', publishedAt, views: null });
    expect(parseMarketplacePost({ ...input, stat: { views: 0 } })?.views).toBe(0);
    expect(parseMarketplacePost({ ...input, stat: { views: -1 } })?.views).toBeNull();
    expect(parseMarketplacePost({ ...input, timestamp: 'invalid' })).toBeNull();
    expect(parseMarketplacePost({ ...input, timestamp: Number.MAX_VALUE })).toBeNull();
  });
  it('hashes a canonical immutable row order', () => {
    const rows = buildMarketplacePostBuckets([post], new Date('2026-09-04T00:00:00Z'), false);
    expect(marketplaceRowsHash(canonicalMarketplaceRows(rows))).toBe(
      marketplaceRowsHash(canonicalMarketplaceRows([...rows].reverse())),
    );
  });
});
