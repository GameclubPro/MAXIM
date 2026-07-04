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
});
