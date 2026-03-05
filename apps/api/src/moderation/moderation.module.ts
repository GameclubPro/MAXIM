import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module';
import { ChatContextModule } from '../chat-context/chat-context.module';
import { MaxModule } from '../max/max.module';
import { getAppRole, roleRunsModeration } from '../runtime/app-role';
import { SystemModule } from '../system/system.module';
import { ModerationProcessor, ModerationService } from './moderation.service';
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
  ...(roleRunsModeration(getAppRole()) ? [ModerationProcessor] : []),
];

@Module({
  imports: [
    BullModule.registerQueue({ name: 'moderation' }),
    MaxModule,
    SystemModule,
    ChatContextModule,
    AdminModule,
  ],
  providers: moderationProviders,
  exports: [ModerationService],
})
export class ModerationModule {}
