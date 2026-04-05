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
      getManagedEntityHeader: jest.fn().mockResolvedValue(null),
      getManagedEntitiesPublishedSnapshot: jest.fn().mockResolvedValue(null),
      setManagedEntitiesPublishedSnapshot: jest.fn().mockResolvedValue(undefined),
    };
    const queue = {
      getJob: jest.fn().mockResolvedValue(null),
      add: jest.fn().mockResolvedValue(undefined),
    };

    const service = new MaxChatAdminRosterSyncService(
      prisma as never,
      maxClient as never,
      maxBotLinkService as never,
      maxBotRegistry as never,
      chatContextCache as never,
      queue as never,
    );

    return {
      service,
      prisma,
      maxClient,
      maxBotLinkService,
      maxBotRegistry,
      chatContextCache,
      queue,
    };
  }

  it('enqueues fresh webhook bot_added jobs with a denser fixed retry cadence', async () => {
    const { service, queue } = createService();

    await expect(
      service.scheduleChatAdminRosterSync({
        chatId: '-100122',
        botIds: ['bot-1'],
        title: 'Fresh chat',
        entityType: 'chat',
        source: 'webhook_bot_added',
        retryUntilMs: Date.now() + 45_000,
      }),
    ).resolves.toBe(true);

    expect(queue.add).toHaveBeenCalledWith(
      'sync-chat-admin-roster',
      expect.objectContaining({
        chatId: '-100122',
        source: 'webhook_bot_added',
      }),
      expect.objectContaining({
        attempts: 20,
        priority: 1,
        backoff: {
          type: 'fixed',
          delay: 2_000,
        },
      }),
    );
  });

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

  it('retries a fresh webhook bot_added sync while bot admin rights are still propagating', async () => {
    const { service, prisma, maxClient, chatContextCache } = createService();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([{ userId: 'user-7' }]);
    maxClient.getCurrentChatMemberAccess.mockResolvedValue({
      userId: 'bot-user-1',
      isAdmin: false,
      isOwner: false,
      permissions: [],
    });

    await expect(
      service.processJob({
        chatId: '-100125',
        botIds: ['bot-1'],
        title: 'Fresh chat',
        entityType: 'chat',
        source: 'webhook_bot_added',
        retryUntilMs: Date.now() + 30_000,
      }),
    ).rejects.toThrow('still propagating');

    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledWith(
      '-100125',
      expect.objectContaining({
        botId: 'bot-1',
        trafficClass: 'interactive',
        actionHealthLane: 'background',
        timeoutMs: 1_500,
      }),
    );
    expect(prisma.chatAdminAllowlist.deleteMany).not.toHaveBeenCalled();
    expect(chatContextCache.replaceChatAdminUsers).not.toHaveBeenCalledWith('-100125', []);
  });

  it('keeps non-webhook roster sync reads on the background traffic lane', async () => {
    const { service, maxClient } = createService();
    maxClient.getCurrentChatMemberAccess.mockResolvedValue({
      userId: 'bot-user-1',
      isAdmin: true,
      isOwner: false,
      permissions: ['delete_messages'],
    });
    maxClient.getChatAdminIds.mockResolvedValue(['user-1']);

    await expect(
      service.processJob({
        chatId: '-100127',
        botIds: ['bot-1'],
        title: 'Discovery chat',
        entityType: 'chat',
        source: 'discovery_snapshot',
      }),
    ).resolves.toBe(true);

    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledWith(
      '-100127',
      expect.objectContaining({
        botId: 'bot-1',
        trafficClass: 'background',
        actionHealthLane: 'background',
        timeoutMs: 2_500,
      }),
    );
    expect(maxClient.getChatAdminIds).toHaveBeenCalledWith(
      '-100127',
      expect.objectContaining({
        botId: 'bot-1',
        trafficClass: 'background',
        actionHealthLane: 'background',
        timeoutMs: 2_500,
      }),
    );
  });

  it('pushes allowlist changes into existing published snapshots for affected admins', async () => {
    const { service, prisma, maxClient, chatContextCache } = createService();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([{ userId: 'user-1' }, { userId: 'user-3' }]);
    prisma.chat.findUnique.mockResolvedValue({
      title: 'Snapshot chat',
      entityType: 'CHAT',
      primaryBotId: 'bot-1',
      botId: 'bot-1',
      botMemberships: [],
      id: '-100126',
      createdAt: new Date('2026-04-05T10:00:00.000Z'),
    });
    maxClient.getCurrentChatMemberAccess.mockResolvedValue({
      userId: 'bot-user-1',
      isAdmin: true,
      isOwner: false,
      permissions: ['delete_messages'],
    });
    maxClient.getChatAdminIds.mockResolvedValue(['user-1', 'user-2']);
    chatContextCache.getManagedEntitiesPublishedSnapshot.mockImplementation(
      async (userId: string, entityType: string) => {
        if (entityType !== 'chat') {
          return null;
        }
        if (userId === 'user-1') {
          return {
            version: 'snapshot-user-1',
            builtAt: '2026-04-05T09:00:00.000Z',
            lastSyncedAt: '2026-04-05T09:00:00.000Z',
            itemCount: 1,
            itemsHash: 'hash-1',
            items: [
              {
                id: '-100000',
                title: 'Existing',
                createdAt: '2026-04-04T10:00:00.000Z',
                entityType: 'chat',
                link: null,
                channelOverview: null,
                primaryBotId: 'bot-1',
                assignedBots: [],
                sharedMode: 'owned',
              },
            ],
          };
        }
        if (userId === 'user-3') {
          return {
            version: 'snapshot-user-3',
            builtAt: '2026-04-05T09:00:00.000Z',
            lastSyncedAt: '2026-04-05T09:00:00.000Z',
            itemCount: 2,
            itemsHash: 'hash-3',
            items: [
              {
                id: '-100126',
                title: 'Snapshot chat',
                createdAt: '2026-04-05T10:00:00.000Z',
                entityType: 'chat',
                link: null,
                channelOverview: null,
                primaryBotId: 'bot-1',
                assignedBots: [],
                sharedMode: 'owned',
              },
              {
                id: '-100999',
                title: 'Other',
                createdAt: '2026-04-04T10:00:00.000Z',
                entityType: 'chat',
                link: null,
                channelOverview: null,
                primaryBotId: 'bot-1',
                assignedBots: [],
                sharedMode: 'owned',
              },
            ],
          };
        }
        return null;
      },
    );

    await expect(
      service.processJob({
        chatId: '-100126',
        botIds: ['bot-1'],
        title: 'Snapshot chat',
        entityType: 'chat',
      }),
    ).resolves.toBe(true);

    expect(chatContextCache.setManagedEntitiesPublishedSnapshot).toHaveBeenCalledTimes(2);
    expect(chatContextCache.setManagedEntitiesPublishedSnapshot).toHaveBeenNthCalledWith(
      1,
      'user-1',
      'chat',
      expect.objectContaining({
        itemCount: 2,
        items: expect.arrayContaining([
          expect.objectContaining({ id: '-100126', title: 'Snapshot chat' }),
        ]),
      }),
      604800,
    );
    expect(chatContextCache.setManagedEntitiesPublishedSnapshot).toHaveBeenNthCalledWith(
      2,
      'user-3',
      'chat',
      expect.objectContaining({
        itemCount: 1,
        items: [expect.objectContaining({ id: '-100999' })],
      }),
      604800,
    );
  });
});
