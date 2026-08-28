import {
  ChatBotAccessState,
  ChatBotMembershipStatus,
  ChatEntityType,
  ManagedEntityAccessState,
} from '../prisma/prisma-client';
import { isPublisherBindingConnected } from './publisher-entity-connection.util';
import {
  PUBLISHER_ACCESS_CANDIDATE_PENDING_REASON,
  PublisherEntityBindingLifecycleService,
  shouldApplyPublisherObservation,
} from './publisher-entity-binding-lifecycle.service';

function createPublisherForwardedUpdate() {
  return {
    updateId: 'publisher-forward-1',
    botId: 'publik_bot',
    type: 'message_created',
    eventTimestampSource: 'payload',
    message: {
      messageId: 'private-message-1',
      chatId: '10001',
      senderId: '20002',
      text: 'Пересланная публикация',
      createdAt: '2026-08-27T12:00:00.000Z',
    },
    raw: {
      update_type: 'message_created',
      message: {
        id: 'private-message-1',
        sender: { user_id: 20002 },
        recipient: { chat_id: 10001, chat_type: 'dialog' },
        body: null,
        link: {
          type: 'forward',
          chat_id: -70001,
          message: { mid: 'source-message-1', text: 'Публикация' },
        },
      },
    },
  } as never;
}

function createBotRegistry() {
  return {
    isKnownBotUserId: jest.fn((value: string) =>
      ['publik_bot', '387541327', 'main_bot', '90009'].includes(value),
    ),
  };
}

function createHistoricalRecoveryTransaction() {
  return {
    $queryRaw: jest.fn().mockResolvedValue([{ id: '-80001' }]),
    chat: {
      findUnique: jest.fn().mockResolvedValue({ publicationPolicy: null }),
    },
    publisherEntityBinding: {
      findUnique: jest.fn().mockResolvedValue({
        publisherBotId: 'publik_bot',
        status: ChatBotMembershipStatus.ACTIVE,
      }),
    },
    managedBotChatCatalog: {
      findUnique: jest.fn().mockResolvedValue({
        entityType: ChatEntityType.CHANNEL,
        status: 'ACTIVE',
      }),
    },
    managedEntityAccessEdge: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({ chatId: '-80001' }),
    },
  };
}

