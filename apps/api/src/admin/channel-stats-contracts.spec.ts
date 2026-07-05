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
      mode: 'overview',
    });

    expect(result).toEqual({
      range: '30d',
      includeActivityPreview: false,
      mode: 'overview',
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
          source: 'flow',
          confidence: 'medium',
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
      source: 'flow',
      confidence: 'medium',
    });
  });

  it('defaults missing daily audience source metadata for cached payloads', () => {
    const result = channelStatsSummarySchema.parse({
      subscribers: {
        current: 1240,
        todayDelta: null,
        weekDelta: null,
        sixteenDaysDelta: null,
      },
      views: {
        perPost: null,
        last24h: null,
        last48h: null,
        er24: null,
      },
      daily: [
        {
          date: '2026-03-07',
          subscribers: null,
          delta: null,
        },
      ],
    });

    expect(result.daily[0]).toMatchObject({
      source: 'unavailable',
      confidence: 'low',
    });
  });

  it('requires post counts on average views series buckets', () => {
    const result = channelStatsResponseSchema.parse({
      channel: {
        id: '-100',
        title: 'Канал',
        participantsCount: 1200,
        status: null,
        isPublic: true,
        link: null,
        lastEventAt: null,
        avatarUrl: null,
      },
      period: {
        range: '24h',
        from: '2026-03-07T00:00:00.000Z',
        to: '2026-03-08T00:00:00.000Z',
        bucket: 'hour',
      },
      official: {
        audience: {
          joined: 0,
          left: 0,
          net: 0,
        },
        content: {
          posts: 1,
          views: 500,
          reactions: 0,
          topReactions: [],
          topPosts: [],
          lastPublishedAt: '2026-03-07T10:00:00.000Z',
        },
        series: {
          participants: [],
          membership: [],
          views: [
            {
              at: '2026-03-07T10:00:00.000Z',
              posts: 1,
              views: 500,
            },
            {
              at: '2026-03-07T11:00:00.000Z',
              posts: 0,
              views: 0,
            },
          ],
        },
      },
      summary: {
        subscribers: {
          current: 1200,
          todayDelta: 0,
          todayJoined: 0,
          todayLeft: 0,
          weekDelta: 0,
          sixteenDaysDelta: 0,
        },
        views: {
          perPost: 500,
          last24h: 500,
          last48h: 500,
          er24: null,
        },
        daily: [],
      },
      secondary: {
        postsWithButtons: 0,
        comments: 0,
        suggestions: 0,
        commentAuthors: 0,
        suggestionAuthors: 0,
        suggestionsDelivered: 0,
        suggestionsFailed: 0,
        lastBotActivityAt: null,
      },
      meta: {
        maxSnapshotAvailable: true,
        viewsAvailable: true,
        churnAvailable: true,
        officialCoverageFrom: null,
        refreshQueued: false,
      },
      comparison: {
        period: {
          from: '2026-03-06T00:00:00.000Z',
          to: '2026-03-07T00:00:00.000Z',
        },
        deltas: {
          audienceNet: { current: 0, previous: 0, absolute: 0, percent: 0 },
          joined: { current: 0, previous: 0, absolute: 0, percent: 0 },
          left: { current: 0, previous: 0, absolute: 0, percent: 0 },
          posts: { current: 1, previous: 0, absolute: 1, percent: null },
          views: { current: 500, previous: 0, absolute: 500, percent: null },
          averageViewsPerPost: { current: 500, previous: 0, absolute: 500, percent: null },
          reactions: { current: 0, previous: 0, absolute: 0, percent: 0 },
        },
        series: {
          participants: [],
          membership: [],
          views: [
            {
              at: '2026-03-06T10:00:00.000Z',
              posts: 0,
              views: 0,
            },
          ],
        },
      },
      signals: {
        markers: [],
        bestWindows: [],
      },
      activityFeed: {
        items: [],
        hasMore: false,
        nextCursor: null,
      },
    });

    expect(result.official.series.views[0]).toMatchObject({
      posts: 1,
      views: 500,
    });
    expect(result.comparison.series?.views[0]).toMatchObject({
      posts: 0,
      views: 0,
    });
  });
});
