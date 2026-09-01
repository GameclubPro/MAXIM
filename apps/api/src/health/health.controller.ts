import {
  BadRequestException,
  Controller,
  Get,
  Query,
  ServiceUnavailableException,
} from '@nestjs/common';
import { HealthService } from './health.service';

@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get('live')
  live() {
    return this.healthService.live();
  }

  @Get('ready')
  async ready(@Query('scope') scope: string | string[] | undefined) {
    if (scope !== undefined && scope !== 'ocr') {
      throw new BadRequestException('Unsupported readiness scope');
    }

    const snapshot =
      scope === 'ocr' ? this.healthService.ocrReady() : await this.healthService.ready();
    if (!snapshot.ok) {
      throw new ServiceUnavailableException(snapshot);
    }
    return snapshot;
  }

  @Get('bot-load')
  async botLoad(@Query('bots') bots: string | string[] | undefined) {
    const requestedBots = Array.isArray(bots)
      ? bots.flatMap((value) => value.split(','))
      : typeof bots === 'string'
        ? bots.split(',')
        : [];
    const normalizedBotIds = [
      ...new Set(requestedBots.map((botId) => botId.trim()).filter(Boolean)),
    ];
    if (normalizedBotIds.length > 16) {
      throw new BadRequestException('Too many bot ids requested');
    }

    return this.healthService.botLoad(normalizedBotIds);
  }
}
