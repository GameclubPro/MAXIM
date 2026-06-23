import { createAdminChannelStatsRuntimeContext } from './admin-channel-stats-runtime-context';

describe('AdminChannelStatsRuntimeContext', () => {
  it('exposes channel stats infrastructure through typed accessors', () => {
    const refreshRuns = new Map();
    const target = {
      prisma: { chat: {} },
      maxClient: { getChatSnapshot: jest.fn() },
      chatContextCache: { getManagedEntityHeader: jest.fn() },
      logger: { warn: jest.fn() },
      channelStatsCollector: { syncChannelIfStale: jest.fn() },
      channelStatsRefreshRuns: refreshRuns,
      resolveChannelStatsFrom: jest.fn(),
      resolveChannelStatsBucket: jest.fn(),
      getMembershipActivityFeedPage: jest.fn(),
      buildEmptyMembershipActivityPage: jest.fn(),
      invalidateChannelStatsResponseCache: jest.fn(),
      resolveAssistBotAssignment: jest.fn(),
      readTrimmedString: jest.fn(),
      toIsoString: jest.fn(),
      toSafeInteger: jest.fn(),
    };
    const context = createAdminChannelStatsRuntimeContext(target);

    expect(context.prisma).toBe(target.prisma);
    expect(context.maxClient).toBe(target.maxClient);
    expect(context.chatContextCache).toBe(target.chatContextCache);
    expect(context.logger).toBe(target.logger);
    expect(context.channelStatsCollector).toBe(target.channelStatsCollector);
    expect(context.channelStatsRefreshRuns).toBe(refreshRuns);
  });

  it('delegates channel stats ports without losing the legacy target context', async () => {
    const target = {
      prefix: 'legacy',
      invalidated: [] as string[],
      prisma: { chat: {} },
      maxClient: { getChatSnapshot: jest.fn() },
      chatContextCache: { getManagedEntityHeader: jest.fn() },
      logger: { warn: jest.fn() },
      channelStatsCollector: { syncChannelIfStale: jest.fn() },
      channelStatsRefreshRuns: new Map(),
      resolveChannelStatsFrom(_range: string, to: Date) {
        return new Date(to.getTime() - this.prefix.length * 1000);
      },
      resolveChannelStatsBucket(range: string) {
        return range === '24h' ? 'hour' : 'day';
      },
      getMembershipActivityFeedPage(
        chatId: string,
        _from: Date,
        _to: Date,
        _query: unknown,
        entityType = 'chat',
      ) {
        return Promise.resolve({
          items: [
            {
              id: `${this.prefix}:${chatId}:${entityType}`,
              type: 'joined',
              userId: 'user-1',
              userDisplayName: 'User',
              avatarUrl: null,
              profileUrl: null,
              profileHandoffUrl: null,
              createdAt: '2026-06-23T00:00:00.000Z',
            },
          ],
          hasMore: false,
          nextCursor: null,
        });
      },
      buildEmptyMembershipActivityPage() {
        return {
          items: [],
          hasMore: false,
          nextCursor: this.prefix,
        };
      },
      invalidateChannelStatsResponseCache(chatId: string) {
        this.invalidated.push(`${this.prefix}:${chatId}`);
      },
      resolveAssistBotAssignment(chatId: string, capability: string) {
        return Promise.resolve(`${this.prefix}:${chatId}:${capability}`);
      },
      readTrimmedString(value: unknown) {
        return typeof value === 'string' && value.trim() ? `${this.prefix}:${value.trim()}` : null;
      },
      toIsoString(value: unknown) {
        return value instanceof Date ? `${this.prefix}:${value.toISOString()}` : null;
      },
      toSafeInteger(value: unknown) {
        return typeof value === 'number' ? Math.trunc(value) + this.prefix.length : 0;
      },
    };
    const context = createAdminChannelStatsRuntimeContext(target);
    const now = new Date('2026-06-23T00:00:00.000Z');

    expect(context.resolveChannelStatsFrom('24h', now)).toEqual(
      new Date('2026-06-22T23:59:54.000Z'),
    );
    expect(context.resolveChannelStatsBucket('24h')).toBe('hour');
    await expect(
      context.getMembershipActivityFeedPage('channel-1', now, now, {
        range: '24h',
        filter: 'all',
        limit: 5,
      }),
    ).resolves.toMatchObject({
      items: [{ id: 'legacy:channel-1:chat' }],
      hasMore: false,
    });
    expect(context.buildEmptyMembershipActivityPage()).toEqual({
      items: [],
      hasMore: false,
      nextCursor: 'legacy',
    });
    context.invalidateChannelStatsResponseCache('channel-1');
    expect(target.invalidated).toEqual(['legacy:channel-1']);
    await expect(context.resolveAssistBotAssignment('channel-1', 'channel_stats')).resolves.toBe(
      'legacy:channel-1:channel_stats',
    );
    expect(context.readTrimmedString(' value ')).toBe('legacy:value');
    expect(context.toIsoString(now)).toBe('legacy:2026-06-23T00:00:00.000Z');
    expect(context.toSafeInteger(10.8)).toBe(16);
  });
});
