import { WebhookStatus } from '../prisma/prisma-client';
import { WebhookService } from '../webhook/webhook.service';

describe('publisher webhook isolation', () => {
  it('settles a publisher receipt after lifecycle handling without binding or moderation routing', async () => {
    const update = {
      updateId: 'publisher-added-1',
      botId: 'publik_bot',
      type: 'bot_added',
      eventTimestampSource: 'remote',
      message: {
        messageId: 'bot_added:publisher-added-1',
        chatId: 'chat-1',
        senderId: 'admin-1',
        text: '',
        createdAt: '2026-08-26T12:00:00.000Z',
      },
      raw: {},
    };
    const prisma = {
      webhookEvent: {
        findUnique: jest.fn(async () => ({
          id: 'receipt-1',
          dedupKey: 'publik_bot:publisher-added-1',
          botId: 'publik_bot',
          status: WebhookStatus.RECEIVED,
          normalizedPayload: update,
        })),
        updateMany: jest.fn(async () => ({ count: 1 })),
      },
    };
    const config = {
      get: jest.fn((key: string, fallback: unknown) => {
        if (key === 'MAX_PUBLISHER_BOT_ID') {
          return 'publik_bot';
        }
        if (key === 'WEBHOOK_CANONICAL_EXECUTION_MODE') {
          return 'on';
        }
        return fallback;
      }),
    };
    const maxBotLink = new Proxy(
      {},
      {
        get: () => {
          throw new Error('publisher webhook must not touch main-bot routing');
        },
      },
    );
    const publisherLifecycle = {
      isPublisherUpdate: jest.fn(() => true),
      observeWebhook: jest.fn(async () => 'applied'),
    };
    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLink as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      publisherLifecycle as never,
    );

    await expect(service.preparePersistedWebhookEvent('receipt-1')).resolves.toEqual({
      canonical: false,
      prepared: true,
      normalizedPayload: update,
      executionBotId: null,
      enforced: true,
    });
    expect(publisherLifecycle.observeWebhook).toHaveBeenCalledWith(update);
    expect(prisma.webhookEvent.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'receipt-1',
        status: {
          in: [WebhookStatus.RECEIVED, WebhookStatus.FAILED, WebhookStatus.QUEUED],
        },
      },
      data: expect.objectContaining({
        status: WebhookStatus.PROCESSED,
        queueName: null,
        errorMessage: null,
      }),
    });
  });

  it('fails closed when the publisher lifecycle provider is unavailable', async () => {
    const config = {
      get: jest.fn((key: string, fallback: unknown) =>
        key === 'MAX_PUBLISHER_BOT_ID' ? 'publik_bot' : fallback,
      ),
    };
    const service = new WebhookService(
      {} as never,
      config as never,
      {} as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    );

    await expect(
      service.repairDuplicateReceiptReadModels({
        updateId: 'publisher-duplicate-1',
        botId: 'publik_bot',
        type: 'bot_added',
        raw: {},
      } as never),
    ).rejects.toThrow('Publisher webhook lifecycle boundary is unavailable');
  });
});
