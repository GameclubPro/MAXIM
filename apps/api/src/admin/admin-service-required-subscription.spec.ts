import { chatSettingsSchema } from '@maxim/contracts';
import { AdminService } from './admin.service';
import {
  createChatSummaryFixture,
  createManagedEntityHeaderFixture,
  createPrismaMock,
  createConfigMock,
  createChatContextCacheMock,
  flushAsyncTasks,
} from './admin-service-test-support';

describe('AdminService required subscription settings', () => {
  const actor = {
    userId: 'admin-1',
    username: null,
    displayName: null,
    chatTitle: null,
  };

  it('normalizes and persists required subscription entity ids on update', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getCurrentChatMemberAccess: jest.fn().mockImplementation(async (chatId: string) => ({
        userId: 'id613002203036_bot',
        isAdmin: chatId !== 'channel-2',
        isOwner: false,
        permissions: [],
      })),
      getChatSnapshot: jest.fn().mockImplementation(async (chatId: string) => ({
        chatId,
        title: `Новости MAX ${chatId}`,
        participantsCount: 125,
        status: 'active',
        isPublic: true,
        link: `https://max.ru/${chatId}`,
        lastEventAt: null,
        entityType: 'channel',
      })),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    const result = await service.updateSettings('chat-1', actor, {
      requiredSubscriptionEnabled: true,
      requiredSubscriptionChannelIds: [' channel-1 ', 'channel-1'],
      requiredSubscriptionBotMessageEnabled: true,
      requiredSubscriptionBotMessageText: 'Проверьте подписку.',
      requiredSubscriptionWarnEnabled: true,
      requiredSubscriptionWarnMessageText: 'Сначала подпишитесь на канал.',
      requiredSubscriptionBanEnabled: true,
    });

    expect(result.requiredSubscriptionChannelIds).toEqual(['channel-1']);
    expect(prisma.chat.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          settings: expect.objectContaining({
            upsert: {
              update: expect.objectContaining({
                requiredSubscriptionEnabled: true,
                requiredSubscriptionChannelIds: ['channel-1'],
                requiredSubscriptionBotMessageEnabled: true,
                requiredSubscriptionBotMessageText: 'Проверьте подписку.',
                requiredSubscriptionWarnEnabled: true,
                requiredSubscriptionWarnMessageText: 'Сначала подпишитесь на канал.',
                requiredSubscriptionBanEnabled: true,
              }),
              create: expect.objectContaining({
                requiredSubscriptionEnabled: true,
                requiredSubscriptionChannelIds: ['channel-1'],
                requiredSubscriptionBotMessageEnabled: true,
                requiredSubscriptionBotMessageText: 'Проверьте подписку.',
                requiredSubscriptionWarnEnabled: true,
                requiredSubscriptionWarnMessageText: 'Сначала подпишитесь на канал.',
                requiredSubscriptionBanEnabled: true,
              }),
            },
          }),
        }),
      }),
    );
  });

  it('keeps required subscription indefinite when the block is enabled', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-16T12:00:00.000Z'));

    try {
      const prisma = createPrismaMock();
      const maxClient = {
        getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
        getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
          userId: 'id613002203036_bot',
          isAdmin: true,
          isOwner: false,
          permissions: [],
        }),
        getChatSnapshot: jest.fn().mockResolvedValue({
          chatId: 'channel-1',
          title: 'Новости MAX',
          participantsCount: 125,
          status: 'active',
          isPublic: true,
          link: 'https://max.ru/news',
          lastEventAt: null,
          entityType: 'channel',
        }),
      };

      const service = new AdminService(
        prisma as never,
        maxClient as never,
        createChatContextCacheMock() as never,
        createConfigMock() as never,
      );
      const result = await service.updateSettings('chat-1', actor, {
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: ['channel-1', 'channel-2'],
        requiredSubscriptionDurationDays: 10,
      });

      expect(result.requiredSubscriptionDurationDays).toBe(10);
      expect(result.requiredSubscriptionExpiresAt).toBe('');
      expect(prisma.chat.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            settings: expect.objectContaining({
              upsert: {
                update: expect.objectContaining({
                  requiredSubscriptionDurationDays: 10,
                  requiredSubscriptionExpiresAt: '',
                }),
                create: expect.objectContaining({
                  requiredSubscriptionDurationDays: 10,
                  requiredSubscriptionExpiresAt: '',
                }),
              },
            }),
          }),
        }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('clears an existing required subscription timer on save', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-20T12:00:00.000Z'));

    try {
      const prisma = createPrismaMock();
      prisma.chatSettings.findUnique.mockResolvedValue({
        nightModeForceCloseEnabled: false,
        nightModeForceCloseForever: false,
        nightModeForceCloseHours: 0,
        nightModeForceCloseDays: 0,
        nightModeForceCloseUntil: '',
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: ['channel-1'],
        requiredSubscriptionDurationDays: 7,
        requiredSubscriptionExpiresAt: '2026-04-24T09:30:00.000Z',
      });
      const maxClient = {
        getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
        getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
          userId: 'id613002203036_bot',
          isAdmin: true,
          isOwner: false,
          permissions: [],
        }),
        getChatSnapshot: jest.fn().mockResolvedValue({
          chatId: 'channel-1',
          title: 'Новости MAX',
          participantsCount: 125,
          status: 'active',
          isPublic: true,
          link: 'https://max.ru/news',
          lastEventAt: null,
          entityType: 'channel',
        }),
      };

      const service = new AdminService(
        prisma as never,
        maxClient as never,
        createChatContextCacheMock() as never,
        createConfigMock() as never,
      );
      const result = await service.updateSettings('chat-1', actor, {
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: ['channel-1'],
        requiredSubscriptionDurationDays: 7,
        requiredSubscriptionBotMessageEnabled: true,
        requiredSubscriptionBotMessageText: 'Новая подсказка.',
      });

      expect(result.requiredSubscriptionExpiresAt).toBe('');
      expect(prisma.chat.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            settings: expect.objectContaining({
              upsert: expect.objectContaining({
                update: expect.objectContaining({
                  requiredSubscriptionDurationDays: 7,
                  requiredSubscriptionExpiresAt: '',
                }),
              }),
            }),
          }),
        }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('refreshes bot access snapshots for the chat and required subscription chats/channels after settings update', async () => {
    const prisma = createPrismaMock();
    const chatContextCache = createChatContextCacheMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'id613002203036_bot',
        isAdmin: true,
        isOwner: false,
        permissions: [],
      }),
      getChatSnapshot: jest.fn().mockImplementation(async (chatId: string) => {
        if (chatId === 'chat-remote-1') {
          return {
            chatId,
            title: 'Общий чат',
            participantsCount: 240,
            status: 'active',
            isPublic: true,
            link: 'https://max.ru/chats/chat-remote-1',
            lastEventAt: null,
            entityType: 'chat',
          };
        }

        return {
          chatId,
          title: 'Новости MAX',
          participantsCount: 125,
          status: 'active',
          isPublic: true,
          link: 'https://max.ru/channels/news-max',
          lastEventAt: null,
          entityType: 'channel',
        };
      }),
    };
    const maxBotExecutionPlanner = {
      refreshChatBotCapabilitySnapshots: jest.fn().mockResolvedValue(undefined),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      maxBotExecutionPlanner as never,
    );

    await service.updateSettings('chat-1', actor, {
      requiredSubscriptionEnabled: true,
      requiredSubscriptionChannelIds: ['chat-remote-1', 'channel-1'],
    });

    expect(maxBotExecutionPlanner.refreshChatBotCapabilitySnapshots).toHaveBeenNthCalledWith(1, {
      chatId: 'chat-1',
      entityType: 'chat',
    });
    expect(maxBotExecutionPlanner.refreshChatBotCapabilitySnapshots).toHaveBeenNthCalledWith(2, {
      chatId: 'chat-remote-1',
      entityType: 'chat',
    });
    expect(maxBotExecutionPlanner.refreshChatBotCapabilitySnapshots).toHaveBeenNthCalledWith(3, {
      chatId: 'channel-1',
      entityType: 'channel',
    });
    expect(chatContextCache.invalidate).toHaveBeenCalledWith('chat-1');
  });

  it('resolves an external required subscription channel by public link when the bot is admin there', async () => {
    const prisma = createPrismaMock();
    const chatContextCache = createChatContextCacheMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockImplementation(async (chatId: string) => {
        if (chatId === 'chat-1') {
          return ['admin-1'];
        }
        return [];
      }),
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'id613002203036_bot',
        isAdmin: true,
        isOwner: false,
        permissions: [],
      }),
      listBotChats: jest.fn(),
      getChannelSnapshotByLink: jest.fn().mockResolvedValue({
        chatId: 'channel-ext-1',
        title: 'Партнерские новости',
        participantsCount: 318,
        status: 'active',
        isPublic: true,
        link: 'https://max.ru/channels/partner-news',
        lastEventAt: null,
        entityType: 'channel',
      }),
      getChatSnapshot: jest.fn().mockResolvedValue({
        chatId: 'channel-ext-1',
        title: 'Партнерские новости',
        participantsCount: 318,
        status: 'active',
        isPublic: true,
        link: 'https://max.ru/channels/partner-news',
        lastEventAt: null,
        entityType: 'channel',
      }),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const result = await service.resolveRequiredSubscriptionChannel('chat-1', actor, {
      value: 'max.ru/channels/partner-news',
    });

    expect(result).toEqual({
      channel: createManagedEntityHeaderFixture({
        id: 'channel-ext-1',
        title: 'Партнерские новости',
        entityType: 'channel',
        link: 'https://max.ru/channels/partner-news',
        participantsCount: 318,
      }),
    });
    expect(maxClient.getChannelSnapshotByLink).toHaveBeenCalledWith(
      'partner-news',
      expect.objectContaining({
        sourceTag: 'required_subscription_metadata',
      }),
    );
    expect(maxClient.listBotChats).not.toHaveBeenCalled();
    expect(chatContextCache.setManagedEntityHeader).toHaveBeenCalledWith(
      createManagedEntityHeaderFixture({
        id: 'channel-ext-1',
        title: 'Партнерские новости',
        entityType: 'channel',
        link: 'https://max.ru/channels/partner-news',
        participantsCount: 318,
      }),
    );
  });

  it('resolves an external required subscription chat by MAX chat link when the bot is admin there', async () => {
    const prisma = createPrismaMock();
    const chatContextCache = createChatContextCacheMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockImplementation(async (chatId: string) => {
        if (chatId === 'chat-1') {
          return ['admin-1'];
        }
        return [];
      }),
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'id613002203036_bot',
        isAdmin: true,
        isOwner: false,
        permissions: [],
      }),
      listBotChats: jest.fn().mockResolvedValue([
        {
          chatId: 'chat-ext-1',
          title: 'Партнерский чат',
          lastEventTime: 1,
          entityType: 'chat',
          link: 'https://max.ru/chats/chat-ext-1',
        },
      ]),
      getChatSnapshot: jest.fn().mockResolvedValue({
        chatId: 'chat-ext-1',
        title: 'Партнерский чат',
        participantsCount: 318,
        status: 'active',
        isPublic: true,
        link: 'https://max.ru/chats/chat-ext-1',
        lastEventAt: null,
        entityType: 'chat',
      }),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const result = await service.resolveRequiredSubscriptionChannel('chat-1', actor, {
      value: 'max.ru/chats/chat-ext-1',
    });

    expect(result).toEqual({
      channel: createManagedEntityHeaderFixture({
        id: 'chat-ext-1',
        title: 'Партнерский чат',
        entityType: 'chat',
        link: 'https://max.ru/chats/chat-ext-1',
        participantsCount: 318,
      }),
    });
    expect(maxClient.listBotChats).not.toHaveBeenCalled();
    expect(chatContextCache.setManagedEntityHeader).toHaveBeenCalledWith(
      createManagedEntityHeaderFixture({
        id: 'chat-ext-1',
        title: 'Партнерский чат',
        entityType: 'chat',
        link: 'https://max.ru/chats/chat-ext-1',
        participantsCount: 318,
      }),
    );
  });

  it('resolves an external required subscription channel when the input uses /channel/ but discovery returns /channels/', async () => {
    const prisma = createPrismaMock();
    const chatContextCache = createChatContextCacheMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockImplementation(async (chatId: string) => {
        if (chatId === 'chat-1') {
          return ['admin-1'];
        }
        return [];
      }),
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'id613002203036_bot',
        isAdmin: true,
        isOwner: false,
        permissions: [],
      }),
      listBotChats: jest.fn(),
      getChannelSnapshotByLink: jest.fn().mockResolvedValue({
        chatId: 'channel-ext-2',
        title: 'Канал партнера',
        participantsCount: 207,
        status: 'active',
        isPublic: true,
        link: 'https://max.ru/channels/partner-feed',
        lastEventAt: null,
        entityType: 'channel',
      }),
      getChatSnapshot: jest.fn().mockResolvedValue({
        chatId: 'channel-ext-2',
        title: 'Канал партнера',
        participantsCount: 207,
        status: 'active',
        isPublic: true,
        link: 'https://max.ru/channels/partner-feed',
        lastEventAt: null,
        entityType: 'channel',
      }),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const result = await service.resolveRequiredSubscriptionChannel('chat-1', actor, {
      value: 'https://max.ru/channel/partner-feed?from=share',
    });

    expect(result).toEqual({
      channel: createManagedEntityHeaderFixture({
        id: 'channel-ext-2',
        title: 'Канал партнера',
        entityType: 'channel',
        link: 'https://max.ru/channels/partner-feed',
        participantsCount: 207,
      }),
    });
    expect(maxClient.getChannelSnapshotByLink).toHaveBeenCalledWith(
      'partner-feed',
      expect.objectContaining({
        sourceTag: 'required_subscription_metadata',
      }),
    );
    expect(maxClient.listBotChats).not.toHaveBeenCalled();
  });

  it('resolves an external required subscription channel from a root MAX public slug', async () => {
    const prisma = createPrismaMock();
    const chatContextCache = createChatContextCacheMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockImplementation(async (chatId: string) => {
        if (chatId === 'chat-1') {
          return ['admin-1'];
        }
        return [];
      }),
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'id613002203036_bot',
        isAdmin: true,
        isOwner: false,
        permissions: [],
      }),
      listBotChats: jest.fn(),
      getChannelSnapshotByLink: jest.fn().mockResolvedValue({
        chatId: 'channel-auto-market',
        title: 'Авторынок ДНР ЛНР',
        participantsCount: 1024,
        status: 'active',
        isPublic: true,
        link: 'https://max.ru/channels/aavtorynok_dnr_lnr',
        lastEventAt: null,
        entityType: 'channel',
      }),
      getChatSnapshot: jest.fn().mockResolvedValue({
        chatId: 'channel-auto-market',
        title: 'Авторынок ДНР ЛНР',
        participantsCount: 1024,
        status: 'active',
        isPublic: true,
        link: 'https://max.ru/channels/aavtorynok_dnr_lnr',
        lastEventAt: null,
        entityType: 'channel',
      }),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const result = await service.resolveRequiredSubscriptionChannel('chat-1', actor, {
      value: 'https://max.ru/aavtorynok_dnr_lnr',
    });

    expect(result).toEqual({
      channel: createManagedEntityHeaderFixture({
        id: 'channel-auto-market',
        title: 'Авторынок ДНР ЛНР',
        entityType: 'channel',
        link: 'https://max.ru/channels/aavtorynok_dnr_lnr',
        participantsCount: 1024,
      }),
    });
    expect(maxClient.getChannelSnapshotByLink).toHaveBeenCalledWith(
      'aavtorynok_dnr_lnr',
      expect.objectContaining({
        sourceTag: 'required_subscription_metadata',
      }),
    );
    expect(maxClient.listBotChats).not.toHaveBeenCalled();
  });

  it('resolves an external required subscription channel from a locally known root link when discovery misses it', async () => {
    const prisma = createPrismaMock();
    prisma.managedBotChatCatalog.findMany.mockResolvedValue([
      {
        botId: 'id613002203036_bot',
        chatId: '-75095650340108',
        entityType: 'CHANNEL',
        title: 'Авторынок ДНР/ЛНР',
        link: 'https://max.ru/aavtorynok_dnr_lnr',
        avatarUrl: null,
        lastEventTime: '1779913608754',
        lastSeenAt: new Date('2026-05-27T20:26:48.754Z'),
      },
    ]);
    const chatContextCache = createChatContextCacheMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockImplementation(async (chatId: string) => {
        if (chatId === 'chat-1') {
          return ['admin-1'];
        }
        return [];
      }),
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'id613002203036_bot',
        isAdmin: true,
        isOwner: false,
        permissions: [],
      }),
      listBotChats: jest.fn().mockResolvedValue([]),
      getChatSnapshot: jest.fn().mockResolvedValue({
        chatId: '-75095650340108',
        title: 'Авторынок ДНР/ЛНР',
        participantsCount: 4096,
        status: 'active',
        isPublic: true,
        link: 'https://max.ru/aavtorynok_dnr_lnr',
        lastEventAt: null,
        entityType: 'channel',
      }),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock({ botId: 'id613002203036_bot' }) as never,
    );

    const result = await service.resolveRequiredSubscriptionChannel('chat-1', actor, {
      value: 'https://max.ru/aavtorynok_dnr_lnr',
    });

    expect(result).toEqual({
      channel: createManagedEntityHeaderFixture({
        id: '-75095650340108',
        title: 'Авторынок ДНР/ЛНР',
        entityType: 'channel',
        link: 'https://max.ru/aavtorynok_dnr_lnr',
        participantsCount: 4096,
      }),
    });
    expect(maxClient.listBotChats).not.toHaveBeenCalled();
    expect(prisma.managedBotChatCatalog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          link: {
            in: expect.arrayContaining([
              'https://max.ru/aavtorynok_dnr_lnr',
              'https://max.ru/channel/aavtorynok_dnr_lnr',
              'https://max.ru/channels/aavtorynok_dnr_lnr',
            ]),
          },
        },
      }),
    );
    expect(maxClient.getChatSnapshot).toHaveBeenCalledWith(
      '-75095650340108',
      expect.objectContaining({
        sourceTag: 'required_subscription_metadata',
      }),
    );
  });

  it('resolves an external required subscription channel from a public channel message link', async () => {
    const prisma = createPrismaMock();
    const chatContextCache = createChatContextCacheMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockImplementation(async (chatId: string) => {
        if (chatId === 'chat-1') {
          return ['admin-1'];
        }
        return [];
      }),
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'id613002203036_bot',
        isAdmin: true,
        isOwner: false,
        permissions: [],
      }),
      listBotChats: jest.fn(),
      getChannelSnapshotByLink: jest.fn().mockResolvedValue({
        chatId: 'channel-ext-5',
        title: 'Публичный пост канала',
        participantsCount: 511,
        status: 'active',
        isPublic: true,
        link: 'https://max.ru/channels/public-feed',
        lastEventAt: null,
        entityType: 'channel',
      }),
      getChatSnapshot: jest.fn().mockResolvedValue({
        chatId: 'channel-ext-5',
        title: 'Публичный пост канала',
        participantsCount: 511,
        status: 'active',
        isPublic: true,
        link: 'https://max.ru/channels/public-feed',
        lastEventAt: null,
        entityType: 'channel',
      }),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const result = await service.resolveRequiredSubscriptionChannel('chat-1', actor, {
      value: 'https://max.ru/channels/public-feed/messages/post-42?from=share',
    });

    expect(result).toEqual({
      channel: createManagedEntityHeaderFixture({
        id: 'channel-ext-5',
        title: 'Публичный пост канала',
        entityType: 'channel',
        link: 'https://max.ru/channels/public-feed',
        participantsCount: 511,
      }),
    });
    expect(maxClient.getChannelSnapshotByLink).toHaveBeenCalledWith(
      'public-feed',
      expect.objectContaining({
        sourceTag: 'required_subscription_metadata',
      }),
    );
    expect(maxClient.listBotChats).not.toHaveBeenCalled();
  });

  it('resolves a fresh external required subscription channel by targeted public link lookup', async () => {
    const prisma = createPrismaMock();
    const chatContextCache = createChatContextCacheMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockImplementation(async (chatId: string) => {
        if (chatId === 'chat-1') {
          return ['admin-1'];
        }
        return [];
      }),
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'id613002203036_bot',
        isAdmin: true,
        isOwner: false,
        permissions: [],
      }),
      listBotChats: jest.fn(),
      getChannelSnapshotByLink: jest.fn().mockResolvedValue({
        chatId: 'channel-ext-3',
        title: 'Свежий канал',
        participantsCount: 88,
        status: 'active',
        isPublic: true,
        link: 'https://max.ru/channels/fresh-channel',
        lastEventAt: null,
        entityType: 'channel',
      }),
      getChatSnapshot: jest.fn().mockResolvedValue({
        chatId: 'channel-ext-3',
        title: 'Свежий канал',
        participantsCount: 88,
        status: 'active',
        isPublic: true,
        link: 'https://max.ru/channels/fresh-channel',
        lastEventAt: null,
        entityType: 'channel',
      }),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const result = await service.resolveRequiredSubscriptionChannel('chat-1', actor, {
      value: 'max.ru/channels/fresh-channel',
    });

    expect(result).toEqual({
      channel: createManagedEntityHeaderFixture({
        id: 'channel-ext-3',
        title: 'Свежий канал',
        entityType: 'channel',
        link: 'https://max.ru/channels/fresh-channel',
        participantsCount: 88,
      }),
    });
    expect(maxClient.getChannelSnapshotByLink).toHaveBeenCalledWith(
      'fresh-channel',
      expect.objectContaining({
        trafficClass: 'interactive',
        sourceTag: 'required_subscription_metadata',
      }),
    );
    expect(maxClient.listBotChats).not.toHaveBeenCalled();
  });

  it('resolves an external required subscription channel from a MAX chat post link', async () => {
    const prisma = createPrismaMock();
    const chatContextCache = createChatContextCacheMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'id613002203036_bot',
        isAdmin: true,
        isOwner: false,
        permissions: [],
      }),
      getChatSnapshot: jest.fn().mockResolvedValue({
        chatId: 'channel-ext-3',
        title: 'Канал по ссылке на пост',
        participantsCount: 72,
        status: 'active',
        isPublic: false,
        link: null,
        lastEventAt: null,
        entityType: 'channel',
      }),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const result = await service.resolveRequiredSubscriptionChannel('chat-1', actor, {
      value: 'https://max.ru/chats/channel-ext-3/message/100',
    });

    expect(result).toEqual({
      channel: createManagedEntityHeaderFixture({
        id: 'channel-ext-3',
        title: 'Канал по ссылке на пост',
        entityType: 'channel',
        link: null,
        participantsCount: 72,
      }),
    });
    expect(maxClient.getChatSnapshot).toHaveBeenCalledWith(
      'channel-ext-3',
      expect.objectContaining({
        sourceTag: 'required_subscription_metadata',
      }),
    );
    expect(chatContextCache.setManagedEntityHeader).toHaveBeenCalledWith(
      createManagedEntityHeaderFixture({
        id: 'channel-ext-3',
        title: 'Канал по ссылке на пост',
        entityType: 'channel',
        link: null,
        participantsCount: 72,
      }),
    );
  });

  it('resolves an external required subscription channel from a short MAX post link', async () => {
    const prisma = createPrismaMock();
    const chatContextCache = createChatContextCacheMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'id613002203036_bot',
        isAdmin: true,
        isOwner: false,
        permissions: [],
      }),
      getChatSnapshot: jest.fn().mockResolvedValue({
        chatId: '-71768670111751',
        title: 'Канал по короткой ссылке',
        participantsCount: 125,
        status: 'active',
        isPublic: false,
        link: null,
        lastEventAt: null,
        entityType: 'channel',
      }),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const result = await service.resolveRequiredSubscriptionChannel('chat-1', actor, {
      value: 'https://max.ru/c/-71768670111751/AZzTfJDZAGg',
    });

    expect(result).toEqual({
      channel: createManagedEntityHeaderFixture({
        id: '-71768670111751',
        title: 'Канал по короткой ссылке',
        entityType: 'channel',
        link: null,
        participantsCount: 125,
      }),
    });
    expect(maxClient.getChatSnapshot).toHaveBeenCalledWith(
      '-71768670111751',
      expect.objectContaining({
        sourceTag: 'required_subscription_metadata',
      }),
    );
  });

  it('resolves an external required subscription chat from a MAX chat post link', async () => {
    const prisma = createPrismaMock();
    const chatContextCache = createChatContextCacheMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'id613002203036_bot',
        isAdmin: true,
        isOwner: false,
        permissions: [],
      }),
      getChatSnapshot: jest.fn().mockResolvedValue({
        chatId: 'chat-ext-1',
        title: 'Чат по ссылке на пост',
        participantsCount: 72,
        status: 'active',
        isPublic: false,
        link: null,
        lastEventAt: null,
        entityType: 'chat',
      }),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const result = await service.resolveRequiredSubscriptionChannel('chat-1', actor, {
      value: 'https://max.ru/chats/chat-ext-1/message/100',
    });

    expect(result).toEqual({
      channel: createManagedEntityHeaderFixture({
        id: 'chat-ext-1',
        title: 'Чат по ссылке на пост',
        entityType: 'chat',
        link: null,
        participantsCount: 72,
      }),
    });
    expect(maxClient.getChatSnapshot).toHaveBeenCalledWith(
      'chat-ext-1',
      expect.objectContaining({
        sourceTag: 'required_subscription_metadata',
      }),
    );
    expect(chatContextCache.setManagedEntityHeader).toHaveBeenCalledWith(
      createManagedEntityHeaderFixture({
        id: 'chat-ext-1',
        title: 'Чат по ссылке на пост',
        entityType: 'chat',
        link: null,
        participantsCount: 72,
      }),
    );
  });

  it('accepts an external required subscription channel on update when the bot is admin there', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'id613002203036_bot',
        isAdmin: true,
        isOwner: false,
        permissions: [],
      }),
      getChatSnapshot: jest.fn().mockResolvedValue({
        chatId: 'channel-ext-1',
        title: 'Партнерские новости',
        participantsCount: 318,
        status: 'active',
        isPublic: true,
        link: 'https://max.ru/channels/partner-news',
        lastEventAt: null,
        entityType: 'channel',
      }),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    const result = await service.updateSettings('chat-1', actor, {
      requiredSubscriptionEnabled: true,
      requiredSubscriptionChannelIds: ['channel-ext-1'],
    });

    expect(result.requiredSubscriptionChannelIds).toEqual(['channel-ext-1']);
    expect(maxClient.getChatSnapshot).toHaveBeenCalledWith(
      'channel-ext-1',
      expect.objectContaining({
        actionHealthLane: 'background',
        sourceTag: 'required_subscription_metadata',
      }),
    );
  });

  it('accepts an external required subscription chat on update when the bot is admin there', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'id613002203036_bot',
        isAdmin: true,
        isOwner: false,
        permissions: [],
      }),
      getChatSnapshot: jest.fn().mockResolvedValue({
        chatId: 'chat-ext-1',
        title: 'Партнерский чат',
        participantsCount: 318,
        status: 'active',
        isPublic: true,
        link: 'https://max.ru/chats/chat-ext-1',
        lastEventAt: null,
        entityType: 'chat',
      }),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    const result = await service.updateSettings('chat-1', actor, {
      requiredSubscriptionEnabled: true,
      requiredSubscriptionChannelIds: ['chat-ext-1'],
    });

    expect(result.requiredSubscriptionChannelIds).toEqual(['chat-ext-1']);
    expect(maxClient.getChatSnapshot).toHaveBeenCalledWith(
      'chat-ext-1',
      expect.objectContaining({
        actionHealthLane: 'background',
        sourceTag: 'required_subscription_metadata',
      }),
    );
  });

  it('binds an external required subscription channel to the bot that actually has access', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue(null);
    const chatContextCache = createChatContextCacheMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getCurrentChatMemberAccess: jest.fn().mockImplementation(
        async (
          _chatId: string,
          options?: {
            botId?: string;
          },
        ) => ({
          userId: options?.botId ?? 'unknown',
          isAdmin: options?.botId === 'id613002203036_4_bot',
          isOwner: false,
          permissions: [],
        }),
      ),
      getChatSnapshot: jest.fn().mockImplementation(async (chatId: string) => {
        if (chatId === 'chat-1') {
          return {
            chatId: 'chat-1',
            title: 'Команда MAX',
            participantsCount: 128,
            status: 'active',
            isPublic: false,
            link: null,
            lastEventAt: null,
            entityType: 'chat',
          };
        }

        return {
          chatId: 'channel-ext-2',
          title: 'Канал второго бота',
          participantsCount: 41,
          status: 'active',
          isPublic: true,
          link: 'https://max.ru/channels/second-bot',
          lastEventAt: null,
          entityType: 'channel',
        };
      }),
    };
    const maxBotLinkService = {
      resolveBotId: jest.fn().mockResolvedValue(undefined),
      bindDiscoveredChatBots: jest.fn().mockResolvedValue('id613002203036_4_bot'),
      resolveContactIdSync: jest.fn((botId?: string | null) => {
        if (botId === 'id613002203036_4_bot') {
          return '214634783';
        }
        if (botId === 'id613002203036_bot') {
          return '613002203036';
        }
        return null;
      }),
      getBotTokenSync: jest.fn().mockReturnValue(null),
      getValidationTokens: jest.fn().mockReturnValue([]),
    };
    const maxBotRegistry = {
      getBotById: jest.fn((botId?: string | null) => {
        if (botId === 'id613002203036_bot') {
          return {
            id: 'id613002203036_bot',
            label: 'MAXIM',
            state: 'active',
            speechPersona: 'male',
            characterName: 'Майор Максимов',
          };
        }
        if (botId === 'id613002203036_4_bot') {
          return {
            id: 'id613002203036_4_bot',
            label: 'MAXIM 2',
            state: 'active',
            speechPersona: 'female',
            characterName: 'Майор Максимова',
          };
        }
        return null;
      }),
      getDiscoveryBots: jest
        .fn()
        .mockReturnValue([{ id: 'id613002203036_bot' }, { id: 'id613002203036_4_bot' }]),
      getActionableBots: jest
        .fn()
        .mockReturnValue([{ id: 'id613002203036_bot' }, { id: 'id613002203036_4_bot' }]),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock({ botId: 'id613002203036_bot' }) as never,
      undefined,
      undefined,
      undefined,
      undefined,
      maxBotLinkService as never,
      maxBotRegistry as never,
    );

    const result = await service.updateSettings('chat-1', actor, {
      requiredSubscriptionEnabled: true,
      requiredSubscriptionChannelIds: ['channel-ext-2'],
    });

    expect(result.requiredSubscriptionChannelIds).toEqual(['channel-ext-2']);
    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenNthCalledWith(
      1,
      'channel-ext-2',
      expect.objectContaining({
        botId: 'id613002203036_bot',
        sourceTag: 'required_subscription_metadata',
      }),
    );
    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenNthCalledWith(
      2,
      'channel-ext-2',
      expect.objectContaining({
        botId: 'id613002203036_4_bot',
        sourceTag: 'required_subscription_metadata',
      }),
    );
    expect(maxClient.getChatSnapshot).toHaveBeenCalledWith(
      'channel-ext-2',
      expect.objectContaining({
        botId: 'id613002203036_4_bot',
        sourceTag: 'required_subscription_metadata',
      }),
    );
    expect(prisma.chat.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'channel-ext-2' },
        create: expect.objectContaining({
          botId: 'id613002203036_4_bot',
          primaryBotId: 'id613002203036_4_bot',
        }),
        update: expect.objectContaining({
          botId: 'id613002203036_4_bot',
          primaryBotId: 'id613002203036_4_bot',
        }),
      }),
    );
    expect(maxBotLinkService.bindDiscoveredChatBots).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'channel-ext-2',
        primaryBotId: 'id613002203036_4_bot',
        botIds: ['id613002203036_4_bot'],
      }),
    );
    expect(chatContextCache.setManagedEntityHeader).toHaveBeenCalledWith(
      createManagedEntityHeaderFixture({
        id: 'channel-ext-2',
        title: 'Канал второго бота',
        entityType: 'channel',
        link: 'https://max.ru/channels/second-bot',
        participantsCount: 41,
        primaryBotId: 'id613002203036_4_bot',
      }),
    );
  });

  it('drops required subscription channels the bot cannot verify', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockImplementation(async (chatId: string) => {
        if (chatId === 'chat-1') {
          return ['admin-1'];
        }
        return [];
      }),
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'id613002203036_bot',
        isAdmin: false,
        isOwner: false,
        permissions: [],
      }),
      getChatSnapshot: jest.fn().mockResolvedValue({
        chatId: 'channel-ext-1',
        title: 'Партнерские новости',
        participantsCount: 318,
        status: 'active',
        isPublic: true,
        link: 'https://max.ru/channels/partner-news',
        lastEventAt: null,
        entityType: 'channel',
      }),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    const result = await service.updateSettings('chat-1', actor, {
      requiredSubscriptionEnabled: true,
      requiredSubscriptionChannelIds: ['channel-ext-1'],
    });

    expect(result.requiredSubscriptionEnabled).toBe(false);
    expect(result.requiredSubscriptionChannelIds).toEqual([]);
    expect(prisma.chat.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          settings: expect.objectContaining({
            upsert: {
              update: expect.objectContaining({
                requiredSubscriptionEnabled: false,
                requiredSubscriptionChannelIds: [],
              }),
              create: expect.objectContaining({
                requiredSubscriptionEnabled: false,
                requiredSubscriptionChannelIds: [],
              }),
            },
          }),
        }),
      }),
    );
  });

  it('keeps only verifiable required subscription targets from a mixed list', async () => {
    const prisma = createPrismaMock();
    const chatContextCache = createChatContextCacheMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getCurrentChatMemberAccess: jest.fn().mockImplementation(async (chatId: string) => ({
        userId: 'id613002203036_bot',
        isAdmin: chatId !== 'channel-3',
        isOwner: false,
        permissions: [],
      })),
      getChatSnapshot: jest.fn().mockImplementation(async (chatId: string) => ({
        chatId,
        title: `Канал ${chatId}`,
        participantsCount: 100,
        status: 'active',
        isPublic: true,
        link: `https://max.ru/${chatId}`,
        lastEventAt: null,
        entityType: 'channel',
      })),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const result = await service.updateSettings('chat-1', actor, {
      requiredSubscriptionEnabled: true,
      requiredSubscriptionChannelIds: ['channel-1', 'channel-2', 'channel-3'],
    });

    expect(result.requiredSubscriptionEnabled).toBe(true);
    expect(result.requiredSubscriptionChannelIds).toEqual(['channel-1', 'channel-2']);
    expect(prisma.chat.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          settings: expect.objectContaining({
            upsert: {
              update: expect.objectContaining({
                requiredSubscriptionEnabled: true,
                requiredSubscriptionChannelIds: ['channel-1', 'channel-2'],
              }),
              create: expect.objectContaining({
                requiredSubscriptionEnabled: true,
                requiredSubscriptionChannelIds: ['channel-1', 'channel-2'],
              }),
            },
          }),
        }),
      }),
    );
    const cachedHeaderIds = chatContextCache.setManagedEntityHeader.mock.calls.map(
      ([header]) => header.id,
    );
    expect(cachedHeaderIds).toEqual(expect.arrayContaining(['channel-1', 'channel-2']));
    expect(cachedHeaderIds).not.toContain('channel-3');
  });

  it('disables required subscription when enabled payload has no channels', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    const result = await service.updateSettings('chat-1', actor, {
      requiredSubscriptionEnabled: true,
      requiredSubscriptionChannelIds: [],
    });

    expect(result.requiredSubscriptionEnabled).toBe(false);
    expect(result.requiredSubscriptionChannelIds).toEqual([]);
    expect(result.requiredSubscriptionExpiresAt).toBe('');
    expect(prisma.chat.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          settings: expect.objectContaining({
            upsert: {
              update: expect.objectContaining({
                requiredSubscriptionEnabled: false,
                requiredSubscriptionChannelIds: [],
                requiredSubscriptionExpiresAt: '',
              }),
              create: expect.objectContaining({
                requiredSubscriptionEnabled: false,
                requiredSubscriptionChannelIds: [],
                requiredSubscriptionExpiresAt: '',
              }),
            },
          }),
        }),
      }),
    );
  });

  it('accepts required subscription channels without a public link when the bot is admin there', async () => {
    const prisma = createPrismaMock();
    const chatContextCache = createChatContextCacheMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'id613002203036_bot',
        isAdmin: true,
        isOwner: false,
        permissions: [],
      }),
      getChatSnapshot: jest.fn().mockResolvedValue({
        chatId: 'channel-1',
        title: 'Новости MAX',
        participantsCount: 125,
        status: 'active',
        isPublic: false,
        link: null,
        lastEventAt: null,
        entityType: 'channel',
      }),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );
    const result = await service.updateSettings('chat-1', actor, {
      requiredSubscriptionEnabled: true,
      requiredSubscriptionChannelIds: ['channel-1'],
    });

    expect(result.requiredSubscriptionChannelIds).toEqual(['channel-1']);
    expect(chatContextCache.setManagedEntityHeader).toHaveBeenCalledWith(
      createManagedEntityHeaderFixture({
        id: 'channel-1',
        title: 'Новости MAX',
        entityType: 'channel',
        link: null,
        participantsCount: 125,
      }),
    );
  });

  it('applies the required subscription section to every cached chat', async () => {
    const prisma = createPrismaMock();
    prisma.chat.upsert.mockResolvedValue({
      id: 'chat-2',
      title: 'Клуб соседей',
      entityType: 'CHAT',
      createdAt: new Date('2026-03-02T00:00:00.000Z'),
    });
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      {
        chat: {
          id: 'chat-2',
          title: 'Клуб соседей',
          createdAt: new Date('2026-03-02T00:00:00.000Z'),
          entityType: 'CHAT',
        },
      },
    ]);
    const chatContextCache = createChatContextCacheMock();
    const maxBotExecutionPlanner = {
      refreshChatBotCapabilitySnapshots: jest.fn().mockResolvedValue(undefined),
    };

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'id613002203036_bot',
        isAdmin: true,
        isOwner: false,
        permissions: [],
      }),
      getChatSnapshot: jest.fn().mockResolvedValue({
        chatId: 'channel-1',
        title: 'Новости MAX',
        participantsCount: 125,
        status: 'active',
        isPublic: true,
        link: 'https://max.ru/news',
        lastEventAt: null,
        entityType: 'channel',
      }),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      maxBotExecutionPlanner as never,
    );
    jest.spyOn(service, 'getSettings').mockResolvedValue(
      chatSettingsSchema.parse({
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: ['channel-1'],
        requiredSubscriptionBotMessageEnabled: true,
        requiredSubscriptionBotMessageText: 'Следите за подпиской.',
        requiredSubscriptionWarnEnabled: true,
        requiredSubscriptionWarnMessageText: 'Сначала подпишитесь.',
        requiredSubscriptionBanEnabled: true,
        deleteSpammersEnabled: true,
      }),
    );

    const result = await service.applySettingsSectionToAllChats('chat-1', actor, {
      section: 'requiredSubscription',
      target: { mode: 'all', favoriteTypes: [], chatIds: [] },
    });

    expect(result.section).toBe('requiredSubscription');
    expect(result.updatedChats).toBe(2);
    expect(result.appliedChatIds).toEqual(['chat-1', 'chat-2']);

    const chat2Call = prisma.chat.upsert.mock.calls.find(
      ([args]) => args?.where?.id === 'chat-2',
    )?.[0];
    expect(chat2Call).toBeDefined();
    expect(chat2Call?.create?.settings?.create).toEqual(
      expect.objectContaining({
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: ['channel-1'],
        requiredSubscriptionBotMessageEnabled: true,
        requiredSubscriptionBotMessageText: 'Следите за подпиской.',
        requiredSubscriptionWarnEnabled: true,
        requiredSubscriptionWarnMessageText: 'Сначала подпишитесь.',
        requiredSubscriptionBanEnabled: true,
        deleteSpammersEnabled: false,
      }),
    );
    expect(chat2Call?.update?.settings?.upsert?.update).toEqual(
      expect.objectContaining({
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: ['channel-1'],
        requiredSubscriptionBotMessageEnabled: true,
        requiredSubscriptionBotMessageText: 'Следите за подпиской.',
        requiredSubscriptionWarnEnabled: true,
        requiredSubscriptionWarnMessageText: 'Сначала подпишитесь.',
        requiredSubscriptionBanEnabled: true,
      }),
    );
    expect(chat2Call?.update?.settings?.upsert?.create).toEqual(
      expect.objectContaining({
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: ['channel-1'],
        requiredSubscriptionBotMessageEnabled: true,
        requiredSubscriptionBotMessageText: 'Следите за подпиской.',
        requiredSubscriptionWarnEnabled: true,
        requiredSubscriptionWarnMessageText: 'Сначала подпишитесь.',
        requiredSubscriptionBanEnabled: true,
        deleteSpammersEnabled: false,
      }),
    );
    expect(chatContextCache.invalidate).toHaveBeenCalledWith('chat-1');
    expect(chatContextCache.invalidate).toHaveBeenCalledWith('chat-2');

    await flushAsyncTasks();

    expect(maxBotExecutionPlanner.refreshChatBotCapabilitySnapshots).toHaveBeenCalledTimes(3);
    expect(maxBotExecutionPlanner.refreshChatBotCapabilitySnapshots).toHaveBeenCalledWith({
      chatId: 'chat-1',
      entityType: 'chat',
    });
    expect(maxBotExecutionPlanner.refreshChatBotCapabilitySnapshots).toHaveBeenCalledWith({
      chatId: 'chat-2',
      entityType: 'chat',
    });
    expect(maxBotExecutionPlanner.refreshChatBotCapabilitySnapshots).toHaveBeenCalledWith({
      chatId: 'channel-1',
      entityType: 'channel',
    });
    expect(maxBotExecutionPlanner.refreshChatBotCapabilitySnapshots).not.toHaveBeenCalledWith({
      chatId: 'channel-2',
      entityType: 'channel',
    });
  });

  it('applies the full night section to every cached chat', async () => {
    const prisma = createPrismaMock();
    prisma.chat.upsert.mockResolvedValue({
      id: 'chat-2',
      title: 'Клуб соседей',
      entityType: 'CHAT',
      createdAt: new Date('2026-03-02T00:00:00.000Z'),
    });
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      {
        chat: {
          id: 'chat-2',
          title: 'Клуб соседей',
          createdAt: new Date('2026-03-02T00:00:00.000Z'),
          entityType: 'CHAT',
        },
      },
    ]);

    const service = new AdminService(
      prisma as never,
      {
        getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      } as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    jest.spyOn(service, 'getSettings').mockResolvedValue(
      chatSettingsSchema.parse({
        nightModeEnabled: true,
        nightModeStartTimeMinutes: 23 * 60,
        nightModeEndTimeMinutes: 6 * 60,
        nightModeTimezone: 'Europe/Moscow',
        nightModeBotMessageEnabled: true,
        nightModeBotMessageText: 'Чат закрыт до утра.',
        nightModeCommentsEnabled: true,
        nightModeOpenMessageEnabled: true,
        nightModeOpenMessageText: 'Чат снова открыт.',
        nightModeBotButtonEnabled: true,
        nightModeBotButtonUrl: 'https://max.ru/maxim',
        nightModeBotButtonText: 'Профиль',
        nightModeRulesButtonEnabled: true,
        nightModeForceCloseEnabled: true,
        nightModeForceCloseForever: false,
        nightModeForceCloseHours: 8,
        nightModeForceCloseDays: 0,
        nightModeForceCloseUntil: '2099-03-05T03:00:00.000Z',
      }),
    );

    const result = await service.applySettingsSectionToAllChats('chat-1', actor, {
      section: 'night',
      target: { mode: 'all', favoriteTypes: [], chatIds: [] },
    });

    expect(result.section).toBe('night');
    expect(result.updatedChats).toBe(2);
    expect(result.appliedChatIds).toEqual(['chat-1', 'chat-2']);

    const chat2Call = prisma.chat.upsert.mock.calls.find(
      ([args]) => args?.where?.id === 'chat-2',
    )?.[0];
    expect(chat2Call).toBeDefined();
    expect(chat2Call?.create?.settings?.create).toEqual(
      expect.objectContaining({
        nightModeEnabled: true,
        nightModeStartTimeMinutes: 23 * 60,
        nightModeEndTimeMinutes: 6 * 60,
        nightModeTimezone: 'Europe/Moscow',
        nightModeBotMessageEnabled: true,
        nightModeBotMessageText: 'Чат закрыт до утра.',
        nightModeCommentsEnabled: true,
        nightModeOpenMessageEnabled: true,
        nightModeOpenMessageText: 'Чат снова открыт.',
        nightModeBotButtonEnabled: true,
        nightModeBotButtonUrl: 'https://max.ru/maxim',
        nightModeBotButtonText: 'Профиль',
        nightModeRulesButtonEnabled: true,
        nightModeForceCloseEnabled: true,
        nightModeForceCloseForever: false,
        nightModeForceCloseHours: 8,
        nightModeForceCloseDays: 0,
        nightModeForceCloseUntil: '2099-03-05T03:00:00.000Z',
      }),
    );
    expect(chat2Call?.update?.settings?.upsert?.update).toEqual(
      expect.objectContaining({
        nightModeEnabled: true,
        nightModeStartTimeMinutes: 23 * 60,
        nightModeEndTimeMinutes: 6 * 60,
        nightModeTimezone: 'Europe/Moscow',
        nightModeBotMessageEnabled: true,
        nightModeBotMessageText: 'Чат закрыт до утра.',
        nightModeCommentsEnabled: true,
        nightModeOpenMessageEnabled: true,
        nightModeOpenMessageText: 'Чат снова открыт.',
        nightModeBotButtonEnabled: true,
        nightModeBotButtonUrl: 'https://max.ru/maxim',
        nightModeBotButtonText: 'Профиль',
        nightModeRulesButtonEnabled: true,
        nightModeForceCloseEnabled: true,
        nightModeForceCloseForever: false,
        nightModeForceCloseHours: 8,
        nightModeForceCloseDays: 0,
        nightModeForceCloseUntil: '2099-03-05T03:00:00.000Z',
      }),
    );
    expect(chat2Call?.update?.settings?.upsert?.create).toEqual(
      expect.objectContaining({
        nightModeEnabled: true,
        nightModeStartTimeMinutes: 23 * 60,
        nightModeEndTimeMinutes: 6 * 60,
        nightModeTimezone: 'Europe/Moscow',
        nightModeBotMessageEnabled: true,
        nightModeBotMessageText: 'Чат закрыт до утра.',
        nightModeCommentsEnabled: true,
        nightModeOpenMessageEnabled: true,
        nightModeOpenMessageText: 'Чат снова открыт.',
        nightModeBotButtonEnabled: true,
        nightModeBotButtonUrl: 'https://max.ru/maxim',
        nightModeBotButtonText: 'Профиль',
        nightModeRulesButtonEnabled: true,
        nightModeForceCloseEnabled: true,
        nightModeForceCloseForever: false,
        nightModeForceCloseHours: 8,
        nightModeForceCloseDays: 0,
        nightModeForceCloseUntil: '2099-03-05T03:00:00.000Z',
      }),
    );
  });

  it('uses the cached mass-action target set when applying settings to all chats', async () => {
    const prisma = createPrismaMock();
    const service = new AdminService(
      prisma as never,
      {} as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    const settings = chatSettingsSchema.parse({
      greetingEnabled: true,
      greetingBotMessageEnabled: true,
      greetingBotMessageText: 'Привет!',
    });

    jest.spyOn(service, 'assertChatAdmin').mockResolvedValue(undefined);
    jest
      .spyOn(
        service as unknown as {
          ensureEntityType: (...args: unknown[]) => Promise<void>;
        },
        'ensureEntityType',
      )
      .mockResolvedValue(undefined);
    const massScanSpy = jest.spyOn(service, 'listChatsForMassBroadcast').mockResolvedValue([
      createChatSummaryFixture({
        id: 'chat-2',
        title: 'Регион 2',
        createdAt: '2026-03-02T00:00:00.000Z',
        entityType: 'chat',
      }),
    ]);

    const result = await service.applySettingsToAllChats('chat-1', actor, settings);

    expect(massScanSpy).toHaveBeenCalledWith(actor, { discoveryMode: 'cached-first' });
    expect(result).toEqual({
      sourceChatId: 'chat-1',
      updatedChats: 2,
      appliedChatIds: ['chat-1', 'chat-2'],
    });
  });

  it('applies settings only to chats in selected favorite types', async () => {
    const prisma = createPrismaMock();
    const service = new AdminService(
      prisma as never,
      {} as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    const settings = chatSettingsSchema.parse({
      greetingEnabled: true,
      greetingBotMessageEnabled: true,
      greetingBotMessageText: 'Привет!',
    });

    jest.spyOn(service, 'assertChatAdmin').mockResolvedValue(undefined);
    jest
      .spyOn(
        service as unknown as {
          ensureEntityType: (...args: unknown[]) => Promise<void>;
        },
        'ensureEntityType',
      )
      .mockResolvedValue(undefined);
    jest.spyOn(service, 'listChatsForMassBroadcast').mockResolvedValue([
      createChatSummaryFixture({
        id: 'chat-2',
        title: 'Регион 2',
        createdAt: '2026-03-02T00:00:00.000Z',
        entityType: 'chat',
      }),
      createChatSummaryFixture({
        id: 'chat-3',
        title: 'Регион 3',
        createdAt: '2026-03-03T00:00:00.000Z',
        entityType: 'chat',
      }),
    ]);
    prisma.managedEntityFavorite.findMany.mockResolvedValue([
      { chatId: 'chat-2' },
      { chatId: 'chat-3' },
      { chatId: 'chat-2' },
    ]);

    const result = await service.applySettingsToAllChats('chat-1', actor, settings, 'miniapp', {
      mode: 'favoriteTypes',
      favoriteTypes: ['broadcast'],
      chatIds: [],
    });

    expect(prisma.managedEntityFavorite.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: actor.userId,
          entityType: 'CHAT',
          favoriteType: { in: ['BROADCAST'] },
        }),
      }),
    );
    expect(result).toEqual({
      sourceChatId: 'chat-1',
      updatedChats: 2,
      appliedChatIds: ['chat-2', 'chat-3'],
    });
    expect(prisma.chat.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'chat-2' } }),
    );
    expect(prisma.chat.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'chat-3' } }),
    );
    expect(prisma.chat.upsert).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'chat-1' } }),
    );
  });
});
