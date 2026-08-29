import type { MaxUpdate } from '@maxim/contracts';
import { ConfigService } from '@nestjs/config';
import { PublisherAutoReplyDeliveryStatus } from '../prisma/prisma-client';
import {
  PublisherAutoReplyProducerService,
  PublisherAutoReplyEnqueuePendingError,
} from './publisher-auto-reply-producer.service';

function update(type = 'message_created'): MaxUpdate {
  return {
    updateId: `update-${type}`,
    botId: 'publisher-bot',
    type,
    message: {
      messageId: 'message-1',
      chatId: '-100',
      entityType: 'chat',
      senderId: 'user-1',
      text: 'ПРАЙС',
      createdAt: '2026-08-29T12:00:00.000Z',
    },
    raw: {
      update_type: type,
      message: {
        body: { mid: 'message-1', text: 'ПРАЙС' },
        sender: { user_id: 'user-1' },
        recipient: { chat_id: '-100', chat_type: 'chat' },
      },
    },
  };
}

function harness(options: { duplicate?: boolean; queueFailure?: Error } = {}) {
  const delivery = {
    id: 'delivery-1',
    status: PublisherAutoReplyDeliveryStatus.PENDING,
    dueAt: new Date('2026-08-29T12:00:01.500Z'),
    dispatchStartedAt: null,
  };
  const prisma = {
    chat: {
      findFirst: jest.fn().mockResolvedValue({
        publisherSettings: { autoRepliesEnabled: true, revision: 4 },
        publicationPolicy: { publikEnabled: true, revision: 2 },
        publisherAutoReplyRules: [
          {
            id: 'rule-1',
            version: 3,
            normalizedPhrase: 'прайс',
            currentContentRevisionId: 'content-1',
          },
        ],
      }),
    },
    publisherAutoReplyDelivery: {
      createMany: jest.fn().mockResolvedValue({ count: options.duplicate ? 0 : 1 }),
      findUnique: jest.fn().mockResolvedValue(delivery),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const queue = {
    assertAdmissionEnabled: jest.fn().mockResolvedValue(undefined),
    ensureDeliveryJob: options.queueFailure
      ? jest.fn().mockRejectedValue(options.queueFailure)
      : jest.fn().mockResolvedValue(undefined),
  };
  const service = new PublisherAutoReplyProducerService(
    prisma as never,
    queue as never,
    { isKnownBotUserId: jest.fn().mockReturnValue(false) } as never,
    {
      get: jest.fn((key: string, fallback?: unknown) => {
        if (key === 'MAX_PUBLISHER_BOT_ID') return 'publisher-bot';
        if (key === 'PUBLISHER_AUTO_REPLY_DELAY_MS') return 1_500;
        return fallback;
      }),
    } as unknown as ConfigService,
  );
  return { service, prisma, queue, delivery };
}

describe('PublisherAutoReplyProducerService', () => {
  it('freezes the matching epochs before enqueueing only the delivery id', async () => {
    const { service, prisma, queue } = harness();
    await expect(service.observeWebhook(update(), 'webhook-1')).resolves.toEqual({ matched: true });

    expect(prisma.publisherAutoReplyDelivery.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          chatId: '-100',
          ruleId: 'rule-1',
          contentRevisionId: 'content-1',
          publisherBotId: 'publisher-bot',
          sourceMessageId: 'message-1',
          sourceUserId: 'user-1',
          matchedRuleVersion: 3,
          matchedNormalizedPhrase: 'прайс',
          publisherSettingsRevision: 4,
          publicationPolicyRevision: 2,
        }),
      ],
      skipDuplicates: true,
    });
    expect(queue.ensureDeliveryJob).toHaveBeenCalledWith('delivery-1', expect.any(Date));
  });

  it('ensures the pending job again after a duplicate webhook claim', async () => {
    const { service, queue } = harness({ duplicate: true });
    await expect(service.observeWebhook(update())).resolves.toEqual({ matched: true });
    expect(queue.ensureDeliveryJob).toHaveBeenCalledTimes(1);
  });

  it('defers the webhook when a durable delivery cannot be confirmed in BullMQ', async () => {
    const { service } = harness({ queueFailure: new Error('redis unavailable') });
    await expect(service.observeWebhook(update())).rejects.toBeInstanceOf(
      PublisherAutoReplyEnqueuePendingError,
    );
  });

  it.each(['message_edited', 'message_removed'] as const)(
    'cancels an unsent delivery on %s without creating another one',
    async (type) => {
      const { service, prisma, queue } = harness();
      await expect(service.observeWebhook(update(type))).resolves.toEqual({ matched: false });
      expect(prisma.publisherAutoReplyDelivery.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            chatId: '-100',
            sourceMessageId: 'message-1',
            dispatchStartedAt: null,
          }),
          data: expect.objectContaining({
            status: PublisherAutoReplyDeliveryStatus.CANCELED,
            failureCode: type === 'message_edited' ? 'SOURCE_EDITED' : 'SOURCE_REMOVED',
          }),
        }),
      );
      expect(prisma.chat.findFirst).not.toHaveBeenCalled();
      expect(queue.ensureDeliveryJob).not.toHaveBeenCalled();
    },
  );
});
