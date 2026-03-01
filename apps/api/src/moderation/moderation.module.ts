import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { MaxModule } from '../max/max.module';
import { getAppRole, roleRunsModeration } from '../runtime/app-role';
import { SystemModule } from '../system/system.module';
import { ChatContextCacheService } from './chat-context-cache.service';
import { ModerationProcessor, ModerationService } from './moderation.service';
import { RedisCounterService } from './redis-counter.service';
import { RuleEngineService } from './rule-engine.service';
import { SanctionService } from './sanction.service';

const moderationProviders = [
  ModerationService,
  ChatContextCacheService,
  RedisCounterService,
  RuleEngineService,
  SanctionService,
  ...(roleRunsModeration(getAppRole()) ? [ModerationProcessor] : []),
];

@Module({
  imports: [BullModule.registerQueue({ name: 'moderation' }), MaxModule, SystemModule],
  providers: moderationProviders,
  exports: [ModerationService, ChatContextCacheService],
})
export class ModerationModule {}
