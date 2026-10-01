import { Module } from '@nestjs/common';

import { SystemModule } from '../system/system.module';
import { RedisCounterModule } from './redis-counter.module';
import { RuleEngineService } from './rule-engine.service';
import { CommercialTextRuntimePolicyModule } from './commercial/commercial-text-runtime-policy.module';

@Module({
  imports: [RedisCounterModule, SystemModule, CommercialTextRuntimePolicyModule],
  providers: [RuleEngineService],
  exports: [RuleEngineService],
})
export class RuleEngineModule {}
