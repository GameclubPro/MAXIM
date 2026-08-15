import { ForbiddenException } from '@nestjs/common';
import {
  applyMaxWebhookAckDeadline,
  MAX_WEBHOOK_ROUTE_CONFIG_KEY,
} from './webhook-http-route-limit';
import { WebhookController } from './webhook.controller';

describe('WebhookController', () => {
  it('delegates invalid route signatures to the ingestion boundary', async () => {
    const webhookIngestionService = {
      ingest: jest.fn().mockRejectedValue(new ForbiddenException('Invalid webhook bot signature')),
    };
    const controller = new WebhookController(webhookIngestionService as never);

    await expect(
      controller.receive({ botId: 'wrong', secretPath: 'bad' }, {}, {
        headers: { 'x-max-bot-api-secret': 'secret-header' },
        ip: '127.0.0.1',
      } as never),
    ).rejects.toThrow(ForbiddenException);
    expect(webhookIngestionService.ingest).toHaveBeenCalled();
  });

  it('returns the ingestion result for accepted signed webhooks', async () => {
    const webhookIngestionService = {
      ingest: jest.fn().mockResolvedValue({
        ok: true,
        duplicate: false,
        acceptedAt: '2026-05-16T20:00:00.000Z',
      }),
    };
    const controller = new WebhookController(webhookIngestionService as never);
    const request = {
      headers: { 'x-max-bot-api-secret': 'secret-header' },
      ip: '127.0.0.1',
      routeOptions: { config: { [MAX_WEBHOOK_ROUTE_CONFIG_KEY]: true } },
    };
    applyMaxWebhookAckDeadline(request, 18_000, 1_000);

    await expect(
      controller.receive({ botId: 'bot-1', secretPath: 'secret-path' }, {}, request as never),
    ).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        duplicate: false,
      }),
    );
    expect(webhookIngestionService.ingest).toHaveBeenCalledWith(
      { botId: 'bot-1', secretPath: 'secret-path' },
      {},
      expect.objectContaining({ ip: '127.0.0.1' }),
      19_000,
    );
  });

  it('keeps header secret rotation inside the ingestion boundary', async () => {
    const webhookIngestionService = {
      ingest: jest.fn().mockResolvedValue({
        ok: true,
        duplicate: false,
        acceptedAt: '2026-05-16T20:00:00.000Z',
      }),
    };
    const controller = new WebhookController(webhookIngestionService as never);

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
    expect(webhookIngestionService.ingest).toHaveBeenCalledWith(
      { botId: 'bot-1', secretPath: 'secret-path' },
      {},
      expect.objectContaining({
        headers: { 'x-max-bot-api-secret': 'secret-header-prev' },
      }),
      null,
    );
  });
});
