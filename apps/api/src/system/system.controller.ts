import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import { InitDataGuard } from '../auth/init-data.guard';
import { CurrentUser, type AuthUser } from '../common/decorators/current-user.decorator';
import { QueueMetricsService } from './queue-metrics.service';
import { canUserAccessSystem, readSystemAccessConfig, type SystemAccessConfig } from './system-access.util';
import { SystemDashboardService } from './system-dashboard.service';
import { SystemModeService } from './system-mode.service';

const systemModeBodySchema = z.object({
  mode: z.enum(['normal', 'degrade', 'auto']),
});

@Controller('v1/system')
@UseGuards(InitDataGuard)
export class SystemController {
  private readonly systemAccessConfig: SystemAccessConfig;

  constructor(
    private readonly queueMetricsService: QueueMetricsService,
    private readonly systemModeService: SystemModeService,
    private readonly systemDashboardService: SystemDashboardService,
    configService: ConfigService,
  ) {
    this.systemAccessConfig = readSystemAccessConfig(configService);
  }

  @Get('metrics/queues')
  async getQueueMetrics(@CurrentUser() user: AuthUser) {
    this.assertSystemAdmin(user);
    const [queues, mode] = await Promise.all([
      this.queueMetricsService.getSnapshot(),
      this.systemModeService.getEffectiveSnapshot(),
    ]);
    return { queues, mode };
  }

  @Get('dashboard')
  async getDashboard(@CurrentUser() user: AuthUser) {
    this.assertSystemAdmin(user);
    return this.systemDashboardService.getSnapshot();
  }

  @Get('mode')
  async getMode(@CurrentUser() user: AuthUser) {
    this.assertSystemAdmin(user);
    return this.systemModeService.getEffectiveSnapshot();
  }

  @Post('mode')
  async setMode(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    this.assertSystemAdmin(user);
    const parsed = systemModeBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }
    const manualMode = parsed.data.mode === 'auto' ? null : parsed.data.mode;
    return this.systemModeService.setManualMode(manualMode);
  }

  private assertSystemAdmin(user: AuthUser) {
    if (canUserAccessSystem(user.userId, this.systemAccessConfig)) {
      return;
    }

    throw new ForbiddenException('System access denied');
  }
}
