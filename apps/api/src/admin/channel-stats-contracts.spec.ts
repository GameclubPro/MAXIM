import {
  channelStatsQuerySchema as rootChannelStatsQuerySchema,
  channelStatsResponseSchema as rootChannelStatsResponseSchema,
} from '@maxim/contracts';
import {
  channelStatsQuerySchema,
  channelStatsResponseSchema,
  channelStatsSummarySchema,
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

  it('accepts current-day subscriber flow in summary payloads', () => {
    const result = channelStatsSummarySchema.parse({
      subscribers: {
        current: 1240,
        todayDelta: 3,
        todayJoined: 5,
        todayLeft: 2,
        weekDelta: 18,
        sixteenDaysDelta: 41,
      },
      views: {
        perPost: 414,
        last24h: 848,
        last48h: 912,
        er24: 2.8,
      },
      daily: [
        {
          date: '2026-03-07',
          subscribers: 1240,
          delta: 3,
          joined: 5,
          left: 2,
        },
      ],
    });

    expect(result.subscribers).toMatchObject({
      todayDelta: 3,
      todayJoined: 5,
      todayLeft: 2,
    });
    expect(result.daily[0]).toMatchObject({
      delta: 3,
      joined: 5,
      left: 2,
    });
  });
});
