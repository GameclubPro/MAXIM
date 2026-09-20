import { Module } from '@nestjs/common';
import { RedisCounterModule } from '../redis-counter.module';
import { MessageDuplicatePolicyService } from './message-duplicate-policy.service';
import { MessageDuplicateHistoryService } from './message-duplicate-history.service';
import { MessageDuplicateMetricsService } from './message-duplicate-metrics.service';

@Module({
  imports: [RedisCounterModule],
  providers: [
    MessageDuplicatePolicyService,
    MessageDuplicateHistoryService,
    MessageDuplicateMetricsService,
  ],
  exports: [
    MessageDuplicatePolicyService,
    MessageDuplicateHistoryService,
    MessageDuplicateMetricsService,
    RedisCounterModule,
  ],
})
export class MessageDuplicateStateModule {}
