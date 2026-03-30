import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module';
import { ChatContextModule } from '../chat-context/chat-context.module';
import { MaxModule } from '../max/max.module';
import { getAppRole, roleRunsModeration } from '../runtime/app-role';
import { getEnabledModerationProcessorQueues } from '../runtime/moderation-runtime';
import { SystemModule } from '../system/system.module';
import {
  BackgroundWebhookProcessor,
  CriticalWebhookProcessor,
  DefaultWebhookShard0Processor,
  DefaultWebhookShard1Processor,
  DefaultWebhookShard2Processor,
  DefaultWebhookShard3Processor,
  LegacyModerationProcessor,
  ModerationService,
} from './moderation.service';
import {
  ALL_WEBHOOK_QUEUE_NAMES,
  LEGACY_WEBHOOK_QUEUE,
  WEBHOOK_QUEUE_BACKGROUND,
  WEBHOOK_QUEUE_CRITICAL,
  WEBHOOK_QUEUE_DEFAULT_SHARD_0,
  WEBHOOK_QUEUE_DEFAULT_SHARD_1,
  WEBHOOK_QUEUE_DEFAULT_SHARD_2,
  WEBHOOK_QUEUE_DEFAULT_SHARD_3,
} from '../webhook/webhook-queues';
import { PrivateControlController } from './private-control.controller';
import { PrivateControlService } from './private-control.service';
import { RedisCounterService } from './redis-counter.service';
import { RuleEngineService } from './rule-engine.service';
import { SanctionService } from './sanction.service';

const enabledModerationQueues = getEnabledModerationProcessorQueues();
const moderationProviders = [
  ModerationService,
  PrivateControlService,
  RedisCounterService,
  RuleEngineService,
  SanctionService,
  ...(roleRunsModeration(getAppRole())
    ? [
        ...(enabledModerationQueues.has(LEGACY_WEBHOOK_QUEUE) ? [LegacyModerationProcessor] : []),
        ...(enabledModerationQueues.has(WEBHOOK_QUEUE_CRITICAL) ? [CriticalWebhookProcessor] : []),
        ...(enabledModerationQueues.has(WEBHOOK_QUEUE_DEFAULT_SHARD_0)
          ? [DefaultWebhookShard0Processor]
          : []),
        ...(enabledModerationQueues.has(WEBHOOK_QUEUE_DEFAULT_SHARD_1)
          ? [DefaultWebhookShard1Processor]
          : []),
        ...(enabledModerationQueues.has(WEBHOOK_QUEUE_DEFAULT_SHARD_2)
          ? [DefaultWebhookShard2Processor]
          : []),
        ...(enabledModerationQueues.has(WEBHOOK_QUEUE_DEFAULT_SHARD_3)
          ? [DefaultWebhookShard3Processor]
          : []),
        ...(enabledModerationQueues.has(WEBHOOK_QUEUE_BACKGROUND)
          ? [BackgroundWebhookProcessor]
          : []),
      ]
    : []),
];

@Module({
  imports: [
    BullModule.registerQueue(...ALL_WEBHOOK_QUEUE_NAMES.map((name) => ({ name }))),
    MaxModule,
    SystemModule,
    ChatContextModule,
    AdminModule,
  ],
  controllers: [PrivateControlController],
  providers: moderationProviders,
  exports: [ModerationService],
})
export class ModerationModule {}
