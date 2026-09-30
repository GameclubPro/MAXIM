import { Module } from '@nestjs/common';
import { RedisCounterModule } from '../redis-counter.module';
import { MessageDuplicatePolicyService } from './message-duplicate-policy.service';
import { MessageDuplicateHistoryService } from './message-duplicate-history.service';
import { MessageDuplicateMetricsService } from './message-duplicate-metrics.service';
import { MessageDuplicateOrderingStore } from './message-duplicate.queue';
import { MessageDuplicateAuthorizationService } from './message-duplicate-authorization.service';
import { MessageDuplicateAdmissionService } from './message-duplicate-admission.service';

@Module({
  imports: [RedisCounterModule],
  providers: [
    MessageDuplicatePolicyService,
    MessageDuplicateHistoryService,
    MessageDuplicateMetricsService,
    MessageDuplicateOrderingStore,
    MessageDuplicateAuthorizationService,
    MessageDuplicateAdmissionService,
  ],
  exports: [
    MessageDuplicatePolicyService,
    MessageDuplicateHistoryService,
    MessageDuplicateMetricsService,
    MessageDuplicateOrderingStore,
    MessageDuplicateAuthorizationService,
    MessageDuplicateAdmissionService,
    RedisCounterModule,
  ],
})
export class MessageDuplicateStateModule {}
