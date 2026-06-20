import { WebhookService } from './webhook.service';

describe('WebhookService', () => {
  const flushDeferredWebhookWork = async () => {
    await new Promise<void>((resolve) => setImmediate(resolve));
  };

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

  it('defers the Старт handshake after storing the webhook event', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-start' }),
        updateMany: jest.fn(),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(0),
    };
    const handshake = {
      handleWebhookUpdate: jest.fn().mockResolvedValue('connected'),
    };

    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
      undefined,
      undefined,
      undefined,
      undefined,
      handshake as never,
    );
    const update = {
      updateId: 'u-start-1',
      botId: 'bot-1',
      type: 'message_created',
      message: {
        messageId: 'm-start-1',
        chatId: '-100',
        chatTitle: 'Команда MAX',
        senderId: 'admin-1',
        text: 'Старт',
        createdAt: '2026-06-20T12:00:00.000Z',
      },
    };

    await expect(service.ingest(update, '127.0.0.1')).resolves.toEqual({
      accepted: true,
      duplicate: false,
    });
    await flushDeferredWebhookWork();

    expect(handshake.handleWebhookUpdate).toHaveBeenCalledWith(update);
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

  it('retries webhook storage with sanitized payload on Prisma json syntax errors', async () => {
    const prisma = {
      webhookEvent: {
        create: jest
          .fn()
          .mockRejectedValueOnce({
            code: 'P2007',
            message: 'Invalid input value: invalid input syntax for type json',
          })
          .mockResolvedValueOnce({ id: 'evt-2b' }),
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
        updateId: 'u-2b',
        type: 'message_created',
        message: {
          messageId: 'mid-2',
          chatId: 'chat-1',
          senderId: 'user-1',
          text: 'bad-\ud800-json',
          createdAt: new Date('2026-03-26T12:00:00.000Z').toISOString(),
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
              text: 'bad-\ufffd-json',
            }),
          }),
        }),
      }),
    );
  });

  it('does not wait for deferred membership invalidation or admin read models before accepting webhook events', async () => {
    const neverSettles = new Promise<never>(() => undefined);
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-3' }),
        updateMany: jest.fn(),
      },
      chatMembershipActivityEvent: {
        createMany: jest.fn().mockReturnValue(neverSettles),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };
    const membershipLookup = {
      invalidateMemberships: jest.fn().mockReturnValue(neverSettles),
    };

    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
      membershipLookup as never,
    );

    await expect(
      Promise.race([
        service
          .ingest(
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
          )
          .then((result) => ({ kind: 'accepted', result })),
        new Promise((resolve) => {
          setTimeout(() => resolve({ kind: 'timeout' }), 25);
        }),
      ]),
    ).resolves.toEqual({
      kind: 'accepted',
      result: { accepted: true, duplicate: false },
    });

    expect(prisma.webhookEvent.create).toHaveBeenCalledTimes(1);
  });

  it('best-effort invalidates membership cache for join and leave events after webhook persistence', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-3b' }),
        updateMany: jest.fn(),
      },
      managedEntityAccessEdge: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
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

    await flushDeferredWebhookWork();

    expect(membershipLookup.invalidateMemberships).toHaveBeenNthCalledWith(1, 'chat-1', [
      'user-10',
    ]);
    expect(membershipLookup.invalidateMemberships).toHaveBeenNthCalledWith(2, 'chat-1', [
      'user-10',
    ]);
    expect(prisma.managedEntityAccessEdge.updateMany).toHaveBeenCalledWith({
      where: {
        chatId: 'chat-1',
        userId: {
          in: ['user-10'],
        },
      },
      data: expect.objectContaining({
        state: 'USER_DENIED',
        userRole: 'MEMBER',
        botRole: 'UNKNOWN',
        expiresAt: null,
        deniedReason: 'webhook_user_removed',
        source: 'webhook_user_removed',
      }),
    });
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

    await flushDeferredWebhookWork();

    expect(prisma.chatMembershipActivityEvent.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          id: 'u-read-models-1',
          dedupeKey: 'membership:user_added:-100200:user-77:2026-04-06T00:00:00.000Z',
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
        create: expect.objectContaining({
          sourceEventType: 'user_added',
        }),
      }),
    );
    expect(prisma.managedEntityLocalActivity.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId_chatId: {
            userId: 'user-77',
            chatId: '-100200',
          },
        },
        create: expect.objectContaining({
          sourceEventType: 'message_created',
        }),
      }),
    );
  });

  it('uses the same membership dedupe key for equivalent join events from different bots', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-membership-dedupe' }),
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

    await service.ingest(
      {
        updateId: 'u-membership-dedupe-1',
        type: 'user_added',
        botId: 'id613002203036_bot',
        message: {
          messageId: 'mid-membership-dedupe-1',
          chatId: '-100333',
          senderId: 'user-88',
          senderName: 'Ольга',
          text: '',
          createdAt: new Date('2026-04-06T01:00:00.000Z').toISOString(),
        },
        membership: {
          action: 'added',
          memberUserIds: ['user-88'],
        },
      },
      '127.0.0.1',
    );

    await flushDeferredWebhookWork();

    await service.ingest(
      {
        updateId: 'u-membership-dedupe-2',
        type: 'user_added',
        botId: 'id613002203036_4_bot',
        message: {
          messageId: 'mid-membership-dedupe-2',
          chatId: '-100333',
          senderId: 'user-88',
          senderName: 'Ольга',
          text: '',
          createdAt: new Date('2026-04-06T01:00:00.000Z').toISOString(),
        },
        membership: {
          action: 'added',
          memberUserIds: ['user-88'],
        },
      },
      '127.0.0.1',
    );

    await flushDeferredWebhookWork();

    const firstCall = prisma.chatMembershipActivityEvent.createMany.mock.calls[0]?.[0];
    const secondCall = prisma.chatMembershipActivityEvent.createMany.mock.calls[1]?.[0];

    expect(firstCall?.data?.[0]?.dedupeKey).toBe(
      'membership:user_added:-100333:user-88:2026-04-06T01:00:00.000Z',
    );
    expect(secondCall?.data?.[0]?.dedupeKey).toBe(
      'membership:user_added:-100333:user-88:2026-04-06T01:00:00.000Z',
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

  it('marks the removed bot from MAX bot_removed payload when another bot receives the event', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-4b' }),
        updateMany: jest.fn(),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };
    maxBotLinkService.markChatBotRemoved.mockResolvedValueOnce('id613002203036_bot');
    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
    );

    await expect(
      service.ingest(
        {
          updateId: 'u-bot-removed-cross-bot-1',
          type: 'bot_removed',
          botId: 'id613002203036_bot',
          message: {
            messageId: 'bot_removed:u-bot-removed-cross-bot-1',
            chatId: '-73729721862151',
            chatTitle: 'Пантера',
            entityType: 'chat',
            senderId: '214634783',
            senderName: 'Майор Максимова',
            text: '',
            createdAt: new Date('2026-05-10T02:10:01.411Z').toISOString(),
          },
          raw: {
            update_type: 'bot_removed',
            chat_id: -73729721862151,
            user_id: 214634783,
            user: {
              user_id: 214634783,
              username: 'id613002203036_4_bot',
              name: 'Майор Максимова',
              is_bot: true,
            },
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    expect(maxBotLinkService.markChatBotRemoved).toHaveBeenCalledWith({
      chatId: '-73729721862151',
      title: 'Пантера',
      entityType: 'CHAT',
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
      getCurrentChatMemberAccess: jest.fn().mockResolvedValueOnce({
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

  it('refreshes the execution owner inline for group admin moderation commands', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-command-failover' }),
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
      getCurrentChatMemberAccess: jest
        .fn()
        .mockResolvedValueOnce({
          userId: 'id613002203036_4_bot',
          isAdmin: false,
          isOwner: false,
          permissions: [],
        })
        .mockResolvedValueOnce({
          userId: 'id613002203036_bot',
          isAdmin: true,
          isOwner: false,
          permissions: ['add_remove_members'],
        }),
    };
    maxBotLinkService.getStoredChatPrimaryBotId.mockResolvedValueOnce('id613002203036_4_bot');
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
          updateId: 'u-command-failover-1',
          type: 'message_created',
          botId: 'id613002203036_bot',
          message: {
            messageId: 'mid-command-ban-1',
            chatId: '-73729721862151',
            chatTitle: 'Пантера',
            senderId: '98315271',
            text: 'Бан',
            createdAt: new Date('2026-05-10T03:00:26.996Z').toISOString(),
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledTimes(2);
    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenNthCalledWith(
      1,
      '-73729721862151',
      expect.objectContaining({
        botId: 'id613002203036_4_bot',
        trafficClass: 'interactive',
        timeoutMs: 900,
      }),
    );
    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenNthCalledWith(
      2,
      '-73729721862151',
      expect.objectContaining({
        botId: 'id613002203036_bot',
        trafficClass: 'interactive',
        timeoutMs: 900,
      }),
    );
    expect(maxBotLinkService.bindChatToBot).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: '-73729721862151',
        botId: 'id613002203036_bot',
        allowReassign: true,
      }),
    );
    expect(prisma.webhookEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          normalizedPayload: expect.objectContaining({
            executionOwnerBotId: 'id613002203036_bot',
          }),
        }),
      }),
    );
    expect(prisma.chatBotMembership.updateMany).toHaveBeenCalledTimes(2);
  });

  it('refreshes the execution owner inline for custom linked admin commands', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-custom-command-failover' }),
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
      getCurrentChatMemberAccess: jest
        .fn()
        .mockResolvedValueOnce({
          userId: 'id613002203036_4_bot',
          isAdmin: false,
          isOwner: false,
          permissions: [],
        })
        .mockResolvedValueOnce({
          userId: 'id613002203036_bot',
          isAdmin: true,
          isOwner: false,
          permissions: ['add_remove_members'],
        }),
    };
    maxBotLinkService.getStoredChatPrimaryBotId.mockResolvedValueOnce('id613002203036_4_bot');
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
          updateId: 'u-custom-command-failover-1',
          type: 'message_created',
          botId: 'id613002203036_bot',
          message: {
            messageId: 'mid-custom-command-ban-1',
            chatId: '-73729721862151',
            chatTitle: 'Пантера',
            senderId: '98315271',
            text: 'заблокировать',
            createdAt: new Date('2026-05-10T03:00:26.996Z').toISOString(),
          },
          raw: {
            message: {
              link: {
                type: 'reply',
                sender: {
                  user_id: 'user-2',
                },
              },
            },
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledTimes(2);
    expect(maxBotLinkService.bindChatToBot).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: '-73729721862151',
        botId: 'id613002203036_bot',
        allowReassign: true,
      }),
    );
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

  it('refreshes the execution owner inline for developer super ban commands', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-super-ban-failover' }),
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
      getCurrentChatMemberAccess: jest
        .fn()
        .mockResolvedValueOnce({
          userId: 'id613002203036_4_bot',
          isAdmin: false,
          isOwner: false,
          permissions: [],
        })
        .mockResolvedValueOnce({
          userId: 'id613002203036_bot',
          isAdmin: true,
          isOwner: false,
          permissions: ['add_remove_members'],
        }),
    };
    maxBotLinkService.getStoredChatPrimaryBotId.mockResolvedValueOnce('id613002203036_4_bot');
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
          updateId: 'u-super-ban-failover-1',
          type: 'message_created',
          botId: 'id613002203036_bot',
          message: {
            messageId: 'mid-command-super-ban-1',
            chatId: '-73729721862151',
            chatTitle: 'Пантера',
            senderId: '98315271',
            text: 'Супер бан',
            createdAt: new Date('2026-05-10T03:00:26.996Z').toISOString(),
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledTimes(2);
    expect(maxBotLinkService.bindChatToBot).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: '-73729721862151',
        botId: 'id613002203036_bot',
        allowReassign: true,
      }),
    );
  });

  it('bypasses stale cached bot access states for group admin moderation commands', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-command-cache-bypass' }),
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
      getCurrentChatMemberAccess: jest
        .fn()
        .mockResolvedValueOnce({
          userId: 'id613002203036_bot',
          isAdmin: false,
          isOwner: false,
          permissions: [],
        })
        .mockResolvedValueOnce({
          userId: 'id613002203036_4_bot',
          isAdmin: true,
          isOwner: false,
          permissions: ['add_remove_members'],
        }),
    };
    maxBotLinkService.getStoredChatPrimaryBotId.mockResolvedValueOnce('id613002203036_bot');
    maxBotLinkService.bindChatToBot.mockResolvedValueOnce('id613002203036_4_bot');

    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
      undefined,
      maxClient as never,
    );
    (service as any).botSelfAccessCache.set('-73729721862151:id613002203036_bot', {
      canHandleUserFacing: true,
      expiresAtMs: Date.now() + 60_000,
    });
    (service as any).botSelfAccessCache.set('-73729721862151:id613002203036_4_bot', {
      canHandleUserFacing: false,
      expiresAtMs: Date.now() + 60_000,
    });

    await expect(
      service.ingest(
        {
          updateId: 'u-command-cache-bypass-1',
          type: 'message_created',
          botId: 'id613002203036_4_bot',
          message: {
            messageId: 'mid-command-ban-2',
            chatId: '-73729721862151',
            chatTitle: 'Пантера',
            senderId: '98315271',
            text: 'Бан',
            createdAt: new Date('2026-05-10T03:11:32.471Z').toISOString(),
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledTimes(2);
    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenNthCalledWith(
      1,
      '-73729721862151',
      expect.objectContaining({
        botId: 'id613002203036_bot',
        trafficClass: 'interactive',
        timeoutMs: 900,
      }),
    );
    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenNthCalledWith(
      2,
      '-73729721862151',
      expect.objectContaining({
        botId: 'id613002203036_4_bot',
        trafficClass: 'interactive',
        timeoutMs: 900,
      }),
    );
    expect(maxBotLinkService.bindChatToBot).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: '-73729721862151',
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
    expect(prisma.chatBotMembership.updateMany).toHaveBeenCalledTimes(2);
  });

  it('promotes the incoming bot inline on membership churn when the stored owner lost admin rights', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-membership-failover' }),
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
      getCurrentChatMemberAccess: jest
        .fn()
        .mockResolvedValueOnce({
          userId: 'id613002203036_bot',
          isAdmin: false,
          isOwner: false,
          permissions: [],
        })
        .mockResolvedValueOnce({
          userId: 'id613002203036_4_bot',
          isAdmin: true,
          isOwner: false,
          permissions: ['delete_messages'],
        }),
    };
    maxBotLinkService.getStoredChatPrimaryBotId.mockResolvedValueOnce('id613002203036_bot');
    maxBotLinkService.bindChatToBot.mockResolvedValueOnce('id613002203036_4_bot');

    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
      undefined,
      maxClient as never,
    );
    (service as any).botSelfAccessCache.set('-73729721862151:id613002203036_bot', {
      canHandleUserFacing: true,
      expiresAtMs: Date.now() + 60_000,
    });

    await expect(
      service.ingest(
        {
          updateId: 'u-membership-failover-1',
          type: 'user_added',
          botId: 'id613002203036_4_bot',
          message: {
            messageId: 'user_added:u-membership-failover-1',
            chatId: '-73729721862151',
            chatTitle: 'Пантера',
            entityType: 'chat',
            senderId: '98315271',
            senderName: 'Новый админ',
            text: '',
            createdAt: new Date('2026-05-10T03:21:00.000Z').toISOString(),
          },
          membership: {
            action: 'added',
            memberUserIds: ['98315271'],
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledTimes(2);
    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenNthCalledWith(
      1,
      '-73729721862151',
      expect.objectContaining({
        botId: 'id613002203036_bot',
        trafficClass: 'interactive',
        timeoutMs: 900,
      }),
    );
    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenNthCalledWith(
      2,
      '-73729721862151',
      expect.objectContaining({
        botId: 'id613002203036_4_bot',
        trafficClass: 'interactive',
        timeoutMs: 900,
      }),
    );
    expect(maxBotLinkService.bindChatToBot).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: '-73729721862151',
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
    expect(prisma.chatBotMembership.updateMany).toHaveBeenCalledTimes(2);
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

  it('stages bot_added chats in the inline recent bootstrap cache before deferred read-model writes finish', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-7-cache' }),
        updateMany: jest.fn(),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };
    const chatContextCache = {
      upsertManagedEntitiesRecentBootstrap: jest.fn().mockResolvedValue(undefined),
    };
    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
      undefined,
      undefined,
      undefined,
      chatContextCache as never,
    );

    await expect(
      service.ingest(
        {
          updateId: 'u-bot-added-cache-1',
          type: 'bot_added',
          botId: 'id613002203036_bot',
          message: {
            messageId: 'bot_added:u-bot-added-cache-1',
            chatId: '-100128',
            chatTitle: 'Кэшируемый чат',
            entityType: 'channel',
            senderId: 'user-77',
            text: '',
            createdAt: new Date('2026-04-03T12:02:00.000Z').toISOString(),
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    expect(chatContextCache.upsertManagedEntitiesRecentBootstrap).toHaveBeenCalledWith(
      {
        id: '-100128',
        title: 'Кэшируемый чат',
        createdAt: new Date('2026-04-03T12:02:00.000Z').toISOString(),
        entityType: 'channel',
        link: null,
        primaryBotId: 'id613002203036_bot',
        assignedBots: [],
        sharedMode: 'owned',
        channelOverview: null,
      },
      15 * 60,
      'user-77',
    );
  });

  it('sends a throttled Старт hint after bot_added webhooks', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-7-hint' }),
        updateMany: jest.fn(),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };
    const maxClient = {
      sendMessageImmediateWithId: jest.fn().mockResolvedValue({ messageId: 'hint-1', url: null }),
    };
    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
      undefined,
      maxClient as never,
    );
    const update = {
      updateId: 'u-bot-added-hint-1',
      type: 'bot_added',
      botId: 'id613002203036_bot',
      message: {
        messageId: 'bot_added:u-bot-added-hint-1',
        chatId: '-100129',
        chatTitle: 'Чат с подсказкой',
        entityType: 'chat',
        senderId: 'id613002203036_bot',
        text: '',
        createdAt: new Date('2026-04-03T12:03:00.000Z').toISOString(),
      },
    };

    await expect(service.ingest(update as never, '127.0.0.1')).resolves.toEqual({
      accepted: true,
      duplicate: false,
    });
    await flushDeferredWebhookWork();

    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledWith(
      '-100129',
      'Чтобы подключить чат к панели, администратор должен написать ровно: Старт',
      expect.objectContaining({
        buttons: [
          [
            expect.objectContaining({
              text: 'Старт',
              type: 'callback',
              payload: 'managed_entity_handshake:start_hint',
            }),
          ],
        ],
      }),
      expect.objectContaining({
        botId: 'id613002203036_bot',
        sourceTag: 'managed_handshake',
      }),
    );

    await expect(
      service.ingest({ ...update, updateId: 'u-bot-added-hint-2' } as never, '127.0.0.1'),
    ).resolves.toEqual({
      accepted: true,
      duplicate: false,
    });
    await flushDeferredWebhookWork();

    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledTimes(1);
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

  it('does not enqueue admin roster sync for private direct membership updates', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-private-1' }),
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
          updateId: 'u-private-bot-started-1',
          type: 'bot_started',
          botId: 'id613002203036_bot',
          message: {
            messageId: 'bot_started:u-private-bot-started-1',
            chatId: '214007512',
            senderId: '214007512',
            text: '',
            createdAt: new Date('2026-04-03T12:07:00.000Z').toISOString(),
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    expect(maxChatAdminRosterSyncService.scheduleChatAdminRosterSync).not.toHaveBeenCalled();
  });
});
