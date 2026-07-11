import { BullModule } from '@nestjs/bullmq';
import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ChatContextModule } from '../chat-context/chat-context.module';
import { NightModeTransitionModule } from '../moderation/night-mode-transition.module';
import { getAppRole, roleRunsAction } from '../runtime/app-role';
import { SystemModule } from '../system/system.module';
import { ManagedEntityAccessLossService } from './managed-entity-access-loss.service';
import { MaxActionDispatchService } from './max-action-dispatch.service';
import { MaxActionLedgerService } from './max-action-ledger.service';
import {
  MaxActionBackgroundProcessor,
  MaxActionCriticalProcessor,
  MaxActionInteractiveProcessor,
  MaxActionProcessor,
} from './max-action.processor';
import { MAX_ACTION_ALL_QUEUE_NAMES } from './max-action.queue';
import { MaxChatAdminRosterSyncProcessor } from './max-chat-admin-roster-sync.processor';
import { MAX_CHAT_ADMIN_ROSTER_SYNC_QUEUE } from './max-chat-admin-roster-sync.queue';
import { MaxChatAdminRosterSyncService } from './max-chat-admin-roster-sync.service';
import { MaxBotExecutionPlannerService } from './max-bot-execution-planner.service';
import { MaxClientService } from './max-client.service';
import { MaxMembershipLookupService } from './max-membership-lookup.service';
import { MaxRoutedPublicationService } from './max-routed-publication.service';
import { MaxWebhookSubscriptionReconcilerService } from './max-webhook-subscription-reconciler.service';
import { ManagedEntityAccessWriter } from './managed-entity-access-writer.service';
import { ManagedEntityHandshakeService } from './managed-entity-handshake.service';
import { ManagedEntityHandshakeOutcomeService } from './managed-entity-handshake-outcome.service';
import { MaxBotModule } from './max-bot.module';

const maxProviders = [
  MaxClientService,
  MaxActionDispatchService,
  MaxActionLedgerService,
  MaxChatAdminRosterSyncService,
  MaxBotExecutionPlannerService,
  MaxMembershipLookupService,
  MaxRoutedPublicationService,
  MaxWebhookSubscriptionReconcilerService,
  ManagedEntityAccessLossService,
  ManagedEntityAccessWriter,
  ManagedEntityHandshakeOutcomeService,
  ManagedEntityHandshakeService,
  ...(roleRunsAction(getAppRole())
    ? [
        MaxActionProcessor,
        MaxActionCriticalProcessor,
        MaxActionInteractiveProcessor,
        MaxActionBackgroundProcessor,
      ]
    : []),
  ...(roleRunsAction(getAppRole()) ? [MaxChatAdminRosterSyncProcessor] : []),
];

@Module({
  imports: [
    HttpModule.register({
      timeout: 5_000,
      maxRedirects: 0,
    }),
    SystemModule,
    MaxBotModule,
    ChatContextModule,
    NightModeTransitionModule,
    BullModule.registerQueue(...MAX_ACTION_ALL_QUEUE_NAMES.map((name) => ({ name }))),
    BullModule.registerQueue({ name: MAX_CHAT_ADMIN_ROSTER_SYNC_QUEUE }),
  ],
  providers: maxProviders,
  exports: [
    MaxClientService,
    MaxActionDispatchService,
    MaxActionLedgerService,
    MaxChatAdminRosterSyncService,
    MaxBotExecutionPlannerService,
    MaxMembershipLookupService,
    MaxRoutedPublicationService,
    MaxWebhookSubscriptionReconcilerService,
    ManagedEntityAccessLossService,
    ManagedEntityAccessWriter,
    ManagedEntityHandshakeOutcomeService,
    ManagedEntityHandshakeService,
  ],
})
export class MaxModule {}
