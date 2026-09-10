import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { MaxModule } from '../max/max.module';
import { getAppRole, roleRunsAction } from '../runtime/app-role';
import { ModerationDeleteIntentProcessor } from './moderation-delete-intent.processor';
import { MODERATION_DELETE_INTENT_QUEUE } from './moderation-delete-intent.queue';
import { ModerationDeleteIntentReconcilerService } from './moderation-delete-intent-reconciler.service';
import { ModerationDeleteIntentService } from './moderation-delete-intent.service';
import { LinkHistoryDeleteGuardService } from './link-history-delete-guard.service';
import { ParticipantModerationImmunityService } from './participant-moderation-immunity.service';
import { PhotoDuplicateRuntimePolicyService } from './photo-duplicate/photo-duplicate-runtime-policy.service';
import { CommercialOcrDeleteGuardService } from './commercial-ocr/commercial-ocr-delete-guard.service';
import { CommercialOcrRuntimePolicyService } from './commercial-ocr/commercial-ocr-runtime-policy.service';
import { ProfanityDeleteGuardService } from './profanity/profanity-delete-guard.service';
import { RuleEngineModule } from './rule-engine.module';
import { MessageDuplicateStateModule } from './message-duplicate/message-duplicate-state.module';
import { MessageDuplicateDeleteGuardService } from './message-duplicate/message-duplicate-delete-guard.service';

const actionRoleProviders = roleRunsAction(getAppRole())
  ? [ModerationDeleteIntentProcessor, ModerationDeleteIntentReconcilerService]
  : [];

@Module({
  imports: [
    BullModule.registerQueue({ name: MODERATION_DELETE_INTENT_QUEUE }),
    MaxModule,
    RuleEngineModule,
    MessageDuplicateStateModule,
  ],
  providers: [
    LinkHistoryDeleteGuardService,
    ParticipantModerationImmunityService,
    ProfanityDeleteGuardService,
    CommercialOcrDeleteGuardService,
    CommercialOcrRuntimePolicyService,
    PhotoDuplicateRuntimePolicyService,
    MessageDuplicateDeleteGuardService,
    ModerationDeleteIntentService,
    ...actionRoleProviders,
  ],
  exports: [
    ModerationDeleteIntentService,
    ParticipantModerationImmunityService,
    ProfanityDeleteGuardService,
    CommercialOcrRuntimePolicyService,
    PhotoDuplicateRuntimePolicyService,
    MessageDuplicateDeleteGuardService,
  ],
})
export class ModerationDeleteIntentModule {}
