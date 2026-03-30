import {
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { MaxBotRegistryService } from '../max/max-bot-registry.service';
import { WebhookParser } from './webhook.parser';
import { WebhookRateLimitService } from './webhook-rate-limit.service';
import { WebhookService } from './webhook.service';

type WebhookParams = {
  botId: string;
  secretPath: string;
};

@Controller('webhook/max')
export class WebhookController {
  constructor(
    private readonly botRegistry: MaxBotRegistryService,
    private readonly parser: WebhookParser,
    private readonly webhookService: WebhookService,
    private readonly webhookRateLimitService: WebhookRateLimitService,
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

    const ip = request.ip;
    const allowed = await this.webhookRateLimitService.isAllowed(ip);
    if (!allowed) {
      throw new HttpException('Webhook rate limit exceeded', HttpStatus.TOO_MANY_REQUESTS);
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
