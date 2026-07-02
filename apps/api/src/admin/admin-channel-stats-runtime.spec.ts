import { AdminChannelStatsRuntime } from './admin-channel-stats-runtime';

describe('AdminChannelStatsRuntime', () => {
  it('shares response cache keys across authorized users for the same channel query', () => {
    const runtime = new AdminChannelStatsRuntime({} as never);
    const noActivityKey = runtime.buildChannelStatsResponseCacheKey('channel-1', 'admin-a', {
      range: '7d',
      includeActivityPreview: false,
    });

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
