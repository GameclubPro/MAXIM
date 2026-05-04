import { ForbiddenException } from '@nestjs/common';
import { WebhookController } from './webhook.controller';

describe('WebhookController', () => {
  const botRegistry = {
    resolveWebhookBot: jest.fn(({ botId, secretPath, providedHeaderSecret }) => {
      if (
        botId === 'bot-1' &&
        secretPath === 'secret-path' &&
        (providedHeaderSecret === 'secret-header' || providedHeaderSecret === 'secret-header-prev')
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

  it('rejects invalid route signature', async () => {
    const controller = new WebhookController(
      botRegistry as never,
      parser as never,
      webhookService as never,
      { isAllowed: jest.fn().mockResolvedValue(true) } as never,
      { markIncomingWebhook: jest.fn() } as never,
    );

    await expect(
      controller.receive({ botId: 'wrong', secretPath: 'bad' }, {}, {
        headers: { 'x-max-bot-api-secret': 'secret-header' },
        ip: '127.0.0.1',
      } as never),
    ).rejects.toThrow(ForbiddenException);
  });

  it('accepts valid signed webhook even when local rate limit is exceeded', async () => {
    const controller = new WebhookController(
      botRegistry as never,
      parser as never,
      webhookService as never,
      { isAllowed: jest.fn().mockResolvedValue(false) } as never,
      { markIncomingWebhook: jest.fn() } as never,
    );

    await expect(
      controller.receive({ botId: 'bot-1', secretPath: 'secret-path' }, {}, {
        headers: { 'x-max-bot-api-secret': 'secret-header' },
        ip: '127.0.0.1',
      } as never),
    ).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        duplicate: false,
      }),
    );
    expect(parser.parse).toHaveBeenCalled();
    expect(webhookService.ingest).toHaveBeenCalled();
  });

  it('accepts the previous webhook header secret during rotation', async () => {
    const webhookSubscriptionStatusService = {
      markIncomingWebhook: jest.fn().mockResolvedValue(undefined),
    };
    const controller = new WebhookController(
      botRegistry as never,
      parser as never,
      webhookService as never,
      { isAllowed: jest.fn().mockResolvedValue(true) } as never,
      webhookSubscriptionStatusService as never,
    );

    await expect(
      controller.receive({ botId: 'bot-1', secretPath: 'secret-path' }, {}, {
        headers: { 'x-max-bot-api-secret': 'secret-header-prev' },
        ip: '127.0.0.1',
      } as never),
    ).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        duplicate: false,
      }),
    );
    expect(webhookSubscriptionStatusService.markIncomingWebhook).toHaveBeenCalledWith('bot-1');
  });
});
