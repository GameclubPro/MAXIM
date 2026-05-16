import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { MaxBotRegistryService } from '../max/max-bot-registry.service';
import { WebhookSubscriptionStatusService } from '../system/webhook-subscription-status.service';
import { WebhookParser } from './webhook.parser';
import { WebhookRateLimitService } from './webhook-rate-limit.service';
import { WebhookService } from './webhook.service';

export type WebhookIngestionParams = {
  botId: string;
  secretPath: string;
};

export type WebhookIngestionRequest = Pick<FastifyRequest, 'headers' | 'ip'>;

export type WebhookIngestionResult = {
  ok: true;
  duplicate: boolean;
  acceptedAt: string;
};

@Injectable()
export class WebhookIngestionService {
  private readonly logger = new Logger(WebhookIngestionService.name);

  constructor(
    private readonly botRegistry: MaxBotRegistryService,
    private readonly parser: WebhookParser,
    private readonly webhookService: WebhookService,
    private readonly webhookRateLimitService: WebhookRateLimitService,
    private readonly webhookSubscriptionStatusService: WebhookSubscriptionStatusService,
  ) {}

  async ingest(
    params: WebhookIngestionParams,
    payload: Record<string, unknown>,
    request: WebhookIngestionRequest,
  ): Promise<WebhookIngestionResult> {
    const bot = this.botRegistry.resolveWebhookBot({
      botId: params.botId,
      secretPath: params.secretPath,
      providedHeaderSecret: this.readWebhookHeaderSecret(request.headers),
    });
    if (!bot) {
      throw new ForbiddenException('Invalid webhook bot signature');
    }

    this.markIncomingWebhookAsync(bot.id);

    const ip = request.ip;
    const allowed = await this.webhookRateLimitService.isAllowed(ip);
    if (!allowed) {
      this.logger.warn(
        {
          botId: bot.id,
          ip,
        },
        'Webhook ingress rate limit exceeded after signature validation; accepting event to avoid MAX delivery retries',
      );
    }

    const update = this.parser.parse(payload, { botId: bot.id });
    const result = await this.webhookService.ingest(update, ip);

    return {
      ok: true,
      duplicate: result.duplicate,
      acceptedAt: new Date().toISOString(),
    };
  }

  private readWebhookHeaderSecret(headers: WebhookIngestionRequest['headers']): string {
    return String(headers['x-max-bot-api-secret'] ?? headers['x-max-secret'] ?? '');
  }

  private markIncomingWebhookAsync(botId: string): void {
    void Promise.resolve()
      .then(() => this.webhookSubscriptionStatusService.markIncomingWebhook(botId))
      .catch((error: unknown) => {
        this.logger.warn(
          {
            botId,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to persist incoming webhook status asynchronously',
        );
      });
  }
}
