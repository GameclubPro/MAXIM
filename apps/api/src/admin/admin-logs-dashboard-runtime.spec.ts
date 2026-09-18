import { AdminLogsDashboardRuntime } from './admin-logs-dashboard-runtime';

describe('event feed cache freshness', () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(new Date('2026-09-18T12:00:00Z')));
  afterEach(() => jest.useRealTimers());

  function fixture() {
    const context = {
      prisma: { $queryRaw: jest.fn().mockResolvedValue([]) },
      moderationFeedPageCache: new Map(),
      membershipActivityFeedPageCache: new Map(),
      assertReadOnlyChatAdmin: jest.fn().mockResolvedValue(undefined),
      ensureEntityType: jest.fn().mockResolvedValue(undefined),
      resolveUserProfiles: jest.fn().mockResolvedValue(new Map()),
      toIsoString: (value: string) => new Date(value).toISOString(),
    };
    const runtime = new AdminLogsDashboardRuntime(context as never);
    const actor = { userId: 'admin', username: null, displayName: null, chatTitle: null };
    return { context, runtime, actor };
  }

  it.each(['getChatModerationFeed', 'getChatActivityFeed', 'getChannelActivityFeed'] as const)(
    '%s revalidates only the head after five seconds and still authorizes cache hits',
    async (method) => {
      const { context, runtime, actor } = fixture();
      const cursor = Buffer.from(
        JSON.stringify({ createdAt: '2026-09-18T11:00:00Z', id: 'older' }),
      ).toString('base64url');
      await runtime[method]('chat', actor, {});
      await runtime[method]('chat', actor, { cursor });
      expect(context.prisma.$queryRaw).toHaveBeenCalledTimes(2);
      jest.advanceTimersByTime(4_999);
      await runtime[method]('chat', actor, {});
      expect(context.prisma.$queryRaw).toHaveBeenCalledTimes(2);
      jest.advanceTimersByTime(1);
      await runtime[method]('chat', actor, {});
      await runtime[method]('chat', actor, { cursor });
      expect(context.prisma.$queryRaw).toHaveBeenCalledTimes(3);
      expect(context.assertReadOnlyChatAdmin).toHaveBeenCalledTimes(5);
      jest.advanceTimersByTime(25_000);
      await runtime[method]('chat', actor, { cursor });
      expect(context.prisma.$queryRaw).toHaveBeenCalledTimes(4);
    },
  );

  it.each(['getChatModerationFeed', 'getChatActivityFeed'] as const)(
    '%s coalesces simultaneous reads and evicts rejected work',
    async (method) => {
      const { context, runtime, actor } = fixture();
      context.prisma.$queryRaw.mockRejectedValueOnce(new Error('transient read failure'));
      const failed = await Promise.allSettled([
        runtime[method]('chat', actor, {}),
        runtime[method]('chat', actor, {}),
      ]);
      expect(failed.map((result) => result.status)).toEqual(['rejected', 'rejected']);
      expect(context.prisma.$queryRaw).toHaveBeenCalledTimes(1);
      await runtime[method]('chat', actor, {});
      expect(context.prisma.$queryRaw).toHaveBeenCalledTimes(2);
      context.assertReadOnlyChatAdmin.mockRejectedValueOnce(new Error('access revoked'));
      await expect(runtime[method]('chat', actor, {})).rejects.toThrow('access revoked');
      expect(context.prisma.$queryRaw).toHaveBeenCalledTimes(2);
    },
  );
});