describe('PublisherEntityBindingLifecycleService', () => {
  it('orders equal-time terminal observations deterministically', () => {
    const at = new Date('2026-08-26T12:00:00.000Z');
    expect(
      shouldApplyPublisherObservation(
        { lifecycleEventAt: at, lifecycleEventType: 'bot_added' },
        { eventAt: at, eventType: 'bot_removed' },
      ),
    ).toBe(true);
    expect(
      shouldApplyPublisherObservation(
        { lifecycleEventAt: at, lifecycleEventType: 'bot_removed' },
        { eventAt: at, eventType: 'bot_added' },
      ),
    ).toBe(false);
  });

  it('keeps publisher lifecycle outside ChatBotMembership and rejects an older removal', async () => {
    let binding: Record<string, unknown> | null = null;
    let chatExists = false;
    const publisherEntityBinding = {
      findUnique: jest.fn(async () => binding),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        binding = { ...data };
        return binding;
      }),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        binding = { ...(binding ?? {}), ...data };
        return binding;
      }),
      updateMany: jest.fn(async () => ({ count: 1 })),
    };
    const transactionClient = {
      $queryRaw: jest.fn(async () => [{ id: 'chat-1' }]),
      chat: {
        findUnique: jest.fn(async () => (chatExists ? { id: 'chat-1', entityType: 'CHAT' } : null)),
        upsert: jest.fn(
          async (_request: {
            where: { id: string };
            create: Record<string, unknown>;
            update: Record<string, unknown>;
          }) => {
            chatExists = true;
            return { id: 'chat-1' };
          },
        ),
        update: jest.fn(async () => ({ id: 'chat-1' })),
      },
      managedBotChatCatalog: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn(async () => ({ id: 'catalog-1' })),
      },
      managedEntityAccessEdge: {
        findUnique: jest.fn(async () => null),
        upsert: jest.fn(async () => ({ chatId: 'chat-1' })),
        updateMany: jest.fn(async () => ({ count: 0 })),
      },
      publisherEntityBinding,
      get chatBotMembership(): never {
        throw new Error('publisher lifecycle must not access ChatBotMembership');
      },
    };
    const prisma = {
      $transaction: jest.fn(async (callback: (tx: typeof transactionClient) => unknown) =>
        callback(transactionClient),
      ),
    };
    const refreshQueue = { enqueue: jest.fn(async () => undefined) };
    const config = {
      get: jest.fn((key: string) => (key === 'MAX_PUBLISHER_BOT_ID' ? 'publik_bot' : undefined)),
    };
    const service = new PublisherEntityBindingLifecycleService(
      prisma as never,
      refreshQueue as never,
      config as never,
      createBotRegistry() as never,
    );

    await expect(
      service.observeWebhook({
        updateId: 'new-add',
        botId: 'publik_bot',
        type: 'bot_added',
        eventTimestampSource: 'remote',
        message: {
          messageId: 'bot_added:new-add',
          chatId: 'chat-1',
          senderId: 'admin-1',
          text: '',
          createdAt: '2026-08-26T12:00:00.000Z',
        },
        raw: {},
      } as never),
    ).resolves.toBe('applied');
    expect(binding).toEqual(
      expect.objectContaining({
        status: ChatBotMembershipStatus.ACTIVE,
        botAccessState: ChatBotAccessState.UNKNOWN,
      }),
    );
    expect(transactionClient.chat.upsert).toHaveBeenCalledWith({
      where: { id: 'chat-1' },
      create: expect.objectContaining({ id: 'chat-1' }),
      update: {},
    });
    expect(transactionClient.chat.upsert.mock.calls[0]?.[0]?.create).not.toHaveProperty('botId');
    expect(transactionClient.chat.upsert.mock.calls[0]?.[0]?.create).not.toHaveProperty(
      'primaryBotId',
    );
    expect(transactionClient.managedBotChatCatalog.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { botId_chatId: { botId: 'publik_bot', chatId: 'chat-1' } },
      }),
    );
    expect(refreshQueue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'chat-1',
        publisherBotId: 'publik_bot',
        candidateUserId: 'admin-1',
        reason: 'bot_added',
      }),
    );

    await expect(
      service.observeWebhook({
        updateId: 'older-remove',
        botId: 'publik_bot',
        type: 'bot_removed',
        eventTimestampSource: 'remote',
        message: {
          messageId: 'bot_removed:older-remove',
          chatId: 'chat-1',
          senderId: 'admin-1',
          text: '',
          createdAt: '2026-08-26T11:59:59.000Z',
        },
        raw: {},
      } as never),
    ).resolves.toBe('stale');
    expect(binding).toEqual(
      expect.objectContaining({
        status: ChatBotMembershipStatus.ACTIVE,
        botAccessState: ChatBotAccessState.UNKNOWN,
      }),
    );
    expect(refreshQueue.enqueue).toHaveBeenCalledTimes(1);

    await expect(
      service.observeWebhook({
        updateId: 'admin-handshake',
        botId: 'publik_bot',
        type: 'message_created',
        eventTimestampSource: 'remote',
        message: {
          messageId: 'message:admin-handshake',
          chatId: 'chat-1',
          senderId: 'admin-2',
          text: 'Старт',
          createdAt: '2026-08-26T12:01:00.000Z',
        },
        raw: {},
      } as never),
    ).resolves.toBe('applied');
    expect(refreshQueue.enqueue).toHaveBeenLastCalledWith(
      expect.objectContaining({
        candidateUserId: 'admin-2',
        reason: 'webhook_observed',
      }),
    );
    expect(transactionClient.managedEntityAccessEdge.upsert).toHaveBeenLastCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          userId: 'admin-2',
          botId: 'publik_bot',
          state: ManagedEntityAccessState.BOT_DENIED,
          deniedReason: PUBLISHER_ACCESS_CANDIDATE_PENDING_REASON,
        }),
      }),
    );
    expect(refreshQueue.enqueue).toHaveBeenCalledTimes(2);
    expect(transactionClient.chat.update).not.toHaveBeenCalled();
  });

  it('keeps ordinary messages on the fresh binding fast path without refresh jobs', async () => {
    const observedAt = new Date();
    const binding = {
      publisherBotId: 'publik_bot',
      status: ChatBotMembershipStatus.ACTIVE,
      botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
      botAccessCheckedAt: new Date(observedAt.getTime() - 60_000),
      botAccessExpiresAt: new Date(observedAt.getTime() + 10 * 60_000),
      sendRouteQuarantinedUntil: null,
      lifecycleEventAt: new Date(observedAt.getTime() - 2_000),
      lifecycleEventType: 'message_created',
    };
    const updateMany = jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
      Object.assign(binding, data);
      return { count: 1 };
    });
    const prisma = {
      publisherEntityBinding: {
        findUnique: jest.fn(async () => ({ ...binding })),
        updateMany,
      },
      managedBotChatCatalog: {
        findUnique: jest.fn().mockResolvedValue({
          entityType: ChatEntityType.CHAT,
          title: 'Чат Публика',
          status: 'ACTIVE',
        }),
      },
      $transaction: jest.fn(),
    };
    const refreshQueue = { enqueue: jest.fn() };
    const service = new PublisherEntityBindingLifecycleService(
      prisma as never,
      refreshQueue as never,
      { get: () => 'publik_bot' } as never,
      createBotRegistry() as never,
    );

    const ordinaryTypes = [
      'message_created',
      'message_edited',
      'message_callback',
      'message_removed',
    ] as const;
    for (const [index, type] of ordinaryTypes.entries()) {
      await expect(
        service.observeWebhook({
          updateId: `ordinary-${type}`,
          botId: 'publik_bot',
          type,
          eventTimestampSource: type === 'message_callback' ? 'ingress' : 'payload',
          message: {
            messageId: `message-${type}`,
            chatId: 'chat-1',
            senderId: 'member-1',
            text: `Сообщение ${type}`,
            createdAt: new Date(observedAt.getTime() + index * 1_000).toISOString(),
          },
          raw: {},
        } as never),
      ).resolves.toBe('applied');
    }

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(refreshQueue.enqueue).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenCalledTimes(ordinaryTypes.length);
    expect(updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          chatId: 'chat-1',
          publisherBotId: 'publik_bot',
          botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
        }),
        data: expect.objectContaining({
          lifecycleEventType: 'message_removed',
          lifecycleSource: 'webhook',
        }),
      }),
    );
  });

  it('falls through to durable refresh when an ordinary message sees stale access', async () => {
    const observedAt = new Date();
    const prisma = {
      publisherEntityBinding: {
        findUnique: jest.fn().mockResolvedValue({
          publisherBotId: 'publik_bot',
          status: ChatBotMembershipStatus.ACTIVE,
          botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
          botAccessCheckedAt: new Date(observedAt.getTime() - 20 * 60_000),
          botAccessExpiresAt: new Date(observedAt.getTime() - 1),
          sendRouteQuarantinedUntil: null,
          lifecycleEventAt: new Date(observedAt.getTime() - 1_000),
          lifecycleEventType: 'message_created',
        }),
        updateMany: jest.fn(),
      },
      managedBotChatCatalog: {
        findUnique: jest.fn().mockResolvedValue({
          entityType: ChatEntityType.CHAT,
          title: 'Чат Публика',
          status: 'ACTIVE',
        }),
      },
      $transaction: jest.fn().mockResolvedValue('applied'),
    };
    const refreshQueue = { enqueue: jest.fn().mockResolvedValue(undefined) };
    const service = new PublisherEntityBindingLifecycleService(
      prisma as never,
      refreshQueue as never,
      { get: () => 'publik_bot' } as never,
      createBotRegistry() as never,
    );

    await expect(
      service.observeWebhook({
        updateId: 'ordinary-stale-access',
        botId: 'publik_bot',
        type: 'message_created',
        eventTimestampSource: 'payload',
        message: {
          messageId: 'message-stale-access',
          chatId: 'chat-1',
          senderId: 'member-1',
          text: 'Обычное сообщение',
          createdAt: observedAt.toISOString(),
        },
        raw: {},
      } as never),
    ).resolves.toBe('applied');

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(refreshQueue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'chat-1',
        publisherBotId: 'publik_bot',
        reason: 'webhook_observed',
      }),
    );
  });

  it('falls back to the ordered lifecycle path when the fresh binding CAS loses a race', async () => {
    const observedAt = new Date();
    const prisma = {
      publisherEntityBinding: {
        findUnique: jest.fn().mockResolvedValue({
          publisherBotId: 'publik_bot',
          status: ChatBotMembershipStatus.ACTIVE,
          botAccessState: ChatBotAccessState.CONFIRMED_OWNER,
          botAccessCheckedAt: new Date(observedAt.getTime() - 60_000),
          botAccessExpiresAt: new Date(observedAt.getTime() + 10 * 60_000),
          sendRouteQuarantinedUntil: null,
          lifecycleEventAt: new Date(observedAt.getTime() - 1_000),
          lifecycleEventType: 'message_created',
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      managedBotChatCatalog: {
        findUnique: jest.fn().mockResolvedValue({
          entityType: ChatEntityType.CHAT,
          title: 'Чат Публика',
          status: 'ACTIVE',
        }),
      },
      $transaction: jest.fn().mockResolvedValue('stale'),
    };
    const refreshQueue = { enqueue: jest.fn() };
    const service = new PublisherEntityBindingLifecycleService(
      prisma as never,
      refreshQueue as never,
      { get: () => 'publik_bot' } as never,
      createBotRegistry() as never,
    );

    await expect(
      service.observeWebhook({
        updateId: 'ordinary-cas-race',
        botId: 'publik_bot',
        type: 'message_created',
        eventTimestampSource: 'payload',
        message: {
          messageId: 'message-cas-race',
          chatId: 'chat-1',
          senderId: 'member-1',
          text: 'Обычное сообщение',
          createdAt: observedAt.toISOString(),
        },
        raw: {},
      } as never),
    ).resolves.toBe('stale');

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(refreshQueue.enqueue).not.toHaveBeenCalled();
  });

  it('keeps the exact Publisher catalog missing after an ordinary observation of a removed binding', async () => {
    const removedAt = new Date('2026-08-26T12:00:00.000Z');
    let binding = {
      lifecycleEventAt: removedAt,
      lifecycleEventType: 'bot_removed',
      status: ChatBotMembershipStatus.REMOVED,
    } as Record<string, unknown>;
    const publisherEntityBinding = {
      findUnique: jest.fn(async () => binding),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        binding = { ...binding, ...data };
        return binding;
      }),
    };
    const transactionClient = {
      $queryRaw: jest.fn(async () => [{ id: 'chat-1' }]),
      chat: {
        findUnique: jest.fn().mockResolvedValue({ id: 'chat-1', entityType: 'CHAT' }),
        upsert: jest.fn(async () => ({ id: 'chat-1' })),
        update: jest.fn(async () => ({ id: 'chat-1' })),
      },
      managedBotChatCatalog: {
        findUnique: jest.fn().mockResolvedValue({ entityType: ChatEntityType.CHAT, title: null }),
        upsert: jest.fn(async () => ({ id: 'catalog-1' })),
      },
      managedEntityAccessEdge: {
        findUnique: jest.fn(async () => null),
        upsert: jest.fn(async () => ({ chatId: 'chat-1' })),
        updateMany: jest.fn(async () => ({ count: 0 })),
      },
      publisherEntityBinding,
    };
    const prisma = {
      publisherEntityBinding: {
        findUnique: publisherEntityBinding.findUnique,
        updateMany: jest.fn(),
      },
      managedBotChatCatalog: {
        findUnique: transactionClient.managedBotChatCatalog.findUnique,
      },
      $transaction: jest.fn(async (callback: (tx: typeof transactionClient) => unknown) =>
        callback(transactionClient),
      ),
    };
    const refreshQueue = { enqueue: jest.fn(async () => undefined) };
    const service = new PublisherEntityBindingLifecycleService(
      prisma as never,
      refreshQueue as never,
      { get: () => 'publik_bot' } as never,
      createBotRegistry() as never,
    );

    await expect(
      service.observeWebhook({
        updateId: 'ordinary-after-remove',
        botId: 'publik_bot',
        type: 'message_created',
        eventTimestampSource: 'remote',
        message: {
          messageId: 'message:ordinary-after-remove',
          chatId: 'chat-1',
          senderId: 'member-1',
          text: 'Сообщение после удаления бота',
          createdAt: '2026-08-26T12:01:00.000Z',
        },
        raw: {},
      } as never),
    ).resolves.toBe('applied');

    expect(publisherEntityBinding.update).toHaveBeenCalledWith({
      where: { chatId: 'chat-1' },
      data: expect.not.objectContaining({ status: ChatBotMembershipStatus.ACTIVE }),
    });
    expect(transactionClient.managedBotChatCatalog.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { botId_chatId: { botId: 'publik_bot', chatId: 'chat-1' } },
        create: expect.objectContaining({ status: 'MISSING' }),
        update: expect.objectContaining({ status: 'MISSING' }),
      }),
    );
    expect(binding).toEqual(
      expect.objectContaining({
        status: ChatBotMembershipStatus.REMOVED,
        lifecycleEventAt: removedAt,
        lifecycleEventType: 'bot_removed',
      }),
    );

    await expect(
      service.observeWebhook({
        updateId: 'delayed-valid-readd',
        botId: 'publik_bot',
        type: 'bot_added',
        eventTimestampSource: 'remote',
        message: {
          messageId: 'bot_added:delayed-valid-readd',
          chatId: 'chat-1',
          senderId: 'admin-1',
          text: '',
          createdAt: '2026-08-26T12:00:30.000Z',
        },
        raw: {},
      } as never),
    ).resolves.toBe('applied');
    expect(binding).toEqual(
      expect.objectContaining({
        status: ChatBotMembershipStatus.ACTIVE,
        lifecycleEventAt: new Date('2026-08-26T12:00:30.000Z'),
        lifecycleEventType: 'bot_added',
      }),
    );
    expect(transactionClient.managedBotChatCatalog.upsert).toHaveBeenLastCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ status: 'ACTIVE' }),
      }),
    );
  });

  it('does not onboard a positive private dialog or an unknown ordinary observation', async () => {
    const transactionClient = {
      chat: { findUnique: jest.fn().mockResolvedValue(null), upsert: jest.fn() },
    };
    const prisma = {
      publisherEntityBinding: {
        findUnique: jest.fn().mockResolvedValue(null),
        updateMany: jest.fn(),
      },
      managedBotChatCatalog: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
      $transaction: jest.fn(async (callback: (tx: typeof transactionClient) => unknown) =>
        callback(transactionClient),
      ),
    };
    const refreshQueue = { enqueue: jest.fn() };
    const service = new PublisherEntityBindingLifecycleService(
      prisma as never,
      refreshQueue as never,
      { get: () => 'publik_bot' } as never,
      createBotRegistry() as never,
    );

    await expect(
      service.observeWebhook({
        updateId: 'private-start',
        botId: 'publik_bot',
        type: 'message_created',
        message: {
          messageId: 'private-start',
          chatId: '12345',
          senderId: 'admin-1',
          text: 'Старт',
          createdAt: '2026-08-26T12:00:00.000Z',
        },
      } as never),
    ).resolves.toBe('unmanaged_chat');
    expect(prisma.$transaction).not.toHaveBeenCalled();

    await expect(
      service.observeWebhook({
        updateId: 'private-slash-start',
        botId: 'publik_bot',
        type: 'message_created',
        message: {
          messageId: 'private-slash-start',
          chatId: '12345',
          senderId: 'admin-1',
          text: '/start',
          createdAt: '2026-08-26T12:00:00.000Z',
        },
      } as never),
    ).resolves.toBe('unmanaged_chat');
    expect(prisma.$transaction).not.toHaveBeenCalled();

    await expect(
      service.observeWebhook({
        updateId: 'unknown-message',
        botId: 'publik_bot',
        type: 'message_created',
        message: {
          messageId: 'unknown-message',
          chatId: 'unknown-chat',
          senderId: 'member-1',
          text: 'Обычное сообщение',
          createdAt: '2026-08-26T12:00:01.000Z',
        },
      } as never),
    ).resolves.toBe('unmanaged_chat');
    expect(transactionClient.chat.upsert).not.toHaveBeenCalled();
    expect(refreshQueue.enqueue).not.toHaveBeenCalled();
  });

  it('stages a forwarded candidate without creating Publisher routing state', async () => {
    let edgeCreate: Record<string, unknown> | null = null;
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: '-70001' }]),
      chat: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({ id: '-70001' }),
      },
      publisherEntityBinding: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn(),
      },
      managedBotChatCatalog: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({ chatId: '-70001' }),
      },
      managedEntityAccessEdge: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn(async ({ create }: { create: Record<string, unknown> }) => {
          edgeCreate = create;
          return create;
        }),
      },
      get chatBotMembership(): never {
        throw new Error('Publisher recovery must not write ChatBotMembership');
      },
    };
    const prisma = {
      $transaction: jest.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    };
    const refreshQueue = { enqueue: jest.fn().mockResolvedValue(undefined) };
    const service = new PublisherEntityBindingLifecycleService(
      prisma as never,
      refreshQueue as never,
      { get: () => 'publik_bot' } as never,
      createBotRegistry() as never,
    );

    await expect(service.observeWebhook(createPublisherForwardedUpdate())).resolves.toBe('applied');

    const chatCreate = tx.chat.upsert.mock.calls[0]?.[0]?.create;
    expect(chatCreate).toEqual(
      expect.objectContaining({ id: '-70001', entityType: ChatEntityType.CHAT }),
    );
    expect(chatCreate).not.toHaveProperty('botId');
    expect(chatCreate).not.toHaveProperty('primaryBotId');
    expect(tx.publisherEntityBinding.upsert).not.toHaveBeenCalled();
    expect(tx.managedBotChatCatalog.upsert).not.toHaveBeenCalled();
    expect(edgeCreate).toEqual(
      expect.objectContaining({
        chatId: '-70001',
        userId: '20002',
        botId: 'publik_bot',
        state: ManagedEntityAccessState.BOT_DENIED,
        deniedReason: PUBLISHER_ACCESS_CANDIDATE_PENDING_REASON,
      }),
    );
    expect(refreshQueue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: '-70001',
        candidateUserId: '20002',
        replyChatId: '10001',
        requiresReadAccess: true,
        reason: 'forwarded_private',
      }),
    );
  });

  it('fences forwarded recovery behind a newer Publisher lifecycle event', async () => {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: '-70001' }]),
      chat: {
        findUnique: jest.fn().mockResolvedValue({
          id: '-70001',
          title: 'Источник',
          entityType: ChatEntityType.CHANNEL,
        }),
        upsert: jest.fn().mockResolvedValue({ id: '-70001' }),
      },
      publisherEntityBinding: {
        findUnique: jest.fn().mockResolvedValue({
          publisherBotId: 'publik_bot',
          status: ChatBotMembershipStatus.REMOVED,
          lifecycleEventAt: new Date('2026-08-27T12:01:00.000Z'),
        }),
        upsert: jest.fn(),
      },
      managedEntityAccessEdge: { findUnique: jest.fn().mockResolvedValue(null), upsert: jest.fn() },
      managedBotChatCatalog: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ entityType: ChatEntityType.CHANNEL, title: 'Источник' }),
        upsert: jest.fn(),
      },
    };
    const refreshQueue = { enqueue: jest.fn() };
    const service = new PublisherEntityBindingLifecycleService(
      {
        $transaction: jest.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
      } as never,
      refreshQueue as never,
      { get: () => 'publik_bot' } as never,
      createBotRegistry() as never,
    );

    await expect(service.observeWebhook(createPublisherForwardedUpdate())).resolves.toBe('stale');

    expect(tx.publisherEntityBinding.upsert).not.toHaveBeenCalled();
    expect(tx.managedBotChatCatalog.upsert).not.toHaveBeenCalled();
    expect(tx.managedEntityAccessEdge.upsert).not.toHaveBeenCalled();
    expect(refreshQueue.enqueue).not.toHaveBeenCalled();
  });

  it('keeps the three-minute forwarded throttle after a successful edge source rewrite', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-27T12:00:00.000Z'));
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: '-70001' }]),
      chat: { upsert: jest.fn().mockResolvedValue({ id: '-70001' }) },
      publisherEntityBinding: {
        findUnique: jest.fn().mockResolvedValue({
          publisherBotId: 'publik_bot',
          status: ChatBotMembershipStatus.ACTIVE,
          lifecycleEventAt: null,
        }),
        upsert: jest.fn(),
      },
      managedBotChatCatalog: { findUnique: jest.fn().mockResolvedValue(null), upsert: jest.fn() },
      managedEntityAccessEdge: {
        findUnique: jest.fn().mockResolvedValue({
          checkedAt: new Date('2026-08-27T11:59:00.000Z'),
          source: 'publisher_targeted_user_access',
          sourceVersion: 'forwarded:older-success',
        }),
        upsert: jest.fn(),
      },
    };
    const refreshQueue = { enqueue: jest.fn() };
    const service = new PublisherEntityBindingLifecycleService(
      {
        $transaction: jest.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
      } as never,
      refreshQueue as never,
      { get: () => 'publik_bot' } as never,
      createBotRegistry() as never,
    );

    await expect(service.observeWebhook(createPublisherForwardedUpdate())).resolves.toBe('stale');

    expect(tx.publisherEntityBinding.upsert).not.toHaveBeenCalled();
    expect(tx.managedBotChatCatalog.upsert).not.toHaveBeenCalled();
    expect(tx.managedEntityAccessEdge.upsert).not.toHaveBeenCalled();
    expect(refreshQueue.enqueue).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('accepts /start only in the source entity and keeps a removed binding hidden until live probe', async () => {
    const removedBinding = {
      publisherBotId: 'publik_bot',
      status: ChatBotMembershipStatus.REMOVED,
      botAccessState: ChatBotAccessState.LOST,
      lifecycleEventAt: new Date('2026-08-27T11:00:00.000Z'),
      lifecycleEventType: 'bot_removed',
      lastWebhookAt: new Date('2026-08-27T11:00:00.000Z'),
    };
    let bindingUpdate: Record<string, unknown> | null = null;
    let edgeCreate: Record<string, unknown> | null = null;
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: '-90001' }]),
      chat: {
        findUnique: jest.fn().mockResolvedValue({ id: '-90001', entityType: ChatEntityType.CHAT }),
        upsert: jest.fn().mockResolvedValue({ id: '-90001' }),
        update: jest.fn().mockResolvedValue({ id: '-90001' }),
      },
      publisherEntityBinding: {
        findUnique: jest.fn().mockResolvedValue(removedBinding),
        update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          bindingUpdate = data;
          return { ...removedBinding, ...data };
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      managedBotChatCatalog: {
        findUnique: jest.fn().mockResolvedValue({ entityType: ChatEntityType.CHAT, title: null }),
        upsert: jest.fn().mockResolvedValue({ chatId: '-90001' }),
      },
      managedEntityAccessEdge: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn(async ({ create }: { create: Record<string, unknown> }) => {
          edgeCreate = create;
          return create;
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    const refreshQueue = { enqueue: jest.fn().mockResolvedValue(undefined) };
    const service = new PublisherEntityBindingLifecycleService(
      {
        $transaction: jest.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
      } as never,
      refreshQueue as never,
      { get: () => 'publik_bot' } as never,
      createBotRegistry() as never,
    );

    await expect(
      service.observeWebhook({
        updateId: 'publisher-direct-start-1',
        botId: 'publik_bot',
        type: 'message_created',
        eventTimestampSource: 'payload',
        message: {
          messageId: 'start-message-1',
          chatId: '-90001',
          senderId: '30003',
          text: '/start',
          createdAt: '2026-08-27T12:00:00.000Z',
        },
        raw: {},
      } as never),
    ).resolves.toBe('applied');

    expect(bindingUpdate).toEqual(
      expect.objectContaining({ status: ChatBotMembershipStatus.ACTIVE }),
    );
    expect(bindingUpdate).not.toHaveProperty('botAccessState');
    expect(edgeCreate).toEqual(
      expect.objectContaining({
        state: ManagedEntityAccessState.BOT_DENIED,
        deniedReason: PUBLISHER_ACCESS_CANDIDATE_PENDING_REASON,
      }),
    );
    expect(
      isPublisherBindingConnected(
        {
          publisherBotId: 'publik_bot',
          status: ChatBotMembershipStatus.ACTIVE,
          botAccessState: ChatBotAccessState.LOST,
          lastWebhookAt: removedBinding.lastWebhookAt,
        },
        'publik_bot',
      ),
    ).toBe(false);
    expect(refreshQueue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateUserId: '30003',
        candidateVersion: 'publisher-direct-start-1',
      }),
    );
  });

  it('recovers missing actors from bounded authenticated Publisher webhook evidence only', async () => {
    const evidenceAt = new Date('2026-08-27T12:00:00.000Z');
    const olderEvidenceAt = new Date(evidenceAt.getTime() - 1_000);
    const scanMeta = {
      scannedCount: 2,
      scanCursorAt: olderEvidenceAt,
      scanCursorWebhookEventId: 'webhook-runtime-bot',
    };
    const queryRaw = jest.fn().mockResolvedValue([
      {
        webhookEventId: 'webhook-1',
        chatId: '-80001',
        userId: '40004',
        bindingPublisherBotId: 'publik_bot',
        bindingStatus: ChatBotMembershipStatus.ACTIVE,
        catalogEntityType: ChatEntityType.CHANNEL,
        catalogStatus: 'ACTIVE',
        publikEnabled: null,
        edgeExists: false,
        evidenceAt,
        ...scanMeta,
      },
      {
        webhookEventId: 'webhook-runtime-bot',
        chatId: '-80002',
        userId: '90009',
        bindingPublisherBotId: 'publik_bot',
        bindingStatus: ChatBotMembershipStatus.ACTIVE,
        catalogEntityType: ChatEntityType.CHAT,
        catalogStatus: 'ACTIVE',
        publikEnabled: true,
        edgeExists: false,
        evidenceAt: olderEvidenceAt,
        ...scanMeta,
      },
    ]);
    const tx = createHistoricalRecoveryTransaction();
    const refreshQueue = { enqueue: jest.fn().mockResolvedValue(undefined) };
    const service = new PublisherEntityBindingLifecycleService(
      {
        $queryRaw: queryRaw,
        $transaction: jest.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
      } as never,
      refreshQueue as never,
      { get: () => 'publik_bot' } as never,
      createBotRegistry() as never,
    );

    await expect(service.recoverHistoricalActorCandidates(evidenceAt)).resolves.toBe(1);

    const sql = (queryRaw.mock.calls[0]?.[0] as { sql: string }).sql.replace(/\s+/gu, ' ');
    const sourcePageStart = sql.indexOf('WITH source_page AS MATERIALIZED');
    const sourcePageEnd = sql.indexOf('), actor_evidence AS');
    const sourceLimit = sql.indexOf('LIMIT ?', sourcePageStart);
    const evidencePredicate = sql.indexOf("recent.normalized_payload->>'type'");
    expect(sourcePageStart).toBeGreaterThanOrEqual(0);
    expect(sourcePageEnd).toBeGreaterThan(sourcePageStart);
    expect(sourceLimit).toBeGreaterThan(sourcePageStart);
    expect(sourceLimit).toBeLessThan(sourcePageEnd);
    expect(evidencePredicate).toBeGreaterThan(sourcePageEnd);
    expect(sql.slice(sourcePageStart, sourcePageEnd)).not.toContain("normalized_payload->>'type'");
    expect(sql).toContain('event."bot_id" = ?');
    expect(sql).toContain('event."status" = \'PROCESSED\'::"WebhookStatus"');
    expect(sql).toContain("recent.normalized_payload->>'eventTimestampSource' = 'payload'");
    expect(sql).toContain("recent.normalized_payload->'message'->>'senderId'");
    expect(sql).toContain("recent.normalized_payload->'message'->>'chatId'");
    expect(sql).toContain("IN ('старт', '/start')");
    expect(sql).toContain('page.scanned_count AS "scannedCount"');
    expect(sql).toContain('LEFT JOIN actor_evidence AS actor ON TRUE');
    expect(refreshQueue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: '-80001',
        publisherBotId: 'publik_bot',
        candidateUserId: '40004',
        candidateVersion: 'historical:webhook-1',
        reason: 'historical_actor_recovery',
      }),
    );
    expect(refreshQueue.enqueue).not.toHaveBeenCalledWith(
      expect.objectContaining({ candidateUserId: '90009' }),
    );
  });

  it('advances the historical cursor across 500 source events without JSON evidence', async () => {
    const now = new Date('2026-08-27T12:00:00.000Z');
    const rawBoundaryAt = new Date(now.getTime() - 499_000);
    const olderEvidenceAt = new Date(now.getTime() - 600_000);
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([
        {
          webhookEventId: null,
          chatId: null,
          userId: null,
          bindingPublisherBotId: null,
          bindingStatus: null,
          catalogEntityType: null,
          catalogStatus: null,
          publikEnabled: null,
          edgeExists: false,
          evidenceAt: null,
          scannedCount: 500,
          scanCursorAt: rawBoundaryAt,
          scanCursorWebhookEventId: 'raw-boundary-500',
        },
      ])
      .mockResolvedValueOnce([
        {
          webhookEventId: 'older-eligible',
          chatId: '-99001',
          userId: '88001',
          bindingPublisherBotId: 'publik_bot',
          bindingStatus: ChatBotMembershipStatus.ACTIVE,
          catalogEntityType: ChatEntityType.CHANNEL,
          catalogStatus: 'ACTIVE',
          publikEnabled: true,
          edgeExists: false,
          evidenceAt: olderEvidenceAt,
          scannedCount: 1,
          scanCursorAt: olderEvidenceAt,
          scanCursorWebhookEventId: 'older-eligible',
        },
      ]);
    const tx = createHistoricalRecoveryTransaction();
    const refreshQueue = { enqueue: jest.fn().mockResolvedValue(undefined) };
    const prisma = {
      $queryRaw: queryRaw,
      $transaction: jest.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    };
    const service = new PublisherEntityBindingLifecycleService(
      prisma as never,
      refreshQueue as never,
      { get: () => 'publik_bot' } as never,
      createBotRegistry() as never,
    );

    await expect(service.recoverHistoricalActorCandidates(now)).resolves.toBe(0);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(refreshQueue.enqueue).not.toHaveBeenCalled();
    await expect(service.recoverHistoricalActorCandidates(now)).resolves.toBe(1);

    expect(queryRaw).toHaveBeenCalledTimes(2);
    const secondStatement = queryRaw.mock.calls[1]?.[0] as {
      sql: string;
      values: unknown[];
    };
    const secondSql = secondStatement.sql.replace(/\s+/gu, ' ');
    expect(secondSql).toContain('(event."created_at", event."id") < (?, ?)');
    expect(secondStatement.values).toContain(rawBoundaryAt);
    expect(secondStatement.values).toContain('raw-boundary-500');
    expect(refreshQueue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: '-99001',
        candidateUserId: '88001',
        reason: 'historical_actor_recovery',
      }),
    );
  });

  it('enters cooldown when the bounded source page is empty', async () => {
    const now = new Date('2026-08-27T12:00:00.000Z');
    const queryRaw = jest.fn().mockResolvedValue([
      {
        webhookEventId: null,
        chatId: null,
        userId: null,
        bindingPublisherBotId: null,
        bindingStatus: null,
        catalogEntityType: null,
        catalogStatus: null,
        publikEnabled: null,
        edgeExists: false,
        evidenceAt: null,
        scannedCount: 0,
        scanCursorAt: null,
        scanCursorWebhookEventId: null,
      },
    ]);
    const refreshQueue = { enqueue: jest.fn() };
    const service = new PublisherEntityBindingLifecycleService(
      { $queryRaw: queryRaw, $transaction: jest.fn() } as never,
      refreshQueue as never,
      { get: () => 'publik_bot' } as never,
      createBotRegistry() as never,
    );

    await expect(service.recoverHistoricalActorCandidates(now)).resolves.toBe(0);
    await expect(
      service.recoverHistoricalActorCandidates(new Date(now.getTime() + 30 * 60_000)),
    ).resolves.toBe(0);

    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(refreshQueue.enqueue).not.toHaveBeenCalled();
  });

  it('keeps the actor cursor when the candidate batch stops before the source boundary', async () => {
    const now = new Date('2026-08-27T12:00:00.000Z');
    const firstEvidenceAt = new Date(now.getTime() - 1_000);
    const secondEvidenceAt = new Date(now.getTime() - 2_000);
    const rawBoundaryAt = new Date(now.getTime() - 499_000);
    const firstPageMeta = {
      scannedCount: 500,
      scanCursorAt: rawBoundaryAt,
      scanCursorWebhookEventId: 'raw-page-boundary',
    };
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([
        {
          webhookEventId: 'first-evidence',
          chatId: '-91001',
          userId: '81001',
          bindingPublisherBotId: 'publik_bot',
          bindingStatus: ChatBotMembershipStatus.ACTIVE,
          catalogEntityType: ChatEntityType.CHANNEL,
          catalogStatus: 'ACTIVE',
          publikEnabled: true,
          edgeExists: false,
          evidenceAt: firstEvidenceAt,
          ...firstPageMeta,
        },
        {
          webhookEventId: 'second-evidence',
          chatId: '-91002',
          userId: '81002',
          bindingPublisherBotId: 'publik_bot',
          bindingStatus: ChatBotMembershipStatus.ACTIVE,
          catalogEntityType: ChatEntityType.CHANNEL,
          catalogStatus: 'ACTIVE',
          publikEnabled: true,
          edgeExists: false,
          evidenceAt: secondEvidenceAt,
          ...firstPageMeta,
        },
      ])
      .mockResolvedValueOnce([
        {
          webhookEventId: 'second-evidence',
          chatId: '-91002',
          userId: '81002',
          bindingPublisherBotId: 'publik_bot',
          bindingStatus: ChatBotMembershipStatus.ACTIVE,
          catalogEntityType: ChatEntityType.CHANNEL,
          catalogStatus: 'ACTIVE',
          publikEnabled: true,
          edgeExists: false,
          evidenceAt: secondEvidenceAt,
          scannedCount: 1,
          scanCursorAt: secondEvidenceAt,
          scanCursorWebhookEventId: 'second-evidence',
        },
      ]);
    const tx = createHistoricalRecoveryTransaction();
    const refreshQueue = { enqueue: jest.fn().mockResolvedValue(undefined) };
    const service = new PublisherEntityBindingLifecycleService(
      {
        $queryRaw: queryRaw,
        $transaction: jest.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
      } as never,
      refreshQueue as never,
      { get: () => 'publik_bot' } as never,
      createBotRegistry() as never,
    );

    await expect(service.recoverHistoricalActorCandidates(now, 1)).resolves.toBe(1);
    await expect(service.recoverHistoricalActorCandidates(now, 1)).resolves.toBe(1);

    const secondStatement = queryRaw.mock.calls[1]?.[0] as { values: unknown[] };
    expect(secondStatement.values).toContain(firstEvidenceAt);
    expect(secondStatement.values).toContain('first-evidence');
    expect(secondStatement.values).not.toContain(rawBoundaryAt);
    expect(secondStatement.values).not.toContain('raw-page-boundary');
    expect(refreshQueue.enqueue).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        chatId: '-91002',
        candidateUserId: '81002',
        candidateVersion: 'historical:second-evidence',
      }),
    );
  });
});
