import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { HealthService } from './health.service';

@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get('live')
  live() {
    return this.healthService.live();
  }

  @Get('ready')
  async ready() {
    const snapshot = await this.healthService.ready();
    if (!snapshot.ok) {
      throw new ServiceUnavailableException(snapshot);
    }
    return snapshot;
  }
}
