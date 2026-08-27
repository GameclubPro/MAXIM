import { ChatBotAccessState, ChatBotMembershipStatus } from '../prisma/prisma-client';
import {
  PublisherEntityBindingLifecycleService,
  shouldApplyPublisherObservation,
} from './publisher-entity-binding-lifecycle.service';

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
      managedBotChatCatalog: { upsert: jest.fn(async () => ({ id: 'catalog-1' })) },
      managedEntityAccessEdge: { updateMany: jest.fn(async () => ({ count: 0 })) },
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
    expect(refreshQueue.enqueue).toHaveBeenCalledTimes(2);
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
      managedBotChatCatalog: { upsert: jest.fn(async () => ({ id: 'catalog-1' })) },
      managedEntityAccessEdge: { updateMany: jest.fn(async () => ({ count: 0 })) },
      publisherEntityBinding,
    };
    const prisma = {
      $transaction: jest.fn(async (callback: (tx: typeof transactionClient) => unknown) =>
        callback(transactionClient),
      ),
    };
    const refreshQueue = { enqueue: jest.fn(async () => undefined) };
    const service = new PublisherEntityBindingLifecycleService(
      prisma as never,
      refreshQueue as never,
      { get: () => 'publik_bot' } as never,
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
      $transaction: jest.fn(async (callback: (tx: typeof transactionClient) => unknown) =>
        callback(transactionClient),
      ),
    };
    const refreshQueue = { enqueue: jest.fn() };
    const service = new PublisherEntityBindingLifecycleService(
      prisma as never,
      refreshQueue as never,
      { get: () => 'publik_bot' } as never,
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
});
