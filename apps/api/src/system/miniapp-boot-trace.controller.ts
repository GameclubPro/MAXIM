import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { MiniappBootTraceService } from './miniapp-boot-trace.service';

@Controller('v1/system')
export class MiniappBootTraceController {
  constructor(private readonly miniappBootTraceService: MiniappBootTraceService) {}

  @Post('miniapp-boot-trace')
  @HttpCode(200)
  async record(@Body() body: unknown, @Req() request: FastifyRequest) {
    await this.miniappBootTraceService.record(body, request.ip);
    return { ok: true };
  }
}
