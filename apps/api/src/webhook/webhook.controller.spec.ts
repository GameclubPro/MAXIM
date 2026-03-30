import { ForbiddenException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { WebhookController } from './webhook.controller';

describe('WebhookController', () => {
  const configService = {
    getOrThrow: jest.fn((key: string) => {
      const values: Record<string, string> = {
        MAX_BOT_ID: 'bot-1',
        MAX_WEBHOOK_SECRET_PATH: 'secret-path',
        MAX_WEBHOOK_HEADER_SECRET: 'secret-header',
      };
      return values[key];
    }),
    get: jest.fn((key: string) => {
      if (key === 'MAX_WEBHOOK_HEADER_SECRET_PREVIOUS') {
        return 'secret-header-prev';
      }
      return undefined;
    }),
  } as unknown as ConfigService;

  const parser = {
    parse: jest.fn().mockReturnValue({ updateId: '1', type: 'message_created' }),
  };

  const webhookService = {
    ingest: jest.fn().mockResolvedValue({ duplicate: false }),
  };

  it('rejects invalid route signature', async () => {
    const controller = new WebhookController(
      configService,
      parser as never,
      webhookService as never,
      { isAllowed: jest.fn().mockResolvedValue(true) } as never,
    );

    await expect(
      controller.receive({ botId: 'wrong', secretPath: 'bad' }, {}, {
        headers: { 'x-max-bot-api-secret': 'secret-header' },
        ip: '127.0.0.1',
      } as never),
    ).rejects.toThrow(ForbiddenException);
  });

  it('rejects when rate limit exceeded', async () => {
    const controller = new WebhookController(
      configService,
      parser as never,
      webhookService as never,
      { isAllowed: jest.fn().mockResolvedValue(false) } as never,
    );

    await expect(
      controller.receive({ botId: 'bot-1', secretPath: 'secret-path' }, {}, {
        headers: { 'x-max-bot-api-secret': 'secret-header' },
        ip: '127.0.0.1',
      } as never),
    ).rejects.toThrow('Webhook rate limit exceeded');
  });

  it('accepts the previous webhook header secret during rotation', async () => {
    const controller = new WebhookController(
      configService,
      parser as never,
      webhookService as never,
      { isAllowed: jest.fn().mockResolvedValue(true) } as never,
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
  });
});
