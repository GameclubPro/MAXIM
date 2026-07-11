import { ForbiddenException } from '@nestjs/common';
import { WebhookIngestionService } from './webhook-ingestion.service';

describe('WebhookIngestionService', () => {
  const flushImmediate = () => new Promise<void>((resolve) => setImmediate(resolve));

  const createService = (overrides: { allowed?: boolean; bot?: { id: string } | null } = {}) => {
    const botRegistry = {
      resolveWebhookBot: jest.fn(({ botId, secretPath, providedHeaderSecret }) => {
        if (overrides.bot !== undefined) {
          return overrides.bot;
        }
        if (
          botId === 'bot-1' &&
          secretPath === 'secret-path' &&
          providedHeaderSecret === 'secret-header'
        ) {
          return { id: 'bot-1' };
        }
        return null;
      }),
    };
    const parser = {
      parse: jest.fn().mockReturnValue({ updateId: '1', type: 'message_created' }),
    };
    const webhookService = {
      storeReceipt: jest.fn().mockResolvedValue({
        duplicate: false,
        webhookEventId: 'event-1',
      }),
      schedulePersistedWebhookPreparation: jest.fn(),
    };
    const webhookRateLimitService = {
      isAllowed: jest.fn().mockResolvedValue(overrides.allowed ?? true),
    };
    const webhookSubscriptionStatusService = {
      markIncomingWebhook: jest.fn().mockResolvedValue(undefined),
    };
    const webhookIngressMetricsService = {
      recordReceiptPersistence: jest.fn().mockResolvedValue(undefined),
    };

    return {
      service: new WebhookIngestionService(
        botRegistry as never,
        parser as never,
        webhookService as never,
        webhookRateLimitService as never,
        webhookSubscriptionStatusService as never,
        webhookIngressMetricsService as never,
      ),
      botRegistry,
      parser,
      webhookService,
      webhookRateLimitService,
      webhookSubscriptionStatusService,
      webhookIngressMetricsService,
    };
  };

  it('rejects invalid route or header signatures before parsing', async () => {
    const { service, parser, webhookService } = createService();

    await expect(
      service.ingest({ botId: 'wrong', secretPath: 'bad' }, {}, {
        headers: { 'x-max-bot-api-secret': 'secret-header' },
        ip: '127.0.0.1',
      } as never),
    ).rejects.toThrow(ForbiddenException);
    expect(parser.parse).not.toHaveBeenCalled();
    expect(webhookService.storeReceipt).not.toHaveBeenCalled();
  });

  it('accepts signed webhooks even when the local ingress limiter is over budget', async () => {
    const {
      service,
      parser,
      webhookService,
      webhookRateLimitService,
      webhookIngressMetricsService,
    } = createService({ allowed: false });

    await expect(
      service.ingest({ botId: 'bot-1', secretPath: 'secret-path' }, { type: 'message_created' }, {
        headers: { 'x-max-bot-api-secret': 'secret-header' },
        ip: '127.0.0.1',
      } as never),
    ).resolves.toEqual(expect.objectContaining({ ok: true, duplicate: false }));
    expect(webhookRateLimitService.isAllowed).toHaveBeenCalledWith('127.0.0.1');
    expect(parser.parse).toHaveBeenCalledWith({ type: 'message_created' }, { botId: 'bot-1' });
    expect(webhookService.storeReceipt).toHaveBeenCalledWith(
      { updateId: '1', type: 'message_created' },
      '127.0.0.1',
    );
    expect(webhookService.schedulePersistedWebhookPreparation).not.toHaveBeenCalled();
    await flushImmediate();
    expect(webhookIngressMetricsService.recordReceiptPersistence).toHaveBeenCalledWith({
      botId: 'bot-1',
      outcome: 'persisted',
      latencyMs: expect.any(Number),
    });
  });

  it('records incoming webhook status asynchronously', async () => {
    const { service, webhookSubscriptionStatusService } = createService();

    await service.ingest({ botId: 'bot-1', secretPath: 'secret-path' }, {}, {
      headers: { 'x-max-bot-api-secret': 'secret-header' },
      ip: '127.0.0.1',
    } as never);
    await Promise.resolve();

    expect(webhookSubscriptionStatusService.markIncomingWebhook).toHaveBeenCalledWith('bot-1');
  });

  it('acknowledges a legacy-compatible duplicate without scheduling business preparation', async () => {
    const { service, webhookService } = createService();
    webhookService.storeReceipt.mockResolvedValueOnce({
      duplicate: true,
      webhookEventId: null,
    });

    await expect(
      service.ingest({ botId: 'bot-1', secretPath: 'secret-path' }, {}, {
        headers: { 'x-max-bot-api-secret': 'secret-header' },
        ip: '127.0.0.1',
      } as never),
    ).resolves.toEqual(expect.objectContaining({ ok: true, duplicate: true }));

    expect(webhookService.schedulePersistedWebhookPreparation).not.toHaveBeenCalled();
  });

  it('returns a retryable service error when the durable receipt cannot be stored', async () => {
    const { service, webhookService, webhookRateLimitService, webhookIngressMetricsService } =
      createService();
    webhookService.storeReceipt.mockRejectedValueOnce(new Error('postgres unavailable'));

    await expect(
      service.ingest({ botId: 'bot-1', secretPath: 'secret-path' }, {}, {
        headers: { 'x-max-bot-api-secret': 'secret-header' },
        ip: '127.0.0.1',
      } as never),
    ).rejects.toMatchObject({ status: 503 });

    expect(webhookService.schedulePersistedWebhookPreparation).not.toHaveBeenCalled();
    expect(webhookRateLimitService.isAllowed).not.toHaveBeenCalled();
    await flushImmediate();
    expect(webhookIngressMetricsService.recordReceiptPersistence).toHaveBeenCalledWith({
      botId: 'bot-1',
      outcome: 'failed',
      latencyMs: expect.any(Number),
    });
  });

  it('does not wait for Redis metric persistence before resolving the webhook ACK path', async () => {
    const { service, webhookIngressMetricsService } = createService();
    webhookIngressMetricsService.recordReceiptPersistence.mockReturnValueOnce(
      new Promise<void>(() => undefined),
    );

    await expect(
      service.ingest({ botId: 'bot-1', secretPath: 'secret-path' }, {}, {
        headers: { 'x-max-bot-api-secret': 'secret-header' },
        ip: '127.0.0.1',
      } as never),
    ).resolves.toMatchObject({ ok: true });
    await flushImmediate();
    expect(webhookIngressMetricsService.recordReceiptPersistence).toHaveBeenCalledTimes(1);
  });
});
