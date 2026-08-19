import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { AdminService } from './admin.service';
import {
  createChatContextCacheMock,
  createConfigMock,
  createPrismaMock,
  flushAsyncTasks,
} from './admin-service-test-support';

describe('AdminService admin access validation', () => {
  const user = {
    userId: 'admin-1',
    username: null,
    displayName: null,
    chatTitle: null,
  };

  it('deduplicates concurrent admin checks for the same chat and user', async () => {
    const prisma = createPrismaMock();
    const chatContextCache = createChatContextCacheMock();
    let resolveAdminIds!: (value: string[]) => void;
    const maxClient = {
      getChatAdminIds: jest.fn().mockImplementation(
        () =>
          new Promise<string[]>((resolve) => {
            resolveAdminIds = resolve;
          }),
      ),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const pending = [
      service.assertChatAdmin('chat-1', user.userId, 'chat'),
      service.assertChatAdmin('chat-1', user.userId, 'chat'),
      service.assertChatAdmin('chat-1', user.userId, 'chat'),
    ];

    await flushAsyncTasks();
    await flushAsyncTasks();
    if (!resolveAdminIds) {
      throw new Error('resolveAdminIds was not initialized');
    }
    resolveAdminIds(['admin-1']);
    await expect(Promise.all(pending)).resolves.toEqual([undefined, undefined, undefined]);
    expect(maxClient.getChatAdminIds).toHaveBeenCalledTimes(1);
  });

  it('validates base admin access via the full MAX admin list', async () => {
    const prisma = createPrismaMock();
    const chatContextCache = createChatContextCacheMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getChatEditableAdminIds: jest.fn().mockResolvedValue([]),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await expect(service.assertChatAdmin('chat-1', user.userId, 'chat')).resolves.toBeUndefined();
    expect(maxClient.getChatAdminIds).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({
        actionHealthLane: 'background',
      }),
    );
    expect(maxClient.getChatEditableAdminIds).not.toHaveBeenCalled();
  });

  it('treats a concurrent persisted admin allowlist insert as idempotent', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.upsert.mockRejectedValueOnce({ code: 'P2002' });
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    await expect(service.assertChatAdmin('chat-1', user.userId, 'chat')).resolves.toBeUndefined();
    expect(prisma.chatAdminAllowlist.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          chatId_userId: {
            chatId: 'chat-1',
            userId: 'admin-1',
          },
        },
      }),
    );
  });

  it('rechecks stale bot_denied cache before rejecting admin access', async () => {
    const prisma = createPrismaMock();
    const chatContextCache = createChatContextCacheMock({
      getAdminAccess: jest.fn().mockResolvedValue('bot_denied'),
    });
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await expect(service.assertChatAdmin('chat-1', user.userId, 'chat')).resolves.toBeUndefined();
    expect(maxClient.getChatAdminIds).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({
        actionHealthLane: 'background',
      }),
    );
  });

  it('rechecks stale user_denied cache before rejecting admin access', async () => {
    const prisma = createPrismaMock();
    const chatContextCache = createChatContextCacheMock({
      getAdminAccess: jest.fn().mockResolvedValue('user_denied'),
    });
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await expect(service.assertChatAdmin('chat-1', user.userId, 'chat')).resolves.toBeUndefined();
    expect(maxClient.getChatAdminIds).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({
        actionHealthLane: 'background',
      }),
    );
  });

  it('fails closed on transient MAX admin check failures for mutating access', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([{ chatId: 'chat-1' }]);
    const chatContextCache = createChatContextCacheMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockRejectedValue(
        Object.assign(new Error('timeout of 5000ms exceeded'), {
          code: 'ECONNABORTED',
        }),
      ),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await expect(service.assertChatAdmin('chat-1', user.userId, 'chat')).rejects.toThrow(
      ServiceUnavailableException,
    );
    expect(chatContextCache.setAdminAccess).not.toHaveBeenCalled();
    expect(prisma.chatAdminAllowlist.findMany).not.toHaveBeenCalled();
    expect(prisma.chatAdminAllowlist.deleteMany).not.toHaveBeenCalled();
  });

  it('does not accept a fresh access edge when strict MAX validation reports bot denied', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      id: 'chat-1',
      title: 'Команда MAX',
      entityType: 'CHAT',
      primaryBotId: 'bot-primary',
      botId: null,
      botMemberships: [{ botId: 'bot-primary' }],
    });
    (prisma as any).managedEntityAccessEdge = {
      findMany: jest.fn().mockResolvedValue([{ chatId: 'chat-1', botId: 'bot-primary' }]),
    };
    (prisma as any).chatBotMembership = {
      findMany: jest.fn().mockResolvedValue([{ chatId: 'chat-1', botId: 'bot-primary' }]),
    };
    const chatContextCache = createChatContextCacheMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockRejectedValue({
        response: {
          status: 403,
          data: {
            code: 'chat.denied',
            message: 'Bot is not a chat member',
          },
        },
      }),
    };
    const maxBotRegistry = {
      getBotById: jest.fn((botId: string | null | undefined) =>
        botId ? { id: botId, state: 'active' } : null,
      ),
      getAllBots: jest.fn().mockReturnValue([{ id: 'bot-primary' }]),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock({ botId: 'bot-primary' }) as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      maxBotRegistry as never,
    );

    await expect(
      service.assertChatAdmin('chat-1', user.userId, 'chat', {
        allowPersistedFallback: false,
      }),
    ).rejects.toThrow(ForbiddenException);
    expect((prisma as any).managedEntityAccessEdge.findMany).not.toHaveBeenCalled();
    expect(chatContextCache.setAdminAccess).toHaveBeenCalledWith(
      'chat-1',
      user.userId,
      'bot_denied',
    );
  });

  it('rechecks cached granted access and rejects a removed managed-entity admin', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([{ chatId: 'chat-1' }]);
    const chatContextCache = createChatContextCacheMock({
      getAdminAccess: jest.fn().mockResolvedValue('granted'),
    });
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue([]),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await expect(
      service.assertManagedEntityAdminAccess('chat-1', user.userId, 'chat'),
    ).rejects.toThrow(ForbiddenException);

    expect(maxClient.getChatAdminIds).toHaveBeenCalledTimes(1);
    expect(chatContextCache.setAdminAccess).toHaveBeenCalledWith(
      'chat-1',
      user.userId,
      'user_denied',
    );
    expect(prisma.chatAdminAllowlist.deleteMany).toHaveBeenCalledWith({
      where: { chatId: 'chat-1', userId: user.userId },
    });
  });

  it('returns 503 for managed mutations when MAX fails despite an old allowlist row', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([{ chatId: 'chat-1' }]);
    const maxClient = {
      getChatAdminIds: jest.fn().mockRejectedValue(
        Object.assign(new Error('timeout of 5000ms exceeded'), {
          code: 'ECONNABORTED',
        }),
      ),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    await expect(
      service.assertManagedEntityAdminAccess('chat-1', user.userId, 'chat'),
    ).rejects.toThrow(ServiceUnavailableException);
    expect(prisma.chatAdminAllowlist.findMany).not.toHaveBeenCalled();
  });

  it('keeps checking candidate bots until one confirms the current admin', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      id: 'chat-1',
      title: 'Команда MAX',
      entityType: 'CHAT',
      primaryBotId: 'bot-primary',
      botId: null,
      botMemberships: [{ botId: 'bot-primary' }, { botId: 'bot-secondary' }],
    });
    const maxClient = {
      getChatAdminIds: jest
        .fn()
        .mockRejectedValueOnce({
          response: {
            status: 403,
            data: { code: 'chat.denied', message: 'Bot is not a chat member' },
          },
        })
        .mockResolvedValueOnce([user.userId]),
    };
    const maxBotRegistry = {
      getBotById: jest.fn((botId: string | null | undefined) =>
        botId ? { id: botId, state: 'active' } : null,
      ),
      getAllBots: jest.fn().mockReturnValue([{ id: 'bot-primary' }, { id: 'bot-secondary' }]),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock({ botId: 'bot-primary' }) as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      maxBotRegistry as never,
    );

    await expect(
      service.assertManagedEntityAdminAccess('chat-1', user.userId, 'chat'),
    ).resolves.toBeUndefined();
    expect(maxClient.getChatAdminIds).toHaveBeenCalledTimes(2);
    expect(maxClient.getChatAdminIds).toHaveBeenNthCalledWith(
      2,
      'chat-1',
      expect.objectContaining({ botId: 'bot-secondary' }),
    );
  });

  it('rechecks cached granted access for managed-entity reads', async () => {
    const prisma = createPrismaMock();
    const chatContextCache = createChatContextCacheMock({
      getAdminAccess: jest.fn().mockResolvedValue('granted'),
    });
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue([]),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await expect(
      service.assertManagedEntityReadAccess('chat-1', user.userId, 'chat'),
    ).rejects.toThrow(ForbiddenException);
    expect(maxClient.getChatAdminIds).toHaveBeenCalledTimes(1);
  });

  it('returns 503 instead of false 403 when MAX admin check transiently fails without fallback', async () => {
    const prisma = createPrismaMock();
    const chatContextCache = createChatContextCacheMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockRejectedValue(
        Object.assign(new Error('timeout of 5000ms exceeded'), {
          code: 'ECONNABORTED',
        }),
      ),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await expect(service.assertChatAdmin('chat-1', user.userId, 'chat')).rejects.toThrow(
      ServiceUnavailableException,
    );
    expect(chatContextCache.setAdminAccess).not.toHaveBeenCalled();
  });

  it('does not cache bot_denied when one candidate bot is transiently unavailable', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      id: 'chat-1',
      title: 'Команда MAX',
      entityType: 'CHAT',
      primaryBotId: 'bot-primary',
      botId: null,
      botMemberships: [{ botId: 'bot-primary' }, { botId: 'bot-standby' }],
    });
    const chatContextCache = createChatContextCacheMock();
    const maxClient = {
      getChatAdminIds: jest
        .fn()
        .mockRejectedValueOnce(
          Object.assign(new Error('timeout of 5000ms exceeded'), {
            code: 'ECONNABORTED',
          }),
        )
        .mockRejectedValueOnce({
          response: {
            status: 403,
            data: {
              code: 'chat.denied',
              message: 'Bot is not a chat member',
            },
          },
        }),
    };
    const maxBotRegistry = {
      getBotById: jest.fn((botId: string | null | undefined) =>
        botId ? { id: botId, state: 'active' } : null,
      ),
      getAllBots: jest.fn().mockReturnValue([{ id: 'bot-primary' }, { id: 'bot-standby' }]),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock({ botId: 'bot-primary' }) as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      maxBotRegistry as never,
    );

    await expect(service.assertChatAdmin('chat-1', user.userId, 'chat')).rejects.toThrow(
      ServiceUnavailableException,
    );
    expect(maxClient.getChatAdminIds).toHaveBeenCalledTimes(2);
    expect(chatContextCache.setAdminAccess).not.toHaveBeenCalledWith(
      'chat-1',
      user.userId,
      'bot_denied',
    );
    expect(prisma.chatAdminAllowlist.deleteMany).not.toHaveBeenCalled();
  });

  it('cleans stale allowlist rows when MAX says bot no longer has access to the chat', async () => {
    const prisma = createPrismaMock();
    let accessState: 'bot_denied' | null = null;
    const chatContextCache = createChatContextCacheMock({
      getAdminAccess: jest.fn().mockImplementation(async () => accessState),
      setAdminAccess: jest
        .fn()
        .mockImplementation(async (_chatId: string, _userId: string, state: 'bot_denied') => {
          accessState = state;
        }),
    });
    const maxClient = {
      getChatAdminIds: jest.fn().mockRejectedValue({
        response: {
          status: 403,
          data: {
            code: 'chat.denied',
            message: 'Bot is not a chat member',
          },
        },
      }),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await expect(service.assertChatAdmin('chat-1', user.userId, 'chat')).rejects.toThrow(
      ForbiddenException,
    );
    await expect(service.assertChatAdmin('chat-1', user.userId, 'chat')).rejects.toThrow(
      'Действие недоступно: бот больше не состоит в этом чате MAX или утратил права администратора.',
    );
    expect(maxClient.getChatAdminIds).toHaveBeenCalledTimes(2);
  });

  it('rechecks cached granted access before reading moderation events', async () => {
    const prisma = createPrismaMock();
    prisma.moderationEvent.findMany.mockResolvedValue([]);
    const chatContextCache = createChatContextCacheMock({
      getAdminAccess: jest.fn().mockResolvedValue('granted'),
    });
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue([]),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await expect(service.getEvents('chat-1', user, {})).rejects.toThrow(ForbiddenException);

    expect(maxClient.getChatAdminIds).toHaveBeenCalledTimes(1);
    expect(prisma.chat.upsert).not.toHaveBeenCalled();
    expect(prisma.chatAdminAllowlist.upsert).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.findMany).not.toHaveBeenCalled();
  });

  it('warms admin context and roster after read-only miniapp validation confirms a new admin', async () => {
    const prisma = createPrismaMock();
    prisma.moderationEvent.findMany.mockResolvedValue([]);
    const chatContextCache = createChatContextCacheMock({
      getAdminAccess: jest.fn().mockResolvedValue(null),
      setAdminAccess: jest.fn().mockResolvedValue(undefined),
      rememberChatAdminUser: jest.fn().mockResolvedValue(undefined),
    });
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };
    const maxChatAdminRosterSyncService = {
      scheduleChatAdminRosterSync: jest.fn().mockResolvedValue(true),
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
      undefined,
      undefined,
      undefined,
      undefined,
      maxChatAdminRosterSyncService as never,
    );

    await expect(service.getEvents('chat-1', user, {})).resolves.toEqual([]);
    await flushAsyncTasks();

    expect(chatContextCache.setAdminAccess).toHaveBeenCalledWith('chat-1', 'admin-1', 'granted');
    expect(chatContextCache.rememberChatAdminUser).toHaveBeenCalledWith('chat-1', 'admin-1');
    expect(maxChatAdminRosterSyncService.scheduleChatAdminRosterSync).toHaveBeenCalledWith({
      chatId: 'chat-1',
      entityType: null,
      source: 'admin_access_validation',
      retryUntilMs: null,
    });
    expect(prisma.chatAdminAllowlist.upsert).not.toHaveBeenCalled();
  });
});
