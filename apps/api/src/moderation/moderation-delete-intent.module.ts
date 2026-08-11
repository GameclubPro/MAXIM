import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { MaxModule } from '../max/max.module';
import { getAppRole, roleRunsAction } from '../runtime/app-role';
import { ModerationDeleteIntentProcessor } from './moderation-delete-intent.processor';
import { MODERATION_DELETE_INTENT_QUEUE } from './moderation-delete-intent.queue';
import { ModerationDeleteIntentReconcilerService } from './moderation-delete-intent-reconciler.service';
import { ModerationDeleteIntentService } from './moderation-delete-intent.service';
import { LinkHistoryDeleteGuardService } from './link-history-delete-guard.service';

const actionRoleProviders = roleRunsAction(getAppRole())
  ? [ModerationDeleteIntentProcessor, ModerationDeleteIntentReconcilerService]
  : [];

@Module({
  imports: [BullModule.registerQueue({ name: MODERATION_DELETE_INTENT_QUEUE }), MaxModule],
  providers: [LinkHistoryDeleteGuardService, ModerationDeleteIntentService, ...actionRoleProviders],
  exports: [ModerationDeleteIntentService],
})
export class ModerationDeleteIntentModule {}
