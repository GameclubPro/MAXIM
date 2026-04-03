import { MaxChatAdminRosterSyncService } from './max-chat-admin-roster-sync.service';

describe('MaxChatAdminRosterSyncService', () => {
  function createService() {
    const prisma = {
      chat: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
      chatAdminAllowlist: {
        findMany: jest.fn().mockResolvedValue([]),
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
        upsert: jest.fn(),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      chatBotMembership: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const maxClient = {
      getCurrentChatMemberAccess: jest.fn(),
      getChatAdminIds: jest.fn(),
      listBotChats: jest.fn(),
    };
    const maxBotLinkService = {
      bindDiscoveredChatBots: jest.fn().mockResolvedValue('bot-1'),
    };
    const maxBotRegistry = {
      getBotById: jest.fn((botId?: string | null) => (botId ? { id: botId } : null)),
      getDiscoveryBots: jest.fn().mockReturnValue([{ id: 'bot-1' }, { id: 'bot-2' }]),
    };
    const chatContextCache = {
      replaceChatAdminUsers: jest.fn().mockResolvedValue(undefined),
      setAdminAccess: jest.fn().mockResolvedValue(undefined),
    };

    const service = new MaxChatAdminRosterSyncService(
      prisma as never,
      maxClient as never,
      maxBotLinkService as never,
      maxBotRegistry as never,
      chatContextCache as never,
    );

    return {
      service,
      prisma,
      maxClient,
      maxBotLinkService,
      maxBotRegistry,
      chatContextCache,
    };
  }

  it('syncs admin allowlist from the first admin-capable bot', async () => {
    const { service, prisma, maxClient, maxBotLinkService, chatContextCache } = createService();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([{ userId: 'user-1' }, { userId: 'user-3' }]);
    maxClient.getCurrentChatMemberAccess.mockResolvedValue({
      userId: 'bot-user-1',
      isAdmin: true,
      isOwner: false,
      permissions: ['delete_messages'],
    });
    maxClient.getChatAdminIds.mockResolvedValue(['user-1', 'user-2']);

    await expect(
      service.processJob({
        chatId: '-100123',
        botIds: ['bot-1'],
        title: 'Shared chat',
        entityType: 'chat',
      }),
    ).resolves.toBe(true);

    expect(maxBotLinkService.bindDiscoveredChatBots).toHaveBeenCalledWith({
      chatId: '-100123',
      primaryBotId: 'bot-1',
      botIds: ['bot-1'],
      title: 'Shared chat',
      entityType: 'CHAT',
    });
    expect(prisma.chatAdminAllowlist.createMany).toHaveBeenCalledWith({
      data: [{ chatId: '-100123', userId: 'user-2' }],
      skipDuplicates: true,
    });
    expect(prisma.chatAdminAllowlist.deleteMany).toHaveBeenCalledWith({
      where: {
        chatId: '-100123',
        userId: {
          in: ['user-3'],
        },
      },
    });
    expect(chatContextCache.replaceChatAdminUsers).toHaveBeenCalledWith('-100123', [
      'user-1',
      'user-2',
    ]);
    expect(chatContextCache.setAdminAccess).toHaveBeenCalledWith('-100123', 'user-1', 'granted');
    expect(chatContextCache.setAdminAccess).toHaveBeenCalledWith('-100123', 'user-2', 'granted');
    expect(chatContextCache.setAdminAccess).toHaveBeenCalledWith(
      '-100123',
      'user-3',
      'user_denied',
    );
  });

  it('clears stale allowlist rows when no bot keeps admin access', async () => {
    const { service, prisma, maxClient, chatContextCache } = createService();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([{ userId: 'user-7' }, { userId: 'user-8' }]);
    maxClient.getCurrentChatMemberAccess.mockResolvedValue({
      userId: 'bot-user-1',
      isAdmin: false,
      isOwner: false,
      permissions: [],
    });

    await expect(
      service.processJob({
        chatId: '-100124',
        botIds: ['bot-1'],
        title: 'Lost admin chat',
        entityType: 'channel',
      }),
    ).resolves.toBe(false);

    expect(prisma.chatAdminAllowlist.deleteMany).toHaveBeenCalledWith({
      where: {
        chatId: '-100124',
        userId: {
          in: ['user-7', 'user-8'],
        },
      },
    });
    expect(chatContextCache.replaceChatAdminUsers).toHaveBeenCalledWith('-100124', []);
    expect(chatContextCache.setAdminAccess).toHaveBeenCalledWith('-100124', 'user-7', 'bot_denied');
    expect(chatContextCache.setAdminAccess).toHaveBeenCalledWith('-100124', 'user-8', 'bot_denied');
  });
});
