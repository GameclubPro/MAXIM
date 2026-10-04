import { registerRuntimeQueues } from '../runtime/runtime-queues';
import { SuggestionSubscriptionModule } from '../suggestions/suggestion-subscription.module';
import { Module } from '@nestjs/common';

import { MaxModule } from '../max/max.module';
import { SystemRuntimeModule } from '../system/system-runtime.module';
import { MessageRetentionStateModule } from '../message-retention/message-retention-state.module';
import { MessageRetentionDeleteGuard } from '../message-retention/message-retention-delete-guard.service';
import { ReportStateModule } from './reports/report-state.module';
import { ReportDeleteGuardService } from './reports/report-delete-guard.service';
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
import { CommercialDeleteGuardService } from './commercial/commercial-delete-guard.service';
import { CommercialTextRuntimePolicyModule } from './commercial/commercial-text-runtime-policy.module';
import { CommercialReviewService } from './commercial/commercial-review.service';
import { StopWordsDeleteGuardService } from './stop-words/stop-words-delete-guard.service';
import { TrafficProtectionDeleteGuardService } from './traffic-protection-delete-guard.service';
import { RuleEngineModule } from './rule-engine.module';
import { MessageDuplicateStateModule } from './message-duplicate/message-duplicate-state.module';
import { MessageDuplicateDeleteGuardService } from './message-duplicate/message-duplicate-delete-guard.service';
import { MessageDuplicateCleanupReconcilerService } from './message-duplicate/message-duplicate-cleanup-reconciler.service';

const actionRoleProviders = roleRunsAction(getAppRole())
  ? [
      ModerationDeleteIntentProcessor,
      ModerationDeleteIntentReconcilerService,
      MessageDuplicateCleanupReconcilerService,
    ]
  : [];

@Module({
  imports: [
    SuggestionSubscriptionModule,
    SystemRuntimeModule,
    MessageRetentionStateModule,
    ...registerRuntimeQueues(MODERATION_DELETE_INTENT_QUEUE),
    MaxModule,
    ReportStateModule,
    RuleEngineModule,
    MessageDuplicateStateModule,
    CommercialTextRuntimePolicyModule,
  ],
  providers: [
    MessageRetentionDeleteGuard,
    ReportDeleteGuardService,
    LinkHistoryDeleteGuardService,
    ParticipantModerationImmunityService,
    ProfanityDeleteGuardService,
    CommercialDeleteGuardService,
    CommercialReviewService,
    StopWordsDeleteGuardService,
    TrafficProtectionDeleteGuardService,
    CommercialOcrDeleteGuardService,
    CommercialOcrRuntimePolicyService,
    PhotoDuplicateRuntimePolicyService,
    MessageDuplicateDeleteGuardService,
    ModerationDeleteIntentService,
    ...actionRoleProviders,
  ],
  exports: [
    MessageRetentionDeleteGuard,
    StopWordsDeleteGuardService,
    ModerationDeleteIntentService,
    ParticipantModerationImmunityService,
    ProfanityDeleteGuardService,
    CommercialDeleteGuardService,
    CommercialReviewService,
    CommercialOcrRuntimePolicyService,
    PhotoDuplicateRuntimePolicyService,
    MessageDuplicateDeleteGuardService,
  ],
})
export class ModerationDeleteIntentModule {}
