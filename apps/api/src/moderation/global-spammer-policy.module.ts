import { Module } from '@nestjs/common';
import { MaxModule } from '../max/max.module';
import { SystemRuntimeModule } from '../system/system-runtime.module';
import { registerRuntimeQueues } from '../runtime/runtime-queues';
import { GLOBAL_SPAMMER_DENORM_QUEUE } from './global-spammer-denorm.queue';
import { GlobalSpammerIntelligenceService } from './global-spammer-intelligence.service';
import { RedisCounterModule } from './redis-counter.module';

@Module({
  imports: [
    MaxModule,
    SystemRuntimeModule,
    RedisCounterModule,
    ...registerRuntimeQueues(GLOBAL_SPAMMER_DENORM_QUEUE),
  ],
  providers: [GlobalSpammerIntelligenceService],
  exports: [GlobalSpammerIntelligenceService],
})
export class GlobalSpammerPolicyModule {}
