import { WebhookService } from './webhook.service';

describe('WebhookService', () => {
  const maxBotLinkService = {
    bindChatToBot: jest.fn().mockResolvedValue(undefined),
    getStoredChatPrimaryBotId: jest.fn().mockResolvedValue(null),
    observeStoredChatBotWebhook: jest.fn().mockResolvedValue(undefined),
    markChatBotRemoved: jest.fn().mockResolvedValue(undefined),
  };
  const maxChatAdminRosterSyncService = {
    scheduleChatAdminRosterSync: jest.fn().mockResolvedValue(true),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    maxBotLinkService.bindChatToBot.mockReset();
    maxBotLinkService.bindChatToBot.mockResolvedValue(undefined);
    maxBotLinkService.getStoredChatPrimaryBotId.mockReset();
    maxBotLinkService.getStoredChatPrimaryBotId.mockResolvedValue(null);
    maxBotLinkService.observeStoredChatBotWebhook.mockReset();
    maxBotLinkService.observeStoredChatBotWebhook.mockResolvedValue(undefined);
    maxBotLinkService.markChatBotRemoved.mockReset();
    maxBotLinkService.markChatBotRemoved.mockResolvedValue(undefined);
    maxChatAdminRosterSyncService.scheduleChatAdminRosterSync.mockReset();
    maxChatAdminRosterSyncService.scheduleChatAdminRosterSync.mockResolvedValue(true);
  });

  it('stores new webhook event in RECEIVED state', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-1' }),
        updateMany: jest.fn(),
      },
    };

    const config = {
      get: jest.fn().mockReturnValue(1),
    };

    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
    );
    const result = await service.ingest(
      {
        updateId: 'u-1',
        type: 'message',
      },
      '127.0.0.1',
    );

    expect(result).toEqual({ accepted: true, duplicate: false });
    expect(prisma.webhookEvent.create).toHaveBeenCalledTimes(1);
  });

  it('accepts duplicate events without mutating the original webhook state', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockRejectedValue({ code: 'P2002' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };

    const config = {
      get: jest.fn().mockReturnValue(1),
    };

    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
    );
    const result = await service.ingest(
      {
        updateId: 'u-1',
        type: 'message',
      },
      '127.0.0.1',
    );

    expect(result).toEqual({ accepted: true, duplicate: true });
    expect(prisma.webhookEvent.updateMany).not.toHaveBeenCalled();
  });

  it('retries webhook storage with sanitized payload when Prisma rejects malformed JSON input', async () => {
    const prisma = {
      webhookEvent: {
        create: jest
          .fn()
          .mockRejectedValueOnce({
            code: 'InvalidArg',
            message: 'unexpected end of hex escape at line 1 column 581',
          })
          .mockResolvedValueOnce({ id: 'evt-2' }),
        updateMany: jest.fn(),
      },
    };

    const config = {
      get: jest.fn().mockReturnValue(1),
    };

    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
    );
    const result = await service.ingest(
      {
        updateId: 'u-2',
        type: 'message_callback',
        message: {
          messageId: 'mid-1',
          chatId: 'chat-1',
          senderId: 'user-1',
          text: 'broken-\ud800-text',
          createdAt: new Date('2026-03-26T12:00:00.000Z').toISOString(),
        },
        raw: {
          callback: {
            callback_id: 'callback-1',
            payload: 'poll|poll-1|1|0',
            user: {
              user_id: 'user-1',
            },
          },
          weird: 'broken-\ud800-text',
        },
      },
      '127.0.0.1',
    );

    expect(result).toEqual({ accepted: true, duplicate: false });
    expect(prisma.webhookEvent.create).toHaveBeenCalledTimes(2);
    expect(prisma.webhookEvent.create.mock.calls[1][0]).toEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          normalizedPayload: expect.objectContaining({
            message: expect.objectContaining({
              text: 'broken-\ufffd-text',
            }),
            raw: expect.objectContaining({
              weird: 'broken-\ufffd-text',
            }),
          }),
        }),
      }),
    );
  });

  it('best-effort invalidates membership cache for join and leave events before persistence', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-3' }),
        updateMany: jest.fn(),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };
    const membershipLookup = {
      invalidateMemberships: jest.fn().mockResolvedValue(undefined),
    };

    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
      membershipLookup as never,
    );

    await expect(
      service.ingest(
        {
          updateId: 'u-join-1',
          type: 'user_added',
          message: {
            messageId: 'user_added:u-join-1',
            chatId: 'chat-1',
            senderId: 'user-10',
            text: '',
            createdAt: new Date('2026-03-29T12:00:00.000Z').toISOString(),
          },
          membership: {
            action: 'added',
            memberUserIds: ['user-10'],
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });
    await expect(
      service.ingest(
        {
          updateId: 'u-leave-1',
          type: 'user_removed',
          message: {
            messageId: 'user_removed:u-leave-1',
            chatId: 'chat-1',
            senderId: 'user-10',
            text: '',
            createdAt: new Date('2026-03-29T12:00:01.000Z').toISOString(),
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    expect(membershipLookup.invalidateMemberships).toHaveBeenNthCalledWith(1, 'chat-1', [
      'user-10',
    ]);
    expect(membershipLookup.invalidateMemberships).toHaveBeenNthCalledWith(2, 'chat-1', [
      'user-10',
    ]);
    expect(prisma.webhookEvent.create).toHaveBeenCalledTimes(2);
  });

  it('persists admin read models for membership and managed-entities activity when projection tables are available', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-read-models' }),
        updateMany: jest.fn(),
      },
      chatMembershipActivityEvent: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      managedEntityLocalActivity: {
        upsert: jest.fn().mockResolvedValue({}),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };

    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
    );

    await expect(
      service.ingest(
        {
          updateId: 'u-read-models-1',
          type: 'user_added',
          botId: 'id613002203036_bot',
          message: {
            messageId: 'mid-read-models-1',
            chatId: '-100200',
            chatTitle: 'Новый чат',
            entityType: 'channel',
            senderId: 'user-77',
            senderName: 'Пользователь',
            text: '',
            createdAt: new Date('2026-04-06T00:00:00.000Z').toISOString(),
          },
          membership: {
            action: 'added',
            memberUserIds: ['user-77'],
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });
    await expect(
      service.ingest(
        {
          updateId: 'u-read-models-2',
          type: 'message_created',
          botId: 'id613002203036_bot',
          message: {
            messageId: 'mid-read-models-2',
            chatId: '-100200',
            chatTitle: 'Новый чат',
            entityType: 'channel',
            senderId: 'user-77',
            senderName: 'Пользователь',
            text: 'hello',
            createdAt: new Date('2026-04-06T00:01:00.000Z').toISOString(),
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    expect(prisma.chatMembershipActivityEvent.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          id: 'u-read-models-1',
          dedupeKey: 'membership:user_added:-100200:user-77:mid-read-models-1',
          chatId: '-100200',
          eventType: 'user_added',
          userId: 'user-77',
          senderName: 'Пользователь',
        }),
      ],
      skipDuplicates: true,
    });
    expect(prisma.managedEntityLocalActivity.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId_chatId: {
            userId: 'user-77',
            chatId: '-100200',
          },
        },
      }),
    );
  });

  it('marks bot membership removed instead of rebinding it on bot_removed updates', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-4' }),
        updateMany: jest.fn(),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };
    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
    );

    await expect(
      service.ingest(
        {
          updateId: 'u-bot-removed-1',
          type: 'bot_removed',
          botId: 'id613002203036_4_bot',
          message: {
            messageId: 'bot_removed:u-bot-removed-1',
            chatId: '-100123',
            chatTitle: 'Shared chat',
            entityType: 'channel',
            senderId: 'id613002203036_4_bot',
            text: '',
            createdAt: new Date('2026-03-30T12:00:00.000Z').toISOString(),
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    expect(maxBotLinkService.markChatBotRemoved).toHaveBeenCalledWith({
      chatId: '-100123',
      title: 'Shared chat',
      entityType: 'CHANNEL',
      botId: 'id613002203036_4_bot',
    });
    expect(maxBotLinkService.bindChatToBot).not.toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: '-100123',
        botId: 'id613002203036_4_bot',
      }),
    );
  });

  it('fails over execution owner to the incoming bot from cached snapshots without a live MAX lookup', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-5' }),
        updateMany: jest.fn(),
      },
      chatBotMembership: {
        findUnique: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };
    const maxClient = {
      getCurrentChatMemberAccess: jest.fn(),
    };
    maxBotLinkService.bindChatToBot
      .mockResolvedValueOnce('id613002203036_bot')
      .mockResolvedValueOnce('id613002203036_4_bot');

    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
      undefined,
      maxClient as never,
    );
    (service as any).botSelfAccessCache.set('-100123:id613002203036_bot', {
      canHandleUserFacing: false,
      expiresAtMs: Date.now() + 60_000,
    });
    (service as any).botSelfAccessCache.set('-100123:id613002203036_4_bot', {
      canHandleUserFacing: true,
      expiresAtMs: Date.now() + 60_000,
    });

    await expect(
      service.ingest(
        {
          updateId: 'u-failover-1',
          type: 'message_created',
          botId: 'id613002203036_4_bot',
          message: {
            messageId: 'mid-1',
            chatId: '-100123',
            chatTitle: 'Тестовый чат',
            senderId: 'user-1',
            text: 'https://spam.example',
            createdAt: new Date('2026-03-31T20:00:00.000Z').toISOString(),
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    expect(maxClient.getCurrentChatMemberAccess).not.toHaveBeenCalled();
    expect(maxBotLinkService.bindChatToBot).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        chatId: '-100123',
        botId: 'id613002203036_4_bot',
        allowReassign: true,
      }),
    );
    expect(prisma.webhookEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          normalizedPayload: expect.objectContaining({
            executionOwnerBotId: 'id613002203036_4_bot',
          }),
        }),
      }),
    );
    expect(prisma.chatBotMembership.updateMany).not.toHaveBeenCalled();
  });

  it('defers ordinary message owner failover to an async live recheck when only the current owner snapshot is stale', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-5a' }),
        updateMany: jest.fn(),
      },
      chatBotMembership: {
        findUnique: jest.fn().mockResolvedValue(null),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };
    const maxClient = {
      getCurrentChatMemberAccess: jest
        .fn()
        .mockResolvedValueOnce({
          userId: 'id613002203036_4_bot',
          isAdmin: true,
          isOwner: false,
          permissions: ['delete_messages'],
        }),
    };
    maxBotLinkService.bindChatToBot
      .mockResolvedValueOnce('id613002203036_bot')
      .mockResolvedValueOnce('id613002203036_4_bot');

    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
      undefined,
      maxClient as never,
    );
    (service as any).botSelfAccessCache.set('-100123:id613002203036_bot', {
      canHandleUserFacing: false,
      expiresAtMs: Date.now() + 60_000,
    });

    await expect(
      service.ingest(
        {
          updateId: 'u-failover-async-1',
          type: 'message_created',
          botId: 'id613002203036_4_bot',
          message: {
            messageId: 'mid-1a',
            chatId: '-100123',
            chatTitle: 'Тестовый чат',
            senderId: 'user-1',
            text: 'https://spam.example',
            createdAt: new Date('2026-03-31T20:00:00.000Z').toISOString(),
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    expect(maxBotLinkService.bindChatToBot).toHaveBeenCalledTimes(1);
    expect(prisma.webhookEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          normalizedPayload: expect.objectContaining({
            executionOwnerBotId: 'id613002203036_bot',
          }),
        }),
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledTimes(1);
    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenNthCalledWith(
      1,
      '-100123',
      expect.objectContaining({
        botId: 'id613002203036_4_bot',
        trafficClass: 'interactive',
        timeoutMs: 900,
      }),
    );
    expect(maxBotLinkService.bindChatToBot).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        chatId: '-100123',
        botId: 'id613002203036_4_bot',
        allowReassign: true,
      }),
    );
    expect(prisma.chatBotMembership.updateMany).toHaveBeenCalledTimes(1);
  });

  it('keeps the current owner on ordinary message updates without running a live failover check', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-6' }),
        updateMany: jest.fn(),
      },
      chatBotMembership: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };
    const maxClient = {
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'id613002203036_bot',
        isAdmin: true,
        isOwner: false,
        permissions: ['delete_messages'],
      }),
    };
    maxBotLinkService.bindChatToBot.mockResolvedValueOnce('id613002203036_bot');

    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
      undefined,
      maxClient as never,
    );

    await expect(
      service.ingest(
        {
          updateId: 'u-owner-ok-1',
          type: 'message_created',
          botId: 'id613002203036_4_bot',
          message: {
            messageId: 'mid-2',
            chatId: '-100124',
            chatTitle: 'Shared chat',
            senderId: 'user-2',
            text: 'hello',
            createdAt: new Date('2026-03-31T20:00:01.000Z').toISOString(),
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    expect(maxClient.getCurrentChatMemberAccess).not.toHaveBeenCalled();
    expect(maxBotLinkService.bindChatToBot).toHaveBeenCalledTimes(1);
    expect(prisma.webhookEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          normalizedPayload: expect.objectContaining({
            executionOwnerBotId: 'id613002203036_bot',
          }),
        }),
      }),
    );
  });

  it('reuses the stored chat binding for ordinary mirrored updates without rewriting chat ownership rows', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-6a' }),
        updateMany: jest.fn(),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };
    maxBotLinkService.getStoredChatPrimaryBotId.mockResolvedValueOnce('id613002203036_bot');

    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
    );

    await expect(
      service.ingest(
        {
          updateId: 'u-owner-stored-1',
          type: 'message_created',
          botId: 'id613002203036_4_bot',
          message: {
            messageId: 'mid-2a',
            chatId: '-100124',
            chatTitle: 'Shared chat',
            senderId: 'user-2',
            text: 'hello',
            createdAt: new Date('2026-03-31T20:00:01.000Z').toISOString(),
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    expect(maxBotLinkService.getStoredChatPrimaryBotId).toHaveBeenCalledWith('-100124');
    expect(maxBotLinkService.bindChatToBot).not.toHaveBeenCalled();
    expect(maxBotLinkService.observeStoredChatBotWebhook).toHaveBeenCalledWith({
      chatId: '-100124',
      primaryBotId: 'id613002203036_bot',
      botId: 'id613002203036_4_bot',
    });
    expect(prisma.webhookEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          normalizedPayload: expect.objectContaining({
            executionOwnerBotId: 'id613002203036_bot',
          }),
        }),
      }),
    );
  });

  it('skips the extra observed-membership touch when a stored-binding webhook already triggered owner failover', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-6aa' }),
        updateMany: jest.fn(),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };
    maxBotLinkService.getStoredChatPrimaryBotId.mockResolvedValueOnce('id613002203036_bot');
    maxBotLinkService.bindChatToBot.mockResolvedValueOnce('id613002203036_4_bot');

    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
    );
    (service as any).botSelfAccessCache.set('-100124:id613002203036_bot', {
      canHandleUserFacing: false,
      expiresAtMs: Date.now() + 60_000,
    });
    (service as any).botSelfAccessCache.set('-100124:id613002203036_4_bot', {
      canHandleUserFacing: true,
      expiresAtMs: Date.now() + 60_000,
    });

    await expect(
      service.ingest(
        {
          updateId: 'u-owner-stored-2',
          type: 'message_created',
          botId: 'id613002203036_4_bot',
          message: {
            messageId: 'mid-2b',
            chatId: '-100124',
            chatTitle: 'Shared chat',
            senderId: 'user-2',
            text: 'hello',
            createdAt: new Date('2026-03-31T20:00:02.000Z').toISOString(),
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    expect(maxBotLinkService.bindChatToBot).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: '-100124',
        botId: 'id613002203036_4_bot',
        allowReassign: true,
      }),
    );
    expect(maxBotLinkService.observeStoredChatBotWebhook).not.toHaveBeenCalled();
    expect(prisma.webhookEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          normalizedPayload: expect.objectContaining({
            executionOwnerBotId: 'id613002203036_4_bot',
          }),
        }),
      }),
    );
  });

  it('re-evaluates execution owner on bot lifecycle updates', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-6b' }),
        updateMany: jest.fn(),
      },
      chatBotMembership: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };
    const maxClient = {
      getCurrentChatMemberAccess: jest
        .fn()
        .mockResolvedValueOnce({
          userId: 'id613002203036_bot',
          isAdmin: true,
          isOwner: false,
          permissions: ['can_call'],
        })
        .mockResolvedValueOnce({
          userId: 'id613002203036_4_bot',
          isAdmin: true,
          isOwner: false,
          permissions: ['delete_messages'],
        }),
    };
    maxBotLinkService.bindChatToBot
      .mockResolvedValueOnce('id613002203036_bot')
      .mockResolvedValueOnce('id613002203036_4_bot');

    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
      undefined,
      maxClient as never,
    );

    await expect(
      service.ingest(
        {
          updateId: 'u-bot-added-failover-1',
          type: 'bot_added',
          botId: 'id613002203036_4_bot',
          message: {
            messageId: 'mid-bot-added-1',
            chatId: '-100140',
            chatTitle: 'Shared chat',
            entityType: 'channel',
            senderId: 'id613002203036_4_bot',
            text: '',
            createdAt: new Date('2026-04-06T00:10:00.000Z').toISOString(),
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledTimes(2);
    expect(maxBotLinkService.bindChatToBot).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        chatId: '-100140',
        botId: 'id613002203036_4_bot',
        allowReassign: true,
      }),
    );
  });

  it('propagates webhook entity type into chat binding updates', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-7' }),
        updateMany: jest.fn(),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };
    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
    );

    await expect(
      service.ingest(
        {
          updateId: 'u-entity-type-1',
          type: 'message_created',
          botId: 'id613002203036_bot',
          message: {
            messageId: 'mid-entity-type-1',
            chatId: '-100125',
            chatTitle: 'Новости района',
            entityType: 'channel',
            senderId: 'user-3',
            text: 'hello',
            createdAt: new Date('2026-03-31T20:00:02.000Z').toISOString(),
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    expect(maxBotLinkService.bindChatToBot).toHaveBeenCalledWith({
      chatId: '-100125',
      title: 'Новости района',
      entityType: 'CHANNEL',
      botId: 'id613002203036_bot',
    });
  });

  it('enqueues chat admin roster sync for bot membership churn updates', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-7' }),
        updateMany: jest.fn(),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };
    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
      undefined,
      undefined,
      maxChatAdminRosterSyncService as never,
    );

    await expect(
      service.ingest(
        {
          updateId: 'u-bot-added-1',
          type: 'bot_added',
          botId: 'id613002203036_bot',
          message: {
            messageId: 'bot_added:u-bot-added-1',
            chatId: '-100126',
            chatTitle: 'Новый чат',
            entityType: 'channel',
            senderId: 'id613002203036_bot',
            text: '',
            createdAt: new Date('2026-04-03T12:00:00.000Z').toISOString(),
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    expect(maxChatAdminRosterSyncService.scheduleChatAdminRosterSync).toHaveBeenCalledWith({
      chatId: '-100126',
      botIds: ['id613002203036_bot'],
      title: 'Новый чат',
      entityType: 'channel',
      source: 'webhook_bot_added',
      retryUntilMs: expect.any(Number),
    });
  });

  it('prewarms admin roster snapshots for webhook membership churn updates', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-7a' }),
        updateMany: jest.fn(),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };
    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
      undefined,
      undefined,
      maxChatAdminRosterSyncService as never,
    );

    await expect(
      service.ingest(
        {
          updateId: 'u-user-added-1',
          type: 'user_added',
          botId: 'id613002203036_bot',
          message: {
            messageId: 'user_added:u-user-added-1',
            chatId: '-100127',
            chatTitle: 'Новый участник',
            entityType: 'chat',
            senderId: 'user-10',
            text: '',
            createdAt: new Date('2026-04-03T12:05:00.000Z').toISOString(),
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    expect(maxChatAdminRosterSyncService.scheduleChatAdminRosterSync).toHaveBeenCalledWith({
      chatId: '-100127',
      botIds: ['id613002203036_bot'],
      title: 'Новый участник',
      entityType: 'chat',
      source: 'webhook_membership_churn',
      retryUntilMs: null,
    });
  });
});
