import {
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { MaxBotRegistryService } from '../max/max-bot-registry.service';
import { WebhookSubscriptionStatusService } from '../system/webhook-subscription-status.service';
import { WebhookParser } from './webhook.parser';
import { WebhookRateLimitService } from './webhook-rate-limit.service';
import { WebhookService } from './webhook.service';

type WebhookParams = {
  botId: string;
  secretPath: string;
};

@Controller('webhook/max')
export class WebhookController {
  private readonly logger = new Logger(WebhookController.name);

  constructor(
    private readonly botRegistry: MaxBotRegistryService,
    private readonly parser: WebhookParser,
    private readonly webhookService: WebhookService,
    private readonly webhookRateLimitService: WebhookRateLimitService,
    private readonly webhookSubscriptionStatusService: WebhookSubscriptionStatusService,
  ) {}

  @Post(':botId/:secretPath')
  @HttpCode(HttpStatus.OK)
  async receive(
    @Param() params: WebhookParams,
    @Body() payload: Record<string, unknown>,
    @Req() request: FastifyRequest,
  ) {
    const providedHeaderSecret = String(
      request.headers['x-max-bot-api-secret'] ?? request.headers['x-max-secret'] ?? '',
    );
    const bot = this.botRegistry.resolveWebhookBot({
      botId: params.botId,
      secretPath: params.secretPath,
      providedHeaderSecret,
    });
    if (!bot) {
      throw new ForbiddenException('Invalid webhook bot signature');
    }

    void Promise.resolve()
      .then(() => this.webhookSubscriptionStatusService.markIncomingWebhook(bot.id))
      .catch((error: unknown) => {
        this.logger.warn(
          {
            botId: bot.id,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to persist incoming webhook status asynchronously',
        );
      });

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
}
