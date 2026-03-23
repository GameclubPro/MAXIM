import { BadRequestException, Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { InitDataGuard } from '../auth/init-data.guard';
import { QueueMetricsService } from './queue-metrics.service';
import { SystemModeService } from './system-mode.service';

const systemModeBodySchema = z.object({
  mode: z.enum(['normal', 'degrade', 'auto']),
});

@Controller('v1/system')
@UseGuards(InitDataGuard)
export class SystemController {
  constructor(
    private readonly queueMetricsService: QueueMetricsService,
    private readonly systemModeService: SystemModeService,
  ) {}

  @Get('metrics/queues')
  async getQueueMetrics() {
    const [queues, mode] = await Promise.all([
      this.queueMetricsService.getSnapshot(),
      this.systemModeService.getEffectiveSnapshot(),
    ]);
    return { queues, mode };
  }

  @Get('mode')
  async getMode() {
    return this.systemModeService.getEffectiveSnapshot();
  }

  @Post('mode')
  async setMode(@Body() body: unknown) {
    const parsed = systemModeBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }
    const manualMode = parsed.data.mode === 'auto' ? null : parsed.data.mode;
    return this.systemModeService.setManualMode(manualMode);
  }
}
