import { ChatBotMembershipStatus, ChatEntityType } from '../prisma/prisma-client';
import { createBareAdminServiceForCatalogTests } from './admin-service-test-support';

describe('AdminService managed bot chat catalog', () => {
  it('keeps remote discovery results when catalog persistence fails', async () => {
    const service = createBareAdminServiceForCatalogTests();
    const catalog = {
      upsert: jest.fn().mockRejectedValue(new Error('db unavailable')),
      updateMany: jest.fn(),
      findMany: jest.fn(),
    };
    service.prisma = {
      managedBotChatCatalog: catalog,
    };
    service.maxClient = {
      listBotChats: jest.fn().mockResolvedValue([
        {
          chatId: ' chat-1 ',
          title: 'Команда MAX',
          lastEventTime: 1778090000123,
          entityType: 'chat',
          link: null,
          avatarUrl: null,
        },
      ]),
    };

    await expect(
      service.loadManagedBotChatsForDiscovery('bot-1', { trafficClass: 'background' }),
    ).resolves.toEqual([
      {
        chatId: 'chat-1',
        title: 'Команда MAX',
        lastEventTime: 1778090000123,
        entityType: 'chat',
        link: null,
        avatarUrl: null,
        botId: 'bot-1',
        botIds: ['bot-1'],
      },
    ]);
    expect(catalog.upsert).toHaveBeenCalledTimes(1);
    expect(service.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        botId: 'bot-1',
        candidateChats: 1,
        err: 'db unavailable',
      }),
      'Failed to persist managed bot chat catalog snapshot',
    );
  });

  it('uses catalog rows when MAX chat discovery fails', async () => {
    const service = createBareAdminServiceForCatalogTests();
    const catalog = {
      upsert: jest.fn(),
      updateMany: jest.fn(),
      findMany: jest.fn().mockResolvedValue([
        {
          botId: 'bot-1',
          chatId: 'chat-1',
          entityType: ChatEntityType.CHAT,
          title: 'Cached chat',
          link: 'https://max.ru/join/chat-1',
          avatarUrl: 'https://cdn.example/avatar.png',
          lastEventTime: '1778090000123',
          lastSeenAt: new Date('2026-05-06T12:00:00.000Z'),
        },
      ]),
    };
    service.prisma = {
      managedBotChatCatalog: catalog,
    };
    service.maxClient = {
      listBotChats: jest.fn().mockRejectedValue(new Error('MAX unavailable')),
    };

    await expect(
      service.loadManagedBotChatsForDiscovery('bot-1', { trafficClass: 'background' }),
    ).resolves.toEqual([
      {
        chatId: 'chat-1',
        title: 'Cached chat',
        link: 'https://max.ru/join/chat-1',
        avatarUrl: 'https://cdn.example/avatar.png',
        entityType: 'chat',
        lastEventTime: 1778090000123,
        botId: 'bot-1',
        botIds: ['bot-1'],
      },
    ]);
    expect(catalog.findMany).toHaveBeenCalledWith({
      where: {
        botId: 'bot-1',
        status: 'ACTIVE',
      },
      orderBy: [{ lastSeenAt: 'desc' }, { updatedAt: 'desc' }],
      take: 20000,
    });
    expect(service.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        botId: 'bot-1',
        fallbackChats: 1,
        err: 'MAX unavailable',
      }),
      'Using managed bot chat catalog fallback after MAX chat discovery failure',
    );
  });

  it('uses active chat bot memberships when MAX discovery and catalog rows are unavailable', async () => {
    const service = createBareAdminServiceForCatalogTests();
    const membershipLastSeenAt = new Date('2026-05-06T12:00:00.000Z');
    const catalog = {
      upsert: jest.fn(),
      updateMany: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
    };
    const chatBotMembership = {
      findMany: jest.fn().mockResolvedValue([
        {
          botId: 'bot-1',
          lastSeenAt: membershipLastSeenAt,
          lastWebhookAt: null,
          chat: {
            id: 'chat-1',
            title: 'Known membership chat',
            entityType: ChatEntityType.CHAT,
            botId: 'bot-1',
            primaryBotId: 'bot-1',
          },
        },
      ]),
    };
    service.prisma = {
      managedBotChatCatalog: catalog,
      chatBotMembership,
    };
    service.maxClient = {
      listBotChats: jest.fn().mockRejectedValue(new Error('MAX unavailable')),
    };

    await expect(
      service.loadManagedBotChatsForDiscovery('bot-1', { trafficClass: 'background' }),
    ).resolves.toEqual([
      {
        chatId: 'chat-1',
        title: 'Known membership chat',
        link: null,
        avatarUrl: null,
        entityType: 'chat',
        lastEventTime: membershipLastSeenAt.getTime(),
        botId: 'bot-1',
        botIds: ['bot-1'],
      },
    ]);
    expect(chatBotMembership.findMany).toHaveBeenCalledWith({
      where: {
        botId: 'bot-1',
        status: ChatBotMembershipStatus.ACTIVE,
      },
      select: {
        botId: true,
        lastSeenAt: true,
        lastWebhookAt: true,
        chat: {
          select: {
            id: true,
            title: true,
            entityType: true,
            botId: true,
            primaryBotId: true,
          },
        },
      },
      orderBy: [{ lastSeenAt: 'desc' }, { updatedAt: 'desc' }],
      take: 20000,
    });
  });

  it('supplements successful MAX discovery with active chat bot memberships', async () => {
    const service = createBareAdminServiceForCatalogTests();
    const membershipLastSeenAt = new Date('2026-05-06T12:00:00.000Z');
    const catalog = {
      upsert: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      findMany: jest.fn(),
    };
    const chatBotMembership = {
      findMany: jest.fn().mockResolvedValue([
        {
          botId: 'bot-1',
          lastSeenAt: membershipLastSeenAt,
          lastWebhookAt: null,
          chat: {
            id: 'channel-old',
            title: 'Old known channel',
            entityType: ChatEntityType.CHANNEL,
            botId: 'bot-1',
            primaryBotId: 'bot-1',
          },
        },
      ]),
    };
    service.prisma = {
      managedBotChatCatalog: catalog,
      chatBotMembership,
    };
    service.maxClient = {
      listBotChats: jest.fn().mockResolvedValue([
        {
          chatId: 'channel-live',
          title: 'Live channel',
          lastEventTime: 1778090000123,
          entityType: 'channel',
          link: null,
          avatarUrl: null,
        },
      ]),
    };

    await expect(
      service.loadManagedBotChatsForDiscovery('bot-1', { trafficClass: 'background' }),
    ).resolves.toEqual([
      {
        chatId: 'channel-live',
        title: 'Live channel',
        lastEventTime: 1778090000123,
        entityType: 'channel',
        link: null,
        avatarUrl: null,
        botId: 'bot-1',
        botIds: ['bot-1'],
      },
      {
        chatId: 'channel-old',
        title: 'Old known channel',
        link: null,
        avatarUrl: null,
        entityType: 'channel',
        lastEventTime: membershipLastSeenAt.getTime(),
        botId: 'bot-1',
        botIds: ['bot-1'],
      },
    ]);
    expect(chatBotMembership.findMany).toHaveBeenCalledWith({
      where: {
        botId: 'bot-1',
        status: ChatBotMembershipStatus.ACTIVE,
      },
      select: {
        botId: true,
        lastSeenAt: true,
        lastWebhookAt: true,
        chat: {
          select: {
            id: true,
            title: true,
            entityType: true,
            botId: true,
            primaryBotId: true,
          },
        },
      },
      orderBy: [{ lastSeenAt: 'desc' }, { updatedAt: 'desc' }],
      take: 20000,
    });
  });

  it('uses local catalog snapshots for managed entities discovery by default', async () => {
    const service = createBareAdminServiceForCatalogTests();
    service.chatContextCache = {};
    service.maxChatAdminRosterSyncService = null;
    service.managedEntitiesDiscoveryHeaderPrimeCooldownUntilMs = new Map();
    service.managedEntitiesDiscoveryHeaderPrimeRuns = new Map();
    service.managedEntitiesCatalogSyncCursorByScope = new Map();
    service.maxBotRegistry = {
      getBotById: jest
        .fn()
        .mockImplementation((botId: string | null | undefined) => (botId ? { id: botId } : null)),
      getDiscoveryBots: jest.fn().mockReturnValue([{ id: 'bot-1' }]),
    };
    service.prisma = {
      managedBotChatCatalog: {
        findMany: jest.fn().mockResolvedValue([
          {
            botId: 'bot-1',
            chatId: 'chat-local',
            entityType: ChatEntityType.CHAT,
            title: 'Локальный чат',
            link: null,
            avatarUrl: null,
            lastEventTime: '1778090000123',
            lastSeenAt: new Date('2026-05-06T12:00:00.000Z'),
          },
        ]),
      },
      chatBotMembership: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    service.maxClient = {
      listBotChats: jest.fn().mockRejectedValue(new Error('remote list must stay unused')),
    };

    await expect(
      service.loadManagedEntitiesDiscoverySnapshot('chat', { trafficClass: 'background' }),
    ).resolves.toEqual([
      {
        chatId: 'chat-local',
        title: 'Локальный чат',
        lastEventTime: 1778090000123,
        entityType: 'chat',
        link: null,
        avatarUrl: null,
        botId: 'bot-1',
        botIds: ['bot-1'],
      },
    ]);
    expect(service.maxClient.listBotChats).not.toHaveBeenCalled();
  });

  it('keeps partial multi-bot remote discovery when explicitly allowed and one bot fails', async () => {
    const service = createBareAdminServiceForCatalogTests();
    service.chatContextCache = {};
    service.maxChatAdminRosterSyncService = null;
    service.managedEntitiesDiscoveryHeaderPrimeCooldownUntilMs = new Map();
    service.managedEntitiesDiscoveryHeaderPrimeRuns = new Map();
    service.managedEntitiesCatalogSyncCursorByScope = new Map();
    service.maxBotRegistry = {
      getBotById: jest
        .fn()
        .mockImplementation((botId: string | null | undefined) => (botId ? { id: botId } : null)),
      getDiscoveryBots: jest.fn().mockReturnValue([{ id: 'bot-1' }, { id: 'bot-2' }]),
    };
    service.prisma = {
      managedBotChatCatalog: {
        upsert: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    service.maxClient = {
      listBotChats: jest.fn().mockImplementation((options: { botId?: string }) => {
        if (options.botId === 'bot-2') {
          return Promise.reject(new Error('bot-2 unavailable'));
        }
        return Promise.resolve([
          {
            chatId: 'chat-1',
            title: 'Команда MAX',
            lastEventTime: 1778090000123,
            entityType: 'chat',
            link: null,
            avatarUrl: null,
          },
        ]);
      }),
    };

    await expect(
      service.loadManagedEntitiesDiscoverySnapshot('chat', {
        trafficClass: 'background',
        allowRemoteListBotChats: true,
      }),
    ).resolves.toEqual([
      {
        chatId: 'chat-1',
        title: 'Команда MAX',
        lastEventTime: 1778090000123,
        entityType: 'chat',
        link: null,
        avatarUrl: null,
        botId: 'bot-1',
        botIds: ['bot-1'],
      },
    ]);
    expect(service.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: 'chat',
        failedBots: 1,
        discoveryBots: 2,
        errors: [
          {
            botId: 'bot-2',
            err: 'bot-2 unavailable',
          },
        ],
      }),
      'Continuing managed entities discovery with partial bot results',
    );
  });

  it('keeps all-bot remote discovery failure visible when explicitly allowed and no fallback exists', async () => {
    const service = createBareAdminServiceForCatalogTests();
    service.maxBotRegistry = {
      getBotById: jest
        .fn()
        .mockImplementation((botId: string | null | undefined) => (botId ? { id: botId } : null)),
      getDiscoveryBots: jest.fn().mockReturnValue([{ id: 'bot-1' }, { id: 'bot-2' }]),
    };
    service.prisma = {
      managedBotChatCatalog: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    service.maxClient = {
      listBotChats: jest.fn().mockRejectedValue(new Error('MAX unavailable')),
    };

    await expect(
      service.loadManagedEntitiesDiscoverySnapshot('chat', {
        trafficClass: 'background',
        allowRemoteListBotChats: true,
      }),
    ).rejects.toThrow('MAX unavailable');
  });
});
