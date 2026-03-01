import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ActionHealthService } from './action-health.service';
import { QueueMetricsService } from './queue-metrics.service';
import { SystemController } from './system.controller';
import { SystemModeService } from './system-mode.service';

@Module({
  imports: [
    AuthModule,
    BullModule.registerQueue({ name: 'moderation' }),
    BullModule.registerQueue({ name: 'moderation-actions' }),
  ],
  controllers: [SystemController],
  providers: [QueueMetricsService, ActionHealthService, SystemModeService],
  exports: [QueueMetricsService, ActionHealthService, SystemModeService],
})
export class SystemModule {}
