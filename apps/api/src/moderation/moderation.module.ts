import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module';
import { ChatContextModule } from '../chat-context/chat-context.module';
import { MaxModule } from '../max/max.module';
import { getAppRole, roleRunsModeration } from '../runtime/app-role';
import { SystemModule } from '../system/system.module';
import {
  BackgroundWebhookProcessor,
  CriticalWebhookProcessor,
  DefaultWebhookProcessor,
  LegacyModerationProcessor,
  ModerationService,
} from './moderation.service';
import { ALL_WEBHOOK_QUEUE_NAMES } from '../webhook/webhook-queues';
import { PrivateControlController } from './private-control.controller';
import { PrivateControlService } from './private-control.service';
import { RedisCounterService } from './redis-counter.service';
import { RuleEngineService } from './rule-engine.service';
import { SanctionService } from './sanction.service';

const moderationProviders = [
  ModerationService,
  PrivateControlService,
  RedisCounterService,
  RuleEngineService,
  SanctionService,
  ...(roleRunsModeration(getAppRole())
    ? [
        LegacyModerationProcessor,
        CriticalWebhookProcessor,
        DefaultWebhookProcessor,
        BackgroundWebhookProcessor,
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
