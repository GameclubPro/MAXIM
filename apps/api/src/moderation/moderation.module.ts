import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { MaxModule } from '../max/max.module';
import { ModerationProcessor, ModerationService } from './moderation.service';
import { RedisCounterService } from './redis-counter.service';
import { RuleEngineService } from './rule-engine.service';
import { SanctionService } from './sanction.service';

@Module({
  imports: [BullModule.registerQueue({ name: 'moderation' }), MaxModule],
  providers: [
    ModerationService,
    ModerationProcessor,
    RedisCounterService,
    RuleEngineService,
    SanctionService,
  ],
  exports: [ModerationService],
})
export class ModerationModule {}
