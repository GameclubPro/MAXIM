import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { MaxModule } from '../max/max.module';
import { PublisherActionCredentialService } from './publisher-action-credential.service';
import { PublisherBackgroundWorkCoordinatorService } from './publisher-background-work-coordinator.service';
import { PublisherBindingRefreshProcessor } from './publisher-binding-refresh.processor';
import {
  PUBLISHER_CHAT_COMMENT_QUEUE,
  PublisherChatCommentQueueService,
} from './publisher-chat-comment.queue';
import {
  PUBLISHER_BINDING_REFRESH_QUEUE,
  PublisherBindingRefreshQueueService,
} from './publisher-binding-refresh.queue';
import {
  PublisherBindingRefreshSchedulerService,
  PublisherBindingRefreshService,
} from './publisher-binding-refresh.service';
import { PublisherDispatchHealthService } from './publisher-dispatch-health.service';
import { PublisherEntityBindingLifecycleService } from './publisher-entity-binding-lifecycle.service';
import { PublisherIdentityAttestationService } from './publisher-identity-attestation.service';
import { PublisherRuntimeBoundaryService } from './publisher-runtime-boundary.service';
import { getAppRole, roleRunsPublisher } from '../runtime/app-role';
import {
  PublisherRuntimeHeartbeatReaderService,
  PublisherRuntimeHeartbeatWriterService,
} from './publisher-runtime-heartbeat.service';
import { PublisherWebhookSubscriptionReconcilerService } from './publisher-webhook-subscription-reconciler.service';
import { PublisherDialogLinkService } from './publisher-dialog-link.service';
import { PublisherChatCommentProducerService } from './publisher-chat-comment-producer.service';
import { PublisherDialogSigningKeyService } from './publisher-dialog-signing-key.service';
import {
  PUBLISHER_POST_IMPORT_QUEUE,
  PublisherPostImportQueueService,
} from './publisher-post-import.queue';
import { PublisherPostImportService } from './publisher-post-import.service';
import { PublisherPostImportRecoveryService } from './publisher-post-import-recovery.service';
import {
  PUBLISHER_AUTO_REPLY_QUEUE,
  PublisherAutoReplyQueueService,
} from './publisher-auto-reply.queue';
import { PublisherAutoReplyProducerService } from './publisher-auto-reply-producer.service';
import { PublisherAutoReplyFloodGateService } from './publisher-auto-reply-flood-gate.service';
import { PublisherAutoReplySourceFenceService } from './publisher-auto-reply-source-fence.service';
import {
  PUBLISHER_AUTO_REPLY_AUTHORING_QUEUE,
  PublisherAutoReplyAuthoringQueueService,
} from './publisher-auto-reply-authoring.queue';
import { PublisherAutoReplyAuthoringService } from './publisher-auto-reply-authoring.service';
import { PublisherAutoReplyAuthoringRecoveryService } from './publisher-auto-reply-authoring-recovery.service';
import { PublisherAutoReplyContentCaptureService } from './publisher-auto-reply-content-capture.service';
import { PublisherPrivateDialogFlowRouterService } from './publisher-private-dialog-flow-router.service';
import { PublisherPrivateFlowLeaseService } from './publisher-private-flow-lease.service';
import {
  PUBLISHER_SUGGESTION_ADMIN_QUEUE,
  PublisherSuggestionAdminQueueService,
} from './publisher-suggestion-admin.queue';
import { PublisherSuggestionAdminCallbackObserverService } from './publisher-suggestion-admin-callback-observer.service';

const publisherRuntimeProviders = roleRunsPublisher(getAppRole())
  ? [
      PublisherActionCredentialService,
      PublisherIdentityAttestationService,
      PublisherRuntimeBoundaryService,
      PublisherRuntimeHeartbeatWriterService,
      PublisherBindingRefreshService,
      PublisherBindingRefreshProcessor,
      PublisherBindingRefreshSchedulerService,
      PublisherWebhookSubscriptionReconcilerService,
      PublisherPostImportRecoveryService,
      PublisherAutoReplyAuthoringRecoveryService,
      PublisherAutoReplyContentCaptureService,
    ]
  : [];

const sharedPublisherProviders = [
  PublisherBackgroundWorkCoordinatorService,
  PublisherRuntimeHeartbeatReaderService,
  PublisherBindingRefreshQueueService,
  PublisherChatCommentQueueService,
  PublisherDispatchHealthService,
  PublisherEntityBindingLifecycleService,
  PublisherDialogSigningKeyService,
  PublisherDialogLinkService,
  PublisherChatCommentProducerService,
  PublisherPostImportQueueService,
  PublisherPostImportService,
  PublisherAutoReplyQueueService,
  PublisherAutoReplyFloodGateService,
  PublisherAutoReplySourceFenceService,
  PublisherAutoReplyProducerService,
  PublisherAutoReplyAuthoringQueueService,
  PublisherAutoReplyAuthoringService,
  PublisherSuggestionAdminQueueService,
  PublisherSuggestionAdminCallbackObserverService,
  PublisherPrivateFlowLeaseService,
  PublisherPrivateDialogFlowRouterService,
];

@Global()
@Module({
  imports: [
    MaxModule,
    BullModule.registerQueue(
      { name: PUBLISHER_BINDING_REFRESH_QUEUE },
      { name: PUBLISHER_CHAT_COMMENT_QUEUE },
      { name: PUBLISHER_POST_IMPORT_QUEUE },
      { name: PUBLISHER_AUTO_REPLY_QUEUE },
      { name: PUBLISHER_AUTO_REPLY_AUTHORING_QUEUE },
      { name: PUBLISHER_SUGGESTION_ADMIN_QUEUE },
    ),
  ],
  providers: [...sharedPublisherProviders, ...publisherRuntimeProviders],
  exports: [...sharedPublisherProviders, ...publisherRuntimeProviders],
})
export class PublisherModule {}
