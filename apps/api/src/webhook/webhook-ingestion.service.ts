import {
  ForbiddenException,
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { MaxBotRegistryService } from '../max/max-bot-registry.service';
import { WebhookIngressMetricsService } from '../system/webhook-ingress-metrics.service';
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
    @Optional() private readonly webhookIngressMetricsService?: WebhookIngressMetricsService,
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

    const ip = request.ip;
    const update = this.parser.parse(payload, { botId: bot.id });
    const receiptPersistenceStartedAtMs = Date.now();
    let result: Awaited<ReturnType<WebhookService['storeReceipt']>>;
    try {
      result = await this.webhookService.storeReceipt(update, ip);
    } catch (error: unknown) {
      this.recordReceiptPersistenceAsync({
        botId: bot.id,
        outcome: 'failed',
        latencyMs: Date.now() - receiptPersistenceStartedAtMs,
      });
      this.logger.error(
        {
          botId: bot.id,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to persist webhook receipt; requesting MAX redelivery',
      );
      throw new ServiceUnavailableException('Webhook receipt storage unavailable');
    }
    this.recordReceiptPersistenceAsync({
      botId: bot.id,
      outcome: 'persisted',
      latencyMs: Date.now() - receiptPersistenceStartedAtMs,
    });
    this.runPostReceiptIngressAccounting(bot.id, ip);

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

  private runPostReceiptIngressAccounting(botId: string, ip: string): void {
    this.markIncomingWebhookAsync(botId);
    void this.webhookRateLimitService
      .isAllowed(ip)
      .then((allowed) => {
        if (allowed) {
          return;
        }
        this.logger.warn(
          {
            botId,
            ip,
          },
          'Webhook ingress rate limit exceeded after durable receipt; event remains accepted',
        );
      })
      .catch((error: unknown) => {
        this.logger.warn(
          {
            botId,
            ip,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to account webhook ingress rate after durable receipt',
        );
      });
  }

  private recordReceiptPersistenceAsync(
    metric: Parameters<WebhookIngressMetricsService['recordReceiptPersistence']>[0],
  ): void {
    const metricsService = this.webhookIngressMetricsService;
    if (!metricsService) {
      return;
    }
    setImmediate(() => {
      void metricsService.recordReceiptPersistence(metric).catch(() => undefined);
    });
  }
}
