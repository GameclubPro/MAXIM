import { ChatEntityType } from '../prisma/prisma-client';
import { createAdminRequiredSubscriptionRuntimeContext } from './admin-required-subscription-runtime-context';

describe('AdminRequiredSubscriptionRuntimeContext', () => {
  it('exposes required subscription infrastructure through typed accessors', () => {
    const target = {
      prisma: { chat: {} },
      maxClient: { getChatSnapshot: jest.fn() },
      chatContextCache: { setManagedEntityHeader: jest.fn() },
      logger: { warn: jest.fn() },
      maxBotExecutionPlanner: { refreshChatBotCapabilitySnapshots: jest.fn() },
      maxBotLinkService: { bindDiscoveredChatBots: jest.fn() },
      maxBotRegistry: { getBotById: jest.fn() },
      createManagedEntityHeader: jest.fn(),
      mergeManagedBotChatCatalogRows: jest.fn(),
      resolveBotAssignment: jest.fn(),
      resolveCandidateBotIdsForChat: jest.fn(),
    };
    const context = createAdminRequiredSubscriptionRuntimeContext(target);

    expect(context.prisma).toBe(target.prisma);
    expect(context.maxClient).toBe(target.maxClient);
    expect(context.chatContextCache).toBe(target.chatContextCache);
    expect(context.logger).toBe(target.logger);
    expect(context.maxBotLinkService).toBe(target.maxBotLinkService);
    expect(context.maxBotRegistry).toBe(target.maxBotRegistry);
  });

  it('delegates required subscription ports without losing the legacy target context', async () => {
    const target = {
      prefix: 'legacy',
      prisma: { chat: {} },
      maxClient: { getChatSnapshot: jest.fn() },
      chatContextCache: { setManagedEntityHeader: jest.fn() },
      logger: { warn: jest.fn() },
      maxBotExecutionPlanner: {
        refreshChatBotCapabilitySnapshots: jest.fn().mockResolvedValue(undefined),
      },
      createManagedEntityHeader(params: { id: string; title: string }) {
        return {
          id: params.id,
          title: `${this.prefix}:${params.title}`,
          entityType: 'channel',
        };
      },
      mergeManagedBotChatCatalogRows(rows: ReadonlyArray<{ chatId: string }>) {
        return rows.map((row) => ({
          chatId: `${this.prefix}:${row.chatId}`,
          title: null,
          lastEventTime: null,
          entityType: 'channel',
          link: null,
          avatarUrl: null,
        }));
      },
      resolveBotAssignment(chatId: string): Promise<string | undefined> {
        return Promise.resolve(`${this.prefix}:${chatId}`);
      },
      resolveCandidateBotIdsForChat(
        chatId: string,
        options?: { includeDiscoveryFallback?: boolean },
      ): Promise<string[]> {
        return Promise.resolve([
          `${this.prefix}:${chatId}:${options?.includeDiscoveryFallback ?? false}`,
        ]);
      },
    };
    const context = createAdminRequiredSubscriptionRuntimeContext(target);

    expect(
      context.createManagedEntityHeader({
        id: 'channel-1',
        title: 'Channel',
        entityType: 'channel',
      }).title,
    ).toBe('legacy:Channel');
    expect(
      context.mergeManagedBotChatCatalogRows([
        {
          botId: 'bot-1',
          chatId: 'channel-1',
          entityType: ChatEntityType.CHANNEL,
          title: null,
          link: null,
          avatarUrl: null,
          lastEventTime: null,
          lastSeenAt: new Date(),
        },
      ]),
    ).toEqual([
      {
        chatId: 'legacy:channel-1',
        title: null,
        lastEventTime: null,
        entityType: 'channel',
        link: null,
        avatarUrl: null,
      },
    ]);
    await expect(context.resolveBotAssignment('channel-1')).resolves.toBe('legacy:channel-1');
    await expect(
      context.resolveCandidateBotIdsForChat('channel-1', { includeDiscoveryFallback: true }),
    ).resolves.toEqual(['legacy:channel-1:true']);
    await context.refreshManagedEntityBotAccessSnapshots('channel-1', 'channel', 'settings');

    expect(target.maxBotExecutionPlanner.refreshChatBotCapabilitySnapshots).toHaveBeenCalledWith({
      chatId: 'channel-1',
      entityType: 'channel',
    });
  });
});
