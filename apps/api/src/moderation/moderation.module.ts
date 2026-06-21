import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module';
import { ChatContextModule } from '../chat-context/chat-context.module';
import { MaxModule } from '../max/max.module';
import { getAppRole, roleRunsModeration } from '../runtime/app-role';
import {
  getEnabledModerationProcessorQueues,
  getWebhookDynamicLeasesWorkerGroup,
  spammerDenormProcessorEnabled,
} from '../runtime/moderation-runtime';
import {
  MODERATION_EXECUTION_LEGACY,
  ModerationExecutionService,
} from './moderation-execution.service';
import { NightModeTransitionModule } from './night-mode-transition.module';
import { NightModeTransitionProcessor } from './night-mode-transition.processor';
import { GlobalSpammerDenormProcessor } from './global-spammer-denorm.processor';
import { GLOBAL_SPAMMER_DENORM_QUEUE } from './global-spammer-denorm.queue';
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
import { GlobalSpammerArchiveRunnerService } from './global-spammer-archive-runner.service';
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
import { GlobalSpammerIntelligenceService } from './global-spammer-intelligence.service';
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
  GlobalSpammerIntelligenceService,
  GlobalSpammerArchiveRunnerService,
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
        ...(enabledModerationQueues.has(WEBHOOK_QUEUE_BACKGROUND) && roleRunsModeration(getAppRole())
          ? [NightModeTransitionProcessor]
          : []),
        ...(spammerDenormProcessorEnabled() ? [GlobalSpammerDenormProcessor] : []),
      ]
    : []),
];

@Module({
  imports: [
    BullModule.registerQueue(...ALL_WEBHOOK_QUEUE_NAMES.map((name) => ({ name }))),
    BullModule.registerQueue({ name: GLOBAL_SPAMMER_DENORM_QUEUE }),
    MaxModule,
    SystemModule,
    ChatContextModule,
    AdminModule,
    NightModeTransitionModule,
  ],
  controllers: [PrivateControlController],
  providers: moderationProviders,
  exports: [ModerationExecutionService, ModerationService, GlobalSpammerIntelligenceService],
})
export class ModerationModule {}
