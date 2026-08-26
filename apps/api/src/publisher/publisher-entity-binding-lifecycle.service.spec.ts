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
  });
});
