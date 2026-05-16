import { Body, Controller, HttpCode, HttpStatus, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
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
  async receive(
    @Param() params: WebhookParams,
    @Body() payload: Record<string, unknown>,
    @Req() request: FastifyRequest,
  ) {
    return this.webhookIngestionService.ingest(params, payload, request);
  }
}
