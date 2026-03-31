import { WebhookService } from './webhook.service';

describe('WebhookService', () => {
  const maxBotLinkService = {
    bindChatToBot: jest.fn().mockResolvedValue(undefined),
    markChatBotRemoved: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    maxBotLinkService.bindChatToBot.mockResolvedValue(undefined);
    maxBotLinkService.markChatBotRemoved.mockResolvedValue(undefined);
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
      botId: 'id613002203036_4_bot',
    });
    expect(maxBotLinkService.bindChatToBot).not.toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: '-100123',
        botId: 'id613002203036_4_bot',
      }),
    );
  });

  it('fails over execution owner to the incoming bot when the stored primary loses moderation access', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-5' }),
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
          permissions: ['write', 'read_all_messages'],
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

    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenNthCalledWith(
      1,
      '-100123',
      expect.objectContaining({
        botId: 'id613002203036_bot',
        trafficClass: 'interactive',
        timeoutMs: 900,
      }),
    );
    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenNthCalledWith(
      2,
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

  it('keeps the current owner when it still has moderation access', async () => {
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

    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledTimes(1);
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
});
