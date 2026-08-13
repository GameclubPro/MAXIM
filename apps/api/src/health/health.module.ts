import { Module } from '@nestjs/common';
import { ModerationModule } from '../moderation/moderation.module';
import { SystemModule } from '../system/system.module';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

@Module({
  imports: [SystemModule, ModerationModule],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
