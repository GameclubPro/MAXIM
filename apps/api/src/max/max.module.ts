import { BullModule } from '@nestjs/bullmq';
import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ChatContextModule } from '../chat-context/chat-context.module';
import { getAppRole, roleRunsAction } from '../runtime/app-role';
import { SystemModule } from '../system/system.module';
import { MaxActionDispatchService } from './max-action-dispatch.service';
import { MaxActionProcessor } from './max-action.processor';
import { MaxChatAdminRosterSyncProcessor } from './max-chat-admin-roster-sync.processor';
import { MAX_CHAT_ADMIN_ROSTER_SYNC_QUEUE } from './max-chat-admin-roster-sync.queue';
import { MaxChatAdminRosterSyncService } from './max-chat-admin-roster-sync.service';
import { MaxBotExecutionPlannerService } from './max-bot-execution-planner.service';
import { MaxClientService } from './max-client.service';
import { MaxMembershipLookupService } from './max-membership-lookup.service';
import { MaxWebhookSubscriptionReconcilerService } from './max-webhook-subscription-reconciler.service';

const maxProviders = [
  MaxClientService,
  MaxActionDispatchService,
  MaxChatAdminRosterSyncService,
  MaxBotExecutionPlannerService,
  MaxMembershipLookupService,
  MaxWebhookSubscriptionReconcilerService,
  ...(roleRunsAction(getAppRole()) ? [MaxActionProcessor] : []),
  ...(roleRunsAction(getAppRole()) ? [MaxChatAdminRosterSyncProcessor] : []),
];

@Module({
  imports: [
    HttpModule.register({
      timeout: 5_000,
      maxRedirects: 0,
    }),
    SystemModule,
    ChatContextModule,
    BullModule.registerQueue({ name: 'moderation-actions' }),
    BullModule.registerQueue({ name: MAX_CHAT_ADMIN_ROSTER_SYNC_QUEUE }),
  ],
  providers: maxProviders,
  exports: [
    MaxClientService,
    MaxActionDispatchService,
    MaxChatAdminRosterSyncService,
    MaxBotExecutionPlannerService,
    MaxMembershipLookupService,
    MaxWebhookSubscriptionReconcilerService,
  ],
})
export class MaxModule {}
