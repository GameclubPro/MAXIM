import { Module } from '@nestjs/common';

import { SystemRuntimeModule } from '../system/system-runtime.module';
import { RedisCounterModule } from './redis-counter.module';
import { RuleEngineService } from './rule-engine.service';
import { CommercialTextRuntimePolicyModule } from './commercial/commercial-text-runtime-policy.module';

@Module({
  imports: [RedisCounterModule, SystemRuntimeModule, CommercialTextRuntimePolicyModule],
  providers: [RuleEngineService],
  exports: [RuleEngineService],
})
export class RuleEngineModule {}
