import { Body, Controller, HttpCode, HttpStatus, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { RouteConfig } from '@nestjs/platform-fastify';
import {
  MAX_WEBHOOK_ROUTE_CONFIG_KEY,
  readMaxWebhookAckDeadlineAtMs,
} from './webhook-http-route-limit';
import { WebhookIngestionService } from './webhook-ingestion.service';

type WebhookParams = {
  botId: string;
  secretPath: string;
};

@Controller('webhook/max')
export class WebhookController {
  constructor(private readonly webhookIngestionService: WebhookIngestionService) {}

  @Post(':botId/:secretPath')
  @HttpCode(HttpStatus.OK)
  @RouteConfig({ [MAX_WEBHOOK_ROUTE_CONFIG_KEY]: true })
  async receive(
    @Param() params: WebhookParams,
    @Body() payload: Record<string, unknown>,
    @Req() request: FastifyRequest,
  ) {
    return this.webhookIngestionService.ingest(
      params,
      payload,
      request,
      readMaxWebhookAckDeadlineAtMs(request),
    );
  }
}
