import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Logger,
  Post,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { InitDataGuard } from '../auth/init-data.guard';
import { CurrentUser, type AuthUser } from '../common/decorators/current-user.decorator';
import { QueueMetricsService } from './queue-metrics.service';
import { SystemModeService } from './system-mode.service';

const systemModeBodySchema = z.object({
  mode: z.enum(['normal', 'degrade', 'auto']),
});

const clientDebugBodySchema = z.object({
  source: z.string().trim().min(1).max(64),
  stage: z.string().trim().min(1).max(64),
  path: z.string().trim().min(1).max(512),
  chatId: z.string().trim().min(1).max(128).optional(),
  meta: z.record(z.string().trim().max(64), z.unknown()).optional(),
});

@Controller('v1/system')
@UseGuards(InitDataGuard)
export class SystemController {
  private readonly logger = new Logger(SystemController.name);

  constructor(
    private readonly queueMetricsService: QueueMetricsService,
    private readonly systemModeService: SystemModeService,
  ) {}

  @Get('metrics/queues')
  async getQueueMetrics() {
    const [queues, mode] = await Promise.all([
      this.queueMetricsService.getSnapshot(),
      Promise.resolve(this.systemModeService.getSnapshot()),
    ]);
    return { queues, mode };
  }

  @Get('mode')
  getMode() {
    return this.systemModeService.getSnapshot();
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

  @Post('client-debug')
  logClientDebug(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const parsed = clientDebugBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    this.logger.log(
      `MINIAPP_CLIENT_DEBUG ${JSON.stringify({
        userId: user.userId,
        ...parsed.data,
      })}`,
    );

    return { ok: true };
  }
}
