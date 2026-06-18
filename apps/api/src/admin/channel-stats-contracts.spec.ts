import {
  channelStatsQuerySchema as rootChannelStatsQuerySchema,
  channelStatsResponseSchema as rootChannelStatsResponseSchema,
} from '@maxim/contracts';
import {
  channelStatsQuerySchema,
  channelStatsResponseSchema,
} from '@maxim/contracts/channel-stats';

describe('channel stats contract exports', () => {
  it('keeps root and subpath exports aligned', () => {
    expect(rootChannelStatsQuerySchema).toBe(channelStatsQuerySchema);
    expect(rootChannelStatsResponseSchema).toBe(channelStatsResponseSchema);
  });

  it('normalizes boolean query flags for stats requests', () => {
    const result = channelStatsQuerySchema.parse({
      range: '30d',
      includeActivityPreview: 'false',
    });

    expect(result).toEqual({
      range: '30d',
      includeActivityPreview: false,
    });
  });
});
