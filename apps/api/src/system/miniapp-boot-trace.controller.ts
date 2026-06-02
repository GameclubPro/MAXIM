import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { MiniappBootTraceService } from './miniapp-boot-trace.service';

@Controller('v1/system')
export class MiniappBootTraceController {
  constructor(private readonly miniappBootTraceService: MiniappBootTraceService) {}

  @Post('miniapp-boot-trace')
  @HttpCode(200)
  record(@Body() body: unknown) {
    this.miniappBootTraceService.record(body);
    return { ok: true };
  }
}
