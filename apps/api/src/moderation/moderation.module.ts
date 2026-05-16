import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module';
import { ChatContextModule } from '../chat-context/chat-context.module';
import { MaxModule } from '../max/max.module';
import { getAppRole, roleRunsModeration } from '../runtime/app-role';
import {
  getEnabledModerationProcessorQueues,
  getWebhookDynamicLeasesWorkerGroup,
} from '../runtime/moderation-runtime';
import {
  MODERATION_EXECUTION_LEGACY,
  ModerationExecutionService,
} from './moderation-execution.service';
import { SystemModule } from '../system/system.module';
import {
  BackgroundWebhookProcessor,
  CriticalWebhookProcessor,
  DEFAULT_WEBHOOK_SHARD_PROCESSORS,
  JOIN_WEBHOOK_SHARD_PROCESSORS,
  LegacyModerationProcessor,
  ModerationService,
} from './moderation.service';
import { DefaultWebhookLeaseManagerService } from './default-webhook-lease-manager.service';
import {
  ALL_WEBHOOK_QUEUE_NAMES,
  DEFAULT_WEBHOOK_QUEUE_NAMES,
  JOIN_WEBHOOK_QUEUE_NAMES,
  LEGACY_WEBHOOK_QUEUE,
  WEBHOOK_QUEUE_BACKGROUND,
  WEBHOOK_QUEUE_CRITICAL,
} from '../webhook/webhook-queues';
import { PrivateControlController } from './private-control.controller';
import { PrivateControlService } from './private-control.service';
import { RedisCounterService } from './redis-counter.service';
import { RuleEngineService } from './rule-engine.service';
import { SanctionService } from './sanction.service';

const enabledModerationQueues = getEnabledModerationProcessorQueues();
const dynamicDefaultWorkerGroup = getWebhookDynamicLeasesWorkerGroup();
const moderationProviders = [
  ModerationService,
  {
    provide: MODERATION_EXECUTION_LEGACY,
    useExisting: ModerationService,
  },
  ModerationExecutionService,
  PrivateControlService,
  RedisCounterService,
  RuleEngineService,
  SanctionService,
  ...(dynamicDefaultWorkerGroup ? [DefaultWebhookLeaseManagerService] : []),
  ...(roleRunsModeration(getAppRole())
    ? [
        ...(enabledModerationQueues.has(LEGACY_WEBHOOK_QUEUE) ? [LegacyModerationProcessor] : []),
        ...(enabledModerationQueues.has(WEBHOOK_QUEUE_CRITICAL) ? [CriticalWebhookProcessor] : []),
        ...JOIN_WEBHOOK_QUEUE_NAMES.flatMap((queueName, index) =>
          enabledModerationQueues.has(queueName) ? [JOIN_WEBHOOK_SHARD_PROCESSORS[index]!] : [],
        ),
        ...(dynamicDefaultWorkerGroup
          ? []
          : DEFAULT_WEBHOOK_QUEUE_NAMES.flatMap((queueName, index) =>
              enabledModerationQueues.has(queueName)
                ? [DEFAULT_WEBHOOK_SHARD_PROCESSORS[index]!]
                : [],
            )),
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
  exports: [ModerationExecutionService, ModerationService],
})
export class ModerationModule {}
