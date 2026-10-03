import { AdminChannelStatsRuntime } from './admin-channel-stats-runtime';
import { createAdminChannelStatsRuntimeContext } from './admin-channel-stats-runtime-context';

describe('AdminChannelStatsRuntimeContext', () => {
  it('preserves live dependency identity and method receivers without legacy properties', async () => {
    const target = {
      prefix: 'runtime',
      calls: [] as string[],
      prisma: {} as never,
      maxClient: {} as never,
      logger: {} as never,
      chatContextCache: {} as never,
      channelStatsCollector: {} as never,
      assertReadOnlyChatAdmin: jest.fn(),
      ensureEntityType: jest.fn(),
      getMembershipActivityFeedPage: jest.fn(),
      buildEmptyMembershipActivityPage: jest.fn(),
      resolveAssistBotAssignment(chatId: string, capability: string) {
        return Promise.resolve(`${this.prefix}:${chatId}:${capability}`);
      },
    };
    const context = createAdminChannelStatsRuntimeContext(target);
    new AdminChannelStatsRuntime(context);
    expect(context.prisma).toBe(target.prisma);
    const replacement = {} as never;
    target.prisma = replacement;
    expect(context.prisma).toBe(replacement);
    await expect(context.resolveAssistBotAssignment('channel-1', 'channel_stats')).resolves.toBe(
      'runtime:channel-1:channel_stats',
    );
  });
});
