import {
  Body,
  Controller,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FastifyRequest } from 'fastify';
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
    private readonly configService: ConfigService,
    private readonly parser: WebhookParser,
    private readonly webhookService: WebhookService,
    private readonly webhookRateLimitService: WebhookRateLimitService,
  ) {}

  @Post(':botId/:secretPath')
  async receive(
    @Param() params: WebhookParams,
    @Body() payload: Record<string, unknown>,
    @Req() request: FastifyRequest,
  ) {
    const expectedBotId = this.configService.getOrThrow<string>('MAX_BOT_ID');
    const expectedSecretPath = this.configService.getOrThrow<string>('MAX_WEBHOOK_SECRET_PATH');
    const expectedHeaderSecret = this.configService.getOrThrow<string>('MAX_WEBHOOK_HEADER_SECRET');

    if (params.botId !== expectedBotId || params.secretPath !== expectedSecretPath) {
      throw new ForbiddenException('Invalid webhook route signature');
    }

    const providedHeaderSecret = String(request.headers['x-max-secret'] ?? '');
    if (providedHeaderSecret !== expectedHeaderSecret) {
      throw new ForbiddenException('Invalid webhook header secret');
    }

    const ip = request.ip;
    const allowed = await this.webhookRateLimitService.isAllowed(ip);
    if (!allowed) {
      throw new HttpException('Webhook rate limit exceeded', HttpStatus.TOO_MANY_REQUESTS);
    }

    const update = this.parser.parse(payload);
    const result = await this.webhookService.ingest(update, ip);

    return {
      ok: true,
      duplicate: result.duplicate,
      acceptedAt: new Date().toISOString(),
    };
  }
}
