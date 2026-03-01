import { Module } from '@nestjs/common';
import { SystemModule } from '../system/system.module';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

@Module({
  imports: [SystemModule],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
