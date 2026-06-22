import {
  ChatBotMembershipRole,
  ChatBotMembershipStatus,
  ChatEntityType,
  ManagedEntityAccessState,
  ManagedEntityHandshakeOutcomeStatus,
} from '../prisma/prisma-client';
import { ManagedEntityAccessWriter } from './managed-entity-access-writer.service';
import {
  ManagedEntityHandshakeService,
  MANAGED_ENTITY_HANDSHAKE_START_CALLBACK_PAYLOAD,
} from './managed-entity-handshake.service';

function createUpdate(overrides: Record<string, unknown> = {}) {
  const messageOverrides =
    typeof overrides.message === 'object' && overrides.message !== null
      ? (overrides.message as Record<string, unknown>)
      : {};
  return {
    updateId: 'u-start-1',
    botId: 'bot-1',
    type: 'message_created',
    message: {
      messageId: 'm-start-1',
      chatId: '-100',
      chatTitle: 'Команда MAX',
      entityType: 'chat',
      senderId: 'admin-1',
      text: 'Старт',
      createdAt: '2026-06-20T12:00:00.000Z',
      ...messageOverrides,
    },
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== 'message')),
  } as never;
}

function createFixture() {
  const prisma = {
    chatBotMembership: {
      upsert: jest.fn((args) => ({ operation: 'membership.upsert', args })),
    },
    chatAdminAllowlist: {
      upsert: jest.fn((args) => ({ operation: 'allowlist.upsert', args })),
    },
    managedEntityAdminMember: {
      upsert: jest.fn((args) => ({ operation: 'adminMember.upsert', args })),
    },
    managedBotChatCatalog: {
      upsert: jest.fn().mockResolvedValue(undefined),
    },
    managedEntityAccessEdge: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn((args) => ({ operation: 'edge.upsert', args })),
    },
    managedEntityLocalActivity: {
      upsert: jest.fn((args) => ({ operation: 'activity.upsert', args })),
    },
    $transaction: jest.fn(async (operations) => operations),
  };
  const maxClient = {
    getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
      userId: 'bot-1',
      isAdmin: true,
      isOwner: false,
      permissions: ['change_chat_info'],
    }),
    getChatMembersAccess: jest.fn().mockResolvedValue(
      new Map([
        [
          'admin-1',
          {
            userId: 'admin-1',
            isAdmin: true,
            isOwner: false,
            permissions: ['change_chat_info'],
          },
        ],
      ]),
    ),
    sendMessageImmediateWithId: jest.fn().mockResolvedValue({
      messageId: 'reply-1',
      url: null,
    }),
    deleteMessage: jest.fn().mockResolvedValue(undefined),
  };
  const maxBotLinkService = {
    bindDiscoveredChatBots: jest.fn().mockResolvedValue('bot-1'),
    buildEntryMiniappStartUrlSync: jest.fn().mockReturnValue('https://max.ru/entry?startapp=mr-x'),
    buildMiniappStartUrlSync: jest.fn().mockReturnValue('https://max.ru/bot-1?startapp=mr-x'),
  };
  const maxBotRegistry = {
    getBotById: jest.fn((botId?: string | null) =>
      botId === 'bot-1' ? { id: 'bot-1', label: 'Бот' } : null,
    ),
    isKnownBotUserId: jest.fn((userId?: string | null) => userId === 'bot-1'),
  };
  const chatContextCache = {
    upsertManagedEntitiesRecentBootstrap: jest.fn().mockResolvedValue(undefined),
    getManagedEntitiesPublishedSnapshot: jest.fn().mockResolvedValue(null),
    setManagedEntitiesPublishedSnapshot: jest.fn().mockResolvedValue(undefined),
    setAdminAccess: jest.fn().mockResolvedValue(undefined),
    rememberChatAdminUser: jest.fn().mockResolvedValue(undefined),
  };
  const rosterSync = {
    processJob: jest.fn().mockResolvedValue(true),
    scheduleChatAdminRosterSync: jest.fn().mockResolvedValue(true),
  };
  const handshakeOutcomes = {
    recordOutcome: jest.fn().mockResolvedValue(undefined),
  };
  const accessWriter = new ManagedEntityAccessWriter(
    prisma as never,
    maxBotLinkService as never,
    chatContextCache as never,
  );
  const service = new ManagedEntityHandshakeService(
    accessWriter as never,
    maxClient as never,
    maxBotLinkService as never,
    maxBotRegistry as never,
    rosterSync as never,
    handshakeOutcomes as never,
  );

  return {
    service,
    prisma,
    maxClient,
    maxBotLinkService,
    maxBotRegistry,
    chatContextCache,
    rosterSync,
    handshakeOutcomes,
  };
}

