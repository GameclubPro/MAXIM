import { AdminChannelStatsRuntime } from './admin-channel-stats-runtime';

describe('AdminChannelStatsRuntime', () => {
  it('aligns daily bucket starts to Moscow calendar days', () => {
    const runtime = new AdminChannelStatsRuntime({} as never);

    const starts = runtime.buildChannelStatsBucketStarts(
      new Date('2026-03-06T22:30:00.000Z'),
      new Date('2026-03-08T08:00:00.000Z'),
      'day',
    );

    expect(starts.map((date) => date.toISOString())).toEqual([
      '2026-03-06T21:00:00.000Z',
      '2026-03-07T21:00:00.000Z',
    ]);
  });

  it('shares response cache keys across authorized users for the same channel query', () => {
    const runtime = new AdminChannelStatsRuntime({} as never);
    const noActivityKey = runtime.buildChannelStatsResponseCacheKey('channel-1', 'admin-a', {
      range: '7d',
      includeActivityPreview: false,
    });

    expect(noActivityKey.startsWith('channel-1:')).toBe(true);
    expect(noActivityKey).toBe(
      runtime.buildChannelStatsResponseCacheKey('channel-1', 'admin-b', {
        range: '7d',
        includeActivityPreview: false,
      }),
    );
    expect(noActivityKey).not.toBe(
      runtime.buildChannelStatsResponseCacheKey('channel-1', 'admin-b', {
        range: '7d',
        includeActivityPreview: true,
      }),
    );
  });

  it('calculates fixed T+24h and T+48h averages with ERR48 from subscribers', () => {
    const runtime = new AdminChannelStatsRuntime({} as never);
    const now = new Date('2026-06-30T12:00:00.000Z');
    const posts = [
      buildFixedWindowPost('post-1', '2026-06-26T08:00:00.000Z', 100, 150),
      buildFixedWindowPost('post-2', '2026-06-25T08:00:00.000Z', 200, 200),
      buildFixedWindowPost('post-3', '2026-06-24T08:00:00.000Z', 300, 250),
    ];

    const result = runtime.buildChannelStatsReachSummary({
      posts24h: posts,
      posts48h: posts,
      subscriberDenominator: 1000,
      now,
    });

    expect(result).toEqual({
      averageViews24h: 200,
      averageViews48h: 200,
      err48Percent: 20,
      subscriberDenominator: 1000,
      sampleSize24h: 3,
      sampleSize48h: 3,
      coverage24h: 'ready',
      coverage48h: 'ready',
      asOf: '2026-06-28T08:00:00.000Z',
      method: 'post-age-cohort',
    });
  });

  it('accepts milestone snapshots at the inclusive tolerance boundaries', () => {
    const runtime = new AdminChannelStatsRuntime({} as never);
    const publishedAt = new Date('2026-06-20T08:00:00.000Z');
    const at24h = new Date(publishedAt.getTime() + 24 * 60 * 60 * 1000);
    const at27h = new Date(publishedAt.getTime() + 27 * 60 * 60 * 1000);
    const posts = [
      {
        ...buildFixedWindowPost('post-1', publishedAt.toISOString(), 0, null),
        viewsAt24hCapturedAt: at24h,
      },
      {
        ...buildFixedWindowPost('post-2', publishedAt.toISOString(), 10, null),
        viewsAt24hCapturedAt: at27h,
      },
      {
        ...buildFixedWindowPost('post-3', publishedAt.toISOString(), 20, null),
        viewsAt24hCapturedAt: new Date(at27h.getTime() + 1),
      },
    ];

    const result = runtime.buildChannelStatsReachSummary({
      posts24h: posts,
      posts48h: [],
      subscriberDenominator: 1000,
      now: new Date('2026-06-30T12:00:00.000Z'),
    });

    expect(result.sampleSize24h).toBe(2);
    expect(result.coverage24h).toBe('insufficient');
    expect(result.averageViews24h).toBeNull();
  });

  it('excludes posts that have not reached the requested age and requires three samples', () => {
    const runtime = new AdminChannelStatsRuntime({} as never);
    const now = new Date('2026-06-30T12:00:00.000Z');
    const posts = [
      buildFixedWindowPost('old-1', '2026-06-27T08:00:00.000Z', 100, 200),
      buildFixedWindowPost('old-2', '2026-06-26T08:00:00.000Z', 300, 400),
      buildFixedWindowPost('one-hour-old', '2026-06-30T11:00:00.000Z', 900, 900),
    ];

    const result = runtime.buildChannelStatsReachSummary({
      posts24h: posts,
      posts48h: posts,
      subscriberDenominator: 1000,
      now,
    });

    expect(result).toMatchObject({
      averageViews24h: null,
      averageViews48h: null,
      err48Percent: null,
      sampleSize24h: 2,
      sampleSize48h: 2,
      coverage24h: 'insufficient',
      coverage48h: 'insufficient',
    });
  });

  it.each([
    ['missing', null],
    ['zero', 0],
  ] as const)(
    'does not calculate ERR48 with a %s subscriber denominator',
    (_label, denominator) => {
      const runtime = new AdminChannelStatsRuntime({} as never);
      const posts = [
        buildFixedWindowPost('post-1', '2026-06-26T08:00:00.000Z', null, 200),
        buildFixedWindowPost('post-2', '2026-06-25T08:00:00.000Z', null, 200),
        buildFixedWindowPost('post-3', '2026-06-24T08:00:00.000Z', null, 200),
      ];

      const result = runtime.buildChannelStatsReachSummary({
        posts24h: [],
        posts48h: posts,
        subscriberDenominator: denominator,
        now: new Date('2026-06-30T12:00:00.000Z'),
      });

      expect(result.averageViews48h).toBe(200);
      expect(result.subscriberDenominator).toBeNull();
      expect(result.err48Percent).toBeNull();
    },
  );

  it('allows ERR48 above 100 percent without reaction data', () => {
    const runtime = new AdminChannelStatsRuntime({} as never);
    const posts = [
      buildFixedWindowPost('post-1', '2026-06-26T08:00:00.000Z', null, 1400),
      buildFixedWindowPost('post-2', '2026-06-25T08:00:00.000Z', null, 1500),
      buildFixedWindowPost('post-3', '2026-06-24T08:00:00.000Z', null, 1600),
    ];

    const result = runtime.buildChannelStatsReachSummary({
      posts24h: [],
      posts48h: posts,
      subscriberDenominator: 1000,
      now: new Date('2026-06-30T12:00:00.000Z'),
    });

    expect(result.averageViews48h).toBe(1500);
    expect(result.err48Percent).toBe(150);
  });

  it('does not reuse a stale audience snapshot as the ERR48 denominator', () => {
    const runtime = new AdminChannelStatsRuntime({} as never);
    const now = new Date('2026-06-30T12:00:00.000Z');
    const posts = [
      buildFixedWindowPost('post-1', '2026-06-26T08:00:00.000Z', null, 200),
      buildFixedWindowPost('post-2', '2026-06-25T08:00:00.000Z', null, 200),
      buildFixedWindowPost('post-3', '2026-06-24T08:00:00.000Z', null, 200),
    ];

    const summary = runtime.buildChannelStatsSummary({
      participantsCount: null,
      audienceSnapshots: [
        {
          capturedAt: new Date('2026-06-29T08:00:00.000Z'),
          participantsCount: 1000,
        },
      ],
      summaryWindowRows: [],
      fixedWindowPosts24h: [],
      fixedWindowPosts48h: posts,
      viewWindows: {
        last24h: null,
        last48h: null,
        totalLast24h: 0,
        totalLast48h: 0,
        reactions24h: 0,
      },
      now,
      useAudienceSnapshotFallbackForCurrent: false,
    });

    expect(summary.subscribers.current).toBeNull();
    expect(summary.reach.averageViews48h).toBe(200);
    expect(summary.reach.subscriberDenominator).toBeNull();
    expect(summary.reach.err48Percent).toBeNull();
  });
});

function buildFixedWindowPost(
  id: string,
  publishedAtIso: string,
  viewsAt24h: number | null,
  viewsAt48h: number | null,
) {
  const publishedAt = new Date(publishedAtIso);

  return {
    id,
    publishedAt,
    viewsAt24h,
    viewsAt24hCapturedAt:
      viewsAt24h === null ? null : new Date(publishedAt.getTime() + 24 * 60 * 60 * 1000),
    viewsAt48h,
    viewsAt48hCapturedAt:
      viewsAt48h === null ? null : new Date(publishedAt.getTime() + 48 * 60 * 60 * 1000),
  };
}
