import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { MaxModule } from '../max/max.module';
import { PublisherActionCredentialService } from './publisher-action-credential.service';
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
  PublisherBindingBootstrapSchedulerService,
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

const publisherRuntimeProviders = roleRunsPublisher(getAppRole())
  ? [
      PublisherActionCredentialService,
      PublisherIdentityAttestationService,
      PublisherRuntimeBoundaryService,
      PublisherRuntimeHeartbeatWriterService,
      PublisherBindingRefreshService,
      PublisherBindingRefreshProcessor,
      PublisherBindingBootstrapSchedulerService,
      PublisherWebhookSubscriptionReconcilerService,
    ]
  : [];

const sharedPublisherProviders = [
  PublisherRuntimeHeartbeatReaderService,
  PublisherBindingRefreshQueueService,
  PublisherChatCommentQueueService,
  PublisherDispatchHealthService,
  PublisherEntityBindingLifecycleService,
];

@Global()
@Module({
  imports: [
    MaxModule,
    BullModule.registerQueue(
      { name: PUBLISHER_BINDING_REFRESH_QUEUE },
      { name: PUBLISHER_CHAT_COMMENT_QUEUE },
    ),
  ],
  providers: [...sharedPublisherProviders, ...publisherRuntimeProviders],
  exports: [...sharedPublisherProviders, ...publisherRuntimeProviders],
})
export class PublisherModule {}