describe('ManagedEntityHandshakeService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('connects a chat when Старт is sent by an admin and the bot is admin', async () => {
    const fixture = createFixture();

    await expect(fixture.service.handleWebhookUpdate(createUpdate())).resolves.toBe('connected');

    expect(fixture.maxBotLinkService.bindDiscoveredChatBots).toHaveBeenCalledWith({
      chatId: '-100',
      primaryBotId: 'bot-1',
      botIds: ['bot-1'],
      title: 'Команда MAX',
      entityType: ChatEntityType.CHAT,
    });
    expect(fixture.prisma.managedEntityAccessEdge.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          chatId_userId_botId: {
            chatId: '-100',
            userId: 'admin-1',
            botId: 'bot-1',
          },
        },
        create: expect.objectContaining({
          state: ManagedEntityAccessState.GRANTED,
          source: 'handshake_start',
        }),
      }),
    );
    expect(fixture.prisma.chatBotMembership.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          chatId_botId: {
            chatId: '-100',
            botId: 'bot-1',
          },
        },
        create: expect.objectContaining({
          role: ChatBotMembershipRole.PRIMARY,
          status: ChatBotMembershipStatus.ACTIVE,
        }),
        update: expect.objectContaining({
          status: ChatBotMembershipStatus.ACTIVE,
          permissionsSnapshot: expect.objectContaining({ isAdmin: true }),
        }),
      }),
    );
    expect(fixture.chatContextCache.setManagedEntitiesPublishedSnapshot).toHaveBeenCalledWith(
      'admin-1',
      'chat',
      expect.objectContaining({
        itemCount: 1,
        items: [expect.objectContaining({ id: '-100', title: 'Команда MAX' })],
      }),
      expect.any(Number),
    );
    expect(fixture.chatContextCache.setAdminAccess).toHaveBeenCalledWith(
      '-100',
      'admin-1',
      'granted',
    );
    expect(fixture.chatContextCache.rememberChatAdminUser).toHaveBeenCalledWith('-100', 'admin-1');
    expect(
      fixture.chatContextCache.setAdminAccess.mock.invocationCallOrder[0],
    ).toBeLessThan(
      fixture.chatContextCache.setManagedEntitiesPublishedSnapshot.mock.invocationCallOrder[0],
    );
    const rosterJob = {
      chatId: '-100',
      botIds: ['bot-1'],
      title: 'Команда MAX',
      entityType: 'chat',
      source: 'handshake_start',
    };
    expect(fixture.rosterSync.processJob).toHaveBeenCalledWith(rosterJob);
    expect(fixture.rosterSync.scheduleChatAdminRosterSync).not.toHaveBeenCalled();
    expect(fixture.maxClient.deleteMessage).toHaveBeenCalledWith(
      '-100',
      'm-start-1',
      expect.objectContaining({
        immediate: true,
        botId: 'bot-1',
        sourceTag: 'managed_handshake',
        ignoreFailureMetricStatuses: [403, 404],
      }),
    );
    expect(fixture.maxClient.sendMessageImmediateWithId).toHaveBeenCalledWith(
      '-100',
      'Готово, чат подключен.',
      expect.objectContaining({
        buttons: [[expect.objectContaining({ text: 'Открыть настройки' })]],
      }),
      expect.objectContaining({ botId: 'bot-1', sourceTag: 'managed_handshake' }),
    );
    expect(fixture.maxClient.getCurrentChatMemberAccess).toHaveBeenCalledWith(
      '-100',
      expect.objectContaining({ sourceTag: 'managed_handshake' }),
    );
    expect(fixture.maxClient.getChatMembersAccess).toHaveBeenCalledWith(
      '-100',
      ['admin-1'],
      expect.objectContaining({ sourceTag: 'managed_handshake' }),
    );
    expect(fixture.handshakeOutcomes.recordOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: '-100',
        userId: 'admin-1',
        botId: 'bot-1',
        entityType: ChatEntityType.CHAT,
        status: ManagedEntityHandshakeOutcomeStatus.CONNECTED,
      }),
    );
  });

  it('requires the exact Старт message in a managed chat', async () => {
    const fixture = createFixture();

    await expect(
      fixture.service.handleWebhookUpdate(
        createUpdate({ message: { chatId: '-100', senderId: 'admin-1', text: 'Стартуем' } }),
      ),
    ).resolves.toBe('ignored');
    await expect(
      fixture.service.handleWebhookUpdate(
        createUpdate({ message: { chatId: '100', senderId: 'admin-1', text: 'Старт' } }),
      ),
    ).resolves.toBe('ignored');
    await expect(
      fixture.service.handleWebhookUpdate(
        createUpdate({
          message: {
            chatId: '-100',
            senderId: 'admin-1',
            text: '',
          },
        }),
      ),
    ).resolves.toBe('ignored');

    expect(fixture.maxClient.getCurrentChatMemberAccess).not.toHaveBeenCalled();
  });

  it('connects from the bot_added Старт callback with the same admin checks', async () => {
    const fixture = createFixture();

    await expect(
      fixture.service.handleWebhookUpdate(
        createUpdate({
          type: 'message_callback',
          message: {
            chatId: '-100',
            senderId: 'admin-1',
            text: '',
          },
          raw: {
            callback: {
              callback_id: 'cb-start-1',
              payload: MANAGED_ENTITY_HANDSHAKE_START_CALLBACK_PAYLOAD,
              user: {
                user_id: 'admin-1',
              },
            },
          },
        }),
      ),
    ).resolves.toBe('connected');

    expect(fixture.maxClient.getCurrentChatMemberAccess).toHaveBeenCalledWith(
      '-100',
      expect.objectContaining({ sourceTag: 'managed_handshake' }),
    );
    expect(fixture.maxClient.getChatMembersAccess).toHaveBeenCalledWith(
      '-100',
      ['admin-1'],
      expect.objectContaining({ sourceTag: 'managed_handshake' }),
    );
    expect(fixture.prisma.managedEntityAccessEdge.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          state: ManagedEntityAccessState.GRANTED,
          source: 'handshake_start',
        }),
      }),
    );
    expect(fixture.maxClient.deleteMessage).not.toHaveBeenCalled();
  });

  it('uses the callback user when MAX does not expose message senderId', async () => {
    const fixture = createFixture();

    await expect(
      fixture.service.handleWebhookUpdate(
        createUpdate({
          type: 'message_callback',
          message: {
            chatId: '-100',
            senderId: '',
            text: '',
          },
          raw: {
            callback: {
              callback_id: 'cb-start-2',
              payload: MANAGED_ENTITY_HANDSHAKE_START_CALLBACK_PAYLOAD,
              user: {
                user_id: 'admin-1',
              },
            },
          },
        }),
      ),
    ).resolves.toBe('connected');

    expect(fixture.maxClient.getChatMembersAccess).toHaveBeenCalledWith(
      '-100',
      ['admin-1'],
      expect.objectContaining({ sourceTag: 'managed_handshake' }),
    );
    expect(fixture.prisma.managedEntityAccessEdge.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          chatId_userId_botId: {
            chatId: '-100',
            userId: 'admin-1',
            botId: 'bot-1',
          },
        },
      }),
    );
  });

  it('uses the callback user when the callback message sender is the bot', async () => {
    const fixture = createFixture();

    await expect(
      fixture.service.handleWebhookUpdate(
        createUpdate({
          type: 'message_callback',
          message: {
            chatId: '-100',
            senderId: 'bot-1',
            text: '',
          },
          raw: {
            callback: {
              callback_id: 'cb-start-3',
              payload: MANAGED_ENTITY_HANDSHAKE_START_CALLBACK_PAYLOAD,
              user: {
                user_id: 'admin-1',
              },
            },
          },
        }),
      ),
    ).resolves.toBe('connected');

    expect(fixture.chatContextCache.upsertManagedEntitiesRecentBootstrap).toHaveBeenCalledWith(
      expect.objectContaining({
        id: '-100',
        entityType: 'chat',
      }),
      expect.any(Number),
      'admin-1',
    );
    expect(fixture.maxClient.getChatMembersAccess).toHaveBeenCalledWith(
      '-100',
      ['admin-1'],
      expect.objectContaining({ sourceTag: 'managed_handshake' }),
    );
  });

  it('ignores unrelated callbacks', async () => {
    const fixture = createFixture();

    await expect(
      fixture.service.handleWebhookUpdate(
        createUpdate({
          type: 'message_callback',
          message: {
            chatId: '-100',
            senderId: 'admin-1',
            text: '',
          },
          raw: {
            callback: {
              callback_id: 'cb-other',
              payload: 'action|sample-1|1|0',
            },
          },
        }),
      ),
    ).resolves.toBe('ignored');

    expect(fixture.maxClient.getCurrentChatMemberAccess).not.toHaveBeenCalled();
  });

  it('denies the command when the sender is not an admin', async () => {
    const fixture = createFixture();
    fixture.maxClient.getChatMembersAccess.mockResolvedValueOnce(
      new Map([
        [
          'admin-1',
          {
            userId: 'admin-1',
            isAdmin: false,
            isOwner: false,
            permissions: [],
          },
        ],
      ]),
    );

    await expect(fixture.service.handleWebhookUpdate(createUpdate())).resolves.toBe('denied');
    await expect(
      fixture.service.handleWebhookUpdate(createUpdate({ updateId: 'u-start-1-duplicate' })),
    ).resolves.toBe('rate_limited');

    expect(fixture.maxBotLinkService.bindDiscoveredChatBots).not.toHaveBeenCalled();
    expect(fixture.chatContextCache.upsertManagedEntitiesRecentBootstrap).not.toHaveBeenCalled();
    expect(fixture.prisma.managedEntityAccessEdge.upsert).not.toHaveBeenCalled();
    expect(fixture.maxClient.getChatMembersAccess).toHaveBeenCalledTimes(1);
    expect(fixture.maxClient.sendMessageImmediateWithId).toHaveBeenCalledTimes(1);
    expect(fixture.maxClient.sendMessageImmediateWithId).toHaveBeenCalledWith(
      '-100',
      'Подключить чат может только администратор или владелец. Попросите такого пользователя нажать кнопку ниже.',
      expect.objectContaining({
        buttons: [
          [
            expect.objectContaining({
              type: 'callback',
              text: 'Проверить подключение',
              payload: MANAGED_ENTITY_HANDSHAKE_START_CALLBACK_PAYLOAD,
            }),
          ],
        ],
      }),
      expect.anything(),
    );
    expect(fixture.handshakeOutcomes.recordOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        status: ManagedEntityHandshakeOutcomeStatus.USER_DENIED,
        reason: 'user_not_admin',
      }),
    );
    expect(fixture.handshakeOutcomes.recordOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        status: ManagedEntityHandshakeOutcomeStatus.RATE_LIMITED,
        reason: 'duplicate_recently',
      }),
    );
    expect(fixture.maxClient.deleteMessage).not.toHaveBeenCalled();
  });

  it('rate limits repeated denied callback clicks to avoid group spam', async () => {
    const fixture = createFixture();
    fixture.maxClient.getChatMembersAccess.mockResolvedValueOnce(
      new Map([
        [
          'admin-1',
          {
            userId: 'admin-1',
            isAdmin: false,
            isOwner: false,
            permissions: [],
          },
        ],
      ]),
    );
    const callbackUpdate = createUpdate({
      type: 'message_callback',
      message: {
        chatId: '-100',
        senderId: 'bot-1',
        text: '',
      },
      raw: {
        callback: {
          callback_id: 'cb-denied-1',
          payload: MANAGED_ENTITY_HANDSHAKE_START_CALLBACK_PAYLOAD,
          user: {
            user_id: 'admin-1',
          },
        },
      },
    });

    await expect(fixture.service.handleWebhookUpdate(callbackUpdate)).resolves.toBe('denied');
    await expect(
      fixture.service.handleWebhookUpdate(
        createUpdate({
          type: 'message_callback',
          updateId: 'u-start-callback-denied-duplicate',
          message: {
            chatId: '-100',
            senderId: 'bot-1',
            text: '',
          },
          raw: {
            callback: {
              callback_id: 'cb-denied-2',
              payload: MANAGED_ENTITY_HANDSHAKE_START_CALLBACK_PAYLOAD,
              user: {
                user_id: 'admin-1',
              },
            },
          },
        }),
      ),
    ).resolves.toBe('rate_limited');

    expect(fixture.maxClient.getChatMembersAccess).toHaveBeenCalledTimes(1);
    expect(fixture.maxClient.sendMessageImmediateWithId).toHaveBeenCalledTimes(1);
    expect(fixture.handshakeOutcomes.recordOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        status: ManagedEntityHandshakeOutcomeStatus.RATE_LIMITED,
        reason: 'duplicate_recently',
      }),
    );
  });

  it('queues a roster sync fallback when direct database refresh fails', async () => {
    const fixture = createFixture();
    fixture.rosterSync.processJob.mockRejectedValueOnce(new Error('MAX timeout'));

    await expect(fixture.service.handleWebhookUpdate(createUpdate())).resolves.toBe('connected');

    const rosterJob = {
      chatId: '-100',
      botIds: ['bot-1'],
      title: 'Команда MAX',
      entityType: 'chat',
      source: 'handshake_start',
    };
    expect(fixture.rosterSync.processJob).toHaveBeenCalledWith(rosterJob);
    expect(fixture.rosterSync.scheduleChatAdminRosterSync).toHaveBeenCalledWith(rosterJob);
    expect(fixture.maxClient.deleteMessage).toHaveBeenCalledWith(
      '-100',
      'm-start-1',
      expect.objectContaining({ immediate: true, botId: 'bot-1' }),
    );
  });

  it('rate limits duplicate bot access denials but allows a new Старт message to retry', async () => {
    const fixture = createFixture();
    fixture.maxClient.getCurrentChatMemberAccess
      .mockResolvedValueOnce({
        userId: 'bot-1',
        isAdmin: false,
        isOwner: false,
        permissions: [],
      })
      .mockResolvedValueOnce({
        userId: 'bot-1',
        isAdmin: true,
        isOwner: false,
        permissions: ['change_chat_info'],
      });

    await expect(fixture.service.handleWebhookUpdate(createUpdate())).resolves.toBe('denied');
    await expect(
      fixture.service.handleWebhookUpdate(createUpdate({ updateId: 'u-start-1-duplicate' })),
    ).resolves.toBe('rate_limited');
    await expect(
      fixture.service.handleWebhookUpdate(
        createUpdate({
          updateId: 'u-start-2',
          message: {
            messageId: 'm-start-2',
          },
        }),
      ),
    ).resolves.toBe('connected');

    expect(fixture.maxClient.getCurrentChatMemberAccess).toHaveBeenCalledTimes(2);
    expect(fixture.prisma.managedEntityAccessEdge.upsert).toHaveBeenCalledTimes(1);
    expect(fixture.handshakeOutcomes.recordOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        status: ManagedEntityHandshakeOutcomeStatus.RATE_LIMITED,
        reason: 'duplicate_recently',
      }),
    );
  });

  it('treats MAX 403 during bot access lookup as a rate-limited bot denial', async () => {
    const fixture = createFixture();
    fixture.maxClient.getCurrentChatMemberAccess.mockRejectedValueOnce(
      Object.assign(new Error('Request failed with status code 403'), {
        response: {
          status: 403,
          data: {
            code: 'chat.denied',
          },
        },
      }),
    );

    await expect(fixture.service.handleWebhookUpdate(createUpdate())).resolves.toBe('denied');
    await expect(
      fixture.service.handleWebhookUpdate(createUpdate({ updateId: 'u-start-1-duplicate' })),
    ).resolves.toBe('rate_limited');

    expect(fixture.maxClient.getCurrentChatMemberAccess).toHaveBeenCalledTimes(1);
    expect(fixture.maxClient.getCurrentChatMemberAccess).toHaveBeenCalledWith(
      '-100',
      expect.objectContaining({
        sourceTag: 'managed_handshake',
        ignoreFailureMetricStatuses: [403, 404],
      }),
    );
    expect(fixture.maxClient.getChatMembersAccess).not.toHaveBeenCalled();
    expect(fixture.prisma.managedEntityAccessEdge.upsert).not.toHaveBeenCalled();
    expect(fixture.maxClient.sendMessageImmediateWithId).toHaveBeenCalledTimes(1);
    expect(fixture.handshakeOutcomes.recordOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        status: ManagedEntityHandshakeOutcomeStatus.BOT_DENIED,
        reason: 'bot_access_denied',
      }),
    );
    expect(fixture.handshakeOutcomes.recordOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        status: ManagedEntityHandshakeOutcomeStatus.RATE_LIMITED,
        reason: 'duplicate_recently',
      }),
    );
  });

  it('refreshes an existing granted edge when the chat is already connected', async () => {
    const fixture = createFixture();
    fixture.prisma.managedEntityAccessEdge.findUnique.mockResolvedValueOnce({
      state: ManagedEntityAccessState.GRANTED,
    });

    await expect(fixture.service.handleWebhookUpdate(createUpdate())).resolves.toBe(
      'already_connected',
    );

    expect(fixture.prisma.managedEntityAccessEdge.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          state: ManagedEntityAccessState.GRANTED,
          expiresAt: expect.any(Date),
          source: 'handshake_start',
        }),
      }),
    );
    expect(fixture.maxClient.sendMessageImmediateWithId).toHaveBeenCalledWith(
      '-100',
      'Уже подключен. Я обновил доступ и настройки.',
      expect.objectContaining({
        buttons: [[expect.objectContaining({ text: 'Открыть настройки' })]],
      }),
      expect.objectContaining({ sourceTag: 'managed_handshake' }),
    );
  });

  it('bootstraps a channel without user access when sender is a bot/system identity', async () => {
    const fixture = createFixture();

    await expect(
      fixture.service.handleWebhookUpdate(
        createUpdate({
          message: {
            messageId: 'm-channel-1',
            chatId: '-200',
            chatTitle: 'Канал MAX',
            entityType: 'channel',
            senderId: 'bot-1',
            text: 'Старт',
            createdAt: '2026-06-20T12:00:00.000Z',
          },
        }),
      ),
    ).resolves.toBe('bootstrapped_without_user');

    expect(fixture.prisma.managedEntityAccessEdge.upsert).not.toHaveBeenCalled();
    expect(fixture.chatContextCache.setAdminAccess).not.toHaveBeenCalled();
    expect(fixture.chatContextCache.upsertManagedEntitiesRecentBootstrap).toHaveBeenCalledWith(
      expect.objectContaining({ id: '-200', entityType: 'channel' }),
      expect.any(Number),
      null,
    );
    expect(fixture.maxClient.getChatMembersAccess).not.toHaveBeenCalled();
    expect(fixture.handshakeOutcomes.recordOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'bot-1',
        status: ManagedEntityHandshakeOutcomeStatus.BOOTSTRAPPED_WITHOUT_USER,
        reason: 'sender_missing',
      }),
    );
  });

  it('allows a new Старт message to refresh access but rate limits duplicate deliveries', async () => {
    const fixture = createFixture();

    await expect(fixture.service.handleWebhookUpdate(createUpdate())).resolves.toBe('connected');
    await expect(
      fixture.service.handleWebhookUpdate(
        createUpdate({
          updateId: 'u-start-1-duplicate',
        }),
      ),
    ).resolves.toBe('rate_limited');
    await expect(
      fixture.service.handleWebhookUpdate(
        createUpdate({
          updateId: 'u-start-2',
          message: {
            messageId: 'm-start-2',
          },
        }),
      ),
    ).resolves.toBe('connected');

    expect(fixture.maxClient.getCurrentChatMemberAccess).toHaveBeenCalledTimes(2);
    expect(fixture.prisma.managedEntityAccessEdge.upsert).toHaveBeenCalledTimes(2);
    expect(fixture.handshakeOutcomes.recordOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: '-100',
        userId: 'admin-1',
        botId: 'bot-1',
        status: ManagedEntityHandshakeOutcomeStatus.RATE_LIMITED,
        reason: 'duplicate_recently',
      }),
    );
    expect(fixture.maxClient.deleteMessage).toHaveBeenCalledWith(
      '-100',
      'm-start-2',
      expect.objectContaining({ immediate: true, botId: 'bot-1' }),
    );
  });
});
