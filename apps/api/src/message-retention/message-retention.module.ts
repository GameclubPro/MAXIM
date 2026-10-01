import { registerRuntimeQueues } from '../runtime/runtime-queues';
import { Module } from '@nestjs/common';
import { ModerationDeleteIntentModule } from '../moderation/moderation-delete-intent.module';
import { SystemRuntimeModule } from '../system/system-runtime.module';
import { getAppRole } from '../runtime/app-role';
import { RedisCounterModule } from '../moderation/redis-counter.module';
import { MessageRetentionStateModule } from './message-retention-state.module';
import { MessageRetentionRuntime } from './message-retention-runtime.service';
import { MessageRetentionProcessor } from './message-retention.processor';
import { MESSAGE_RETENTION_QUEUE } from './message-retention.policy';

@Module({
  imports: [
    MessageRetentionStateModule,
    SystemRuntimeModule,
    ModerationDeleteIntentModule,
    RedisCounterModule,
    ...registerRuntimeQueues(MESSAGE_RETENTION_QUEUE),
  ],
  providers:
    getAppRole() === 'message-retention' || getAppRole() === 'all'
      ? [MessageRetentionRuntime, MessageRetentionProcessor]
      : [],
})
export class MessageRetentionModule {}
