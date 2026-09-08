import { Module } from '@nestjs/common';

import { SystemModule } from '../system/system.module';
import { RedisCounterModule } from './redis-counter.module';
import { RuleEngineService } from './rule-engine.service';

@Module({
  imports: [RedisCounterModule, SystemModule],
  providers: [RuleEngineService],
  exports: [RuleEngineService],
})
export class RuleEngineModule {}
