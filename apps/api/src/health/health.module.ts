import { Module } from '@nestjs/common';
import { ModerationModule } from '../moderation/moderation.module';
import { SystemModule } from '../system/system.module';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';
import { OcrReadinessHeartbeatService } from './ocr-readiness-heartbeat.service';
import { OcrReadinessStateModule } from './ocr-readiness-state.module';

@Module({
  imports: [SystemModule, ModerationModule, OcrReadinessStateModule],
  controllers: [HealthController],
  providers: [HealthService, OcrReadinessHeartbeatService],
})
export class HealthModule {}
