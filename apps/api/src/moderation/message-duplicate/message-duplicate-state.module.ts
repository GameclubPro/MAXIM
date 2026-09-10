import { Module } from '@nestjs/common';
import { RedisCounterModule } from '../redis-counter.module';
import { MessageDuplicatePolicyService } from './message-duplicate-policy.service';
import { MessageDuplicateHistoryService } from './message-duplicate-history.service';

@Module({
  imports: [RedisCounterModule],
  providers: [MessageDuplicatePolicyService, MessageDuplicateHistoryService],
  exports: [MessageDuplicatePolicyService, MessageDuplicateHistoryService, RedisCounterModule],
})
export class MessageDuplicateStateModule {}
