import { Global, Module } from '@nestjs/common';
import { ModerationSanctionStateFenceService } from './moderation-sanction-state-fence.service';
import { ModerationSanctionStateLockService } from './moderation-sanction-state-lock.service';
import { RedisCounterService } from './redis-counter.service';

@Global()
@Module({
  providers: [
    RedisCounterService,
    ModerationSanctionStateLockService,
    ModerationSanctionStateFenceService,
  ],
  exports: [
    RedisCounterService,
    ModerationSanctionStateLockService,
    ModerationSanctionStateFenceService,
  ],
})
export class RedisCounterModule {}
