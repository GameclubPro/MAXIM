import { ForbiddenException } from '@nestjs/common';
import { WebhookIngestionService } from './webhook-ingestion.service';

describe('WebhookIngestionService', () => {
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
      ingest: jest.fn().mockResolvedValue({ duplicate: false }),
    };
    const webhookRateLimitService = {
      isAllowed: jest.fn().mockResolvedValue(overrides.allowed ?? true),
    };
    const webhookSubscriptionStatusService = {
      markIncomingWebhook: jest.fn().mockResolvedValue(undefined),
    };

    return {
      service: new WebhookIngestionService(
        botRegistry as never,
        parser as never,
        webhookService as never,
        webhookRateLimitService as never,
        webhookSubscriptionStatusService as never,
      ),
      botRegistry,
      parser,
      webhookService,
      webhookRateLimitService,
      webhookSubscriptionStatusService,
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
    expect(webhookService.ingest).not.toHaveBeenCalled();
  });

  it('accepts signed webhooks even when the local ingress limiter is over budget', async () => {
    const { service, parser, webhookService, webhookRateLimitService } = createService({
      allowed: false,
    });

    await expect(
      service.ingest({ botId: 'bot-1', secretPath: 'secret-path' }, { type: 'message_created' }, {
        headers: { 'x-max-bot-api-secret': 'secret-header' },
        ip: '127.0.0.1',
      } as never),
    ).resolves.toEqual(expect.objectContaining({ ok: true, duplicate: false }));
    expect(webhookRateLimitService.isAllowed).toHaveBeenCalledWith('127.0.0.1');
    expect(parser.parse).toHaveBeenCalledWith({ type: 'message_created' }, { botId: 'bot-1' });
    expect(webhookService.ingest).toHaveBeenCalledWith(
      { updateId: '1', type: 'message_created' },
      '127.0.0.1',
    );
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
});
