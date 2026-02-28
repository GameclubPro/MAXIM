import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get('live')
  live() {
    return {
      ok: true,
      timestamp: new Date().toISOString(),
    };
  }

  @Get('ready')
  ready() {
    return {
      ok: true,
      timestamp: new Date().toISOString(),
    };
  }
}
