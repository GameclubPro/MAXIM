import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ChatContextModule } from '../chat-context/chat-context.module';
import { MaxModule } from '../max/max.module';
import { RedisCounterModule } from '../moderation/redis-counter.module';
import { PublisherModule } from '../publisher/publisher.module';
import { GlobalSpammerIntelligenceService } from '../moderation/global-spammer-intelligence.service';
import { NightModeTransitionModule } from '../moderation/night-mode-transition.module';
import { ModerationDeleteIntentModule } from '../moderation/moderation-delete-intent.module';
import { getAppRole, roleRunsAction, roleRunsPublisher } from '../runtime/app-role';
import { SystemModule } from '../system/system.module';
import { AdminManagedEntitiesRefreshProcessor } from './admin-managed-entities-refresh.processor';
import { ADMIN_MANAGED_ENTITIES_REFRESH_QUEUE } from './admin-managed-entities-refresh.queue';
import { AdminManualFanoutProcessor } from './admin-manual-fanout.processor';
import { ADMIN_MANUAL_FANOUT_QUEUE } from './admin-manual-fanout.queue';
import { AdminManualMessageCleanupService } from './admin-manual-message-cleanup.service';
import { AdminSuggestionDeliveryProcessor } from './admin-suggestion-delivery.processor';
import { ADMIN_SUGGESTION_DELIVERY_QUEUE } from './admin-suggestion-delivery.queue';
import { AdminSuggestionDeliveryRecoveryService } from './admin-suggestion-delivery-recovery.service';
import { AdminSuperBanProcessor } from './admin-super-ban.processor';
import { ADMIN_SUPER_BAN_QUEUE } from './admin-super-ban.queue';
import { AdminAutopostController } from './admin-autopost.controller';
import { AdminBroadcastController } from './admin-broadcast.controller';
import { AdminDialogController } from './admin-dialog.controller';
import { AdminGiveawayController } from './admin-giveaway.controller';
import { AdminManualModerationController } from './admin-manual-moderation.controller';
import { AdminPollController } from './admin-poll.controller';
import { AdminDialogLinkService } from './admin-dialog-link.service';
import { AdminSettingsService } from './admin-settings.service';
import { AdminManagedEntitiesController } from './admin-managed-entities.controller';
import { AdminSettingsController } from './admin-settings.controller';
import { PublisherVkParsingController } from './publisher-vk-parsing.controller';
import { ChannelDialogService } from './channel-dialog.service';
import { ChannelPostSignatureService } from './channel-post-signature.service';
import { CHANNEL_DIALOG_LEGACY_PORT } from './channel-dialog-legacy.port';
import { ManualModerationService } from './manual-moderation.service';
import { ManagedBroadcastRunnerService } from './managed-broadcast-runner.service';
import { ManagedBroadcastService } from './managed-broadcast.service';
import { ManagedAutopostRunnerService } from './managed-autopost-runner.service';
import { ManagedAutopostService } from './managed-autopost.service';
import { ManagedEntityCandidateSyncService } from './managed-entity-candidate-sync.service';
import { ManagedEntitiesDiscoveryService } from './managed-entities-discovery.service';
import { ManagedEntitiesService } from './managed-entities.service';
import { MANAGED_ENTITIES_LEGACY_PORT } from './managed-entities-legacy.port';
import { ManagedGiveawayRunnerService } from './managed-giveaway-runner.service';
import { ManagedGiveawayService } from './managed-giveaway.service';
import { ManagedPollService } from './managed-poll.service';
import { ManagedPollRunnerService } from './managed-poll-runner.service';
import { PublicationController } from './publication.controller';
import { PublicationContentService } from './publication-content.service';
import { PublicationLegacyService } from './publication-legacy.service';
import { PublicationMetricsInterceptor } from './publication-metrics.interceptor';
import { PublicationPresenterService } from './publication-presenter.service';
import { PublicationRunnerService } from './publication-runner.service';
import { PublicationService } from './publication.service';
import { PublicationPublisherRoutingService } from './publication-publisher-routing.service';
import { PublisherDialogContextService } from './publisher-dialog-context.service';
import { PublisherPublicationDispatchRunnerService } from './publisher-publication-dispatch-runner.service';
import { AdminService } from './admin.service';
import { ChannelStatsCollectorService } from './channel-stats-collector.service';
import { VkParsingPublisherProcessor } from './vk-parsing-publisher.processor';
import { VkParsingRunnerService } from './vk-parsing-runner.service';
import { VkParsingSyncProcessor } from './vk-parsing-sync.processor';
import {
  VK_PARSING_PUBLISHER_QUEUE,
  VK_PARSING_SYNC_QUEUE,
} from './vk-parsing.queue';
import { VkApiClientService } from './vk-api-client.service';
import { VkParsingAccessService } from './vk-parsing-access.service';
import { VkParsingFeedService } from './vk-parsing-feed.service';
import { VkParsingMediaCacheService } from './vk-parsing-media-cache.service';
import { VkParsingOwnershipService } from './vk-parsing-ownership.service';
import { VkParsingPostImportRepository } from './vk-parsing-post-import.repository';
import { VkParsingRateLimitService } from './vk-parsing-rate-limit.service';
import { VkParsingService } from './vk-parsing.service';
import { VkPublishService } from './vk-publish.service';
import { VkSourceService } from './vk-source.service';
import { VkSyncService } from './vk-sync.service';
import { SafetyDeskAdminGuard } from './safety-desk-admin.guard';
import { SafetyDeskController } from './safety-desk.controller';
import { SafetyDeskService } from './safety-desk.service';
import { SupportRequestsController } from './support-requests.controller';
import { SupportRequestsService } from './support-requests.service';
import { PublisherController } from './publisher.controller';
import { PublisherEntityRefreshService } from './publisher-entity-refresh.service';
import { PublisherPolicyService } from './publisher-policy.service';
import { PublisherSuggestionService } from './publisher-suggestion.service';
import { PublisherAutoReplyService } from './publisher-auto-reply.service';
import { PublisherReadinessService } from '../publisher/publisher-readiness.service';
import { PublisherSuggestionPublicationQueueService } from './publisher-suggestion-publication-queue.service';
import { PublisherSuggestionPublicationProcessor } from './publisher-suggestion-publication.processor';
import { PUBLISHER_SUGGESTION_PUBLICATION_QUEUE } from './publisher-suggestion-publication.queue';
import { PublisherPostImportProcessingService } from './publisher-post-import-processing.service';
import { PublisherPostImportDeliveryService } from './publisher-post-import-delivery.service';
import { PublisherPostImportProcessor } from './publisher-post-import.processor';
import { PublisherAutoReplyAuthoringProcessingService } from './publisher-auto-reply-authoring-processing.service';
import { PublisherAutoReplyAuthoringDeliveryService } from './publisher-auto-reply-authoring-delivery.service';
import { PublisherAutoReplyAuthoringProcessor } from './publisher-auto-reply-authoring.processor';

@Module({
  imports: [
    BullModule.registerQueue({ name: ADMIN_MANAGED_ENTITIES_REFRESH_QUEUE }),
    BullModule.registerQueue({ name: ADMIN_MANUAL_FANOUT_QUEUE }),
    BullModule.registerQueue({ name: ADMIN_SUPER_BAN_QUEUE }),
    BullModule.registerQueue({ name: ADMIN_SUGGESTION_DELIVERY_QUEUE }),
    BullModule.registerQueue({ name: VK_PARSING_SYNC_QUEUE }),
    BullModule.registerQueue({ name: VK_PARSING_PUBLISHER_QUEUE }),
    BullModule.registerQueue({ name: PUBLISHER_SUGGESTION_PUBLICATION_QUEUE }),
    AuthModule,
    MaxModule,
    ChatContextModule,
    SystemModule,
    NightModeTransitionModule,
    ModerationDeleteIntentModule,
    RedisCounterModule,
    PublisherModule,
  ],
  controllers: [
    AdminManagedEntitiesController,
    AdminSettingsController,
    AdminAutopostController,
    AdminBroadcastController,
    PublisherVkParsingController,
    AdminDialogController,
    AdminGiveawayController,
    AdminPollController,
    AdminManualModerationController,
    PublicationController,
    PublisherController,
    SafetyDeskController,
    SupportRequestsController,
  ],
  providers: [
    AdminService,
    {
      provide: MANAGED_ENTITIES_LEGACY_PORT,
      useExisting: AdminService,
    },
    {
      provide: CHANNEL_DIALOG_LEGACY_PORT,
      useExisting: AdminService,
    },
    AdminManualMessageCleanupService,
    AdminDialogLinkService,
    AdminSettingsService,
    ChannelDialogService,
    ChannelPostSignatureService,
    ChannelStatsCollectorService,
    ManualModerationService,
    GlobalSpammerIntelligenceService,
    ManagedAutopostService,
    ManagedAutopostRunnerService,
    {
      provide: ManagedBroadcastService,
      useFactory: (adminService: AdminService) => new ManagedBroadcastService(adminService),
      inject: [AdminService],
    },
    ManagedEntityCandidateSyncService,
    ManagedEntitiesService,
    ManagedEntitiesDiscoveryService,
    ManagedBroadcastRunnerService,
    ManagedGiveawayService,
    ManagedPollService,
    ManagedPollRunnerService,
    PublicationContentService,
    PublicationLegacyService,
    PublicationMetricsInterceptor,
    PublicationPresenterService,
    PublicationService,
    PublicationPublisherRoutingService,
    PublisherDialogContextService,
    PublicationRunnerService,
    ...(roleRunsPublisher(getAppRole()) ? [PublisherPublicationDispatchRunnerService] : []),
    PublisherPolicyService,
    PublisherSuggestionService,
    PublisherAutoReplyService,
    PublisherEntityRefreshService,
    PublisherReadinessService,
    PublisherSuggestionPublicationQueueService,
    ...(roleRunsPublisher(getAppRole()) ? [PublisherSuggestionPublicationProcessor] : []),
    ...(roleRunsPublisher(getAppRole())
      ? [
          PublisherPostImportProcessingService,
          PublisherPostImportDeliveryService,
          PublisherPostImportProcessor,
          PublisherAutoReplyAuthoringProcessingService,
          PublisherAutoReplyAuthoringDeliveryService,
          PublisherAutoReplyAuthoringProcessor,
        ]
      : []),
    ManagedGiveawayRunnerService,
    VkParsingRateLimitService,
    VkApiClientService,
    VkParsingAccessService,
    VkParsingFeedService,
    VkSourceService,
    VkSyncService,
    VkPublishService,
    VkParsingMediaCacheService,
    VkParsingOwnershipService,
    VkParsingPostImportRepository,
    VkParsingService,
    SafetyDeskAdminGuard,
    SafetyDeskService,
    SupportRequestsService,
    ...(roleRunsPublisher(getAppRole()) ? [VkParsingRunnerService] : []),
    ...(roleRunsPublisher(getAppRole()) ? [VkParsingSyncProcessor] : []),
    ...(roleRunsPublisher(getAppRole()) ? [VkParsingPublisherProcessor] : []),
    ...(roleRunsAction(getAppRole()) ? [AdminManagedEntitiesRefreshProcessor] : []),
    ...(roleRunsAction(getAppRole()) ? [AdminManualFanoutProcessor] : []),
    ...(roleRunsAction(getAppRole()) ? [AdminSuperBanProcessor] : []),
    ...(roleRunsAction(getAppRole()) ? [AdminSuggestionDeliveryProcessor] : []),
    ...(roleRunsAction(getAppRole()) ? [AdminSuggestionDeliveryRecoveryService] : []),
  ],
  exports: [
    AdminService,
    AdminDialogLinkService,
    AdminSettingsService,
    ChannelDialogService,
    ChannelPostSignatureService,
    ManualModerationService,
    ManagedAutopostService,
    {
      provide: ManagedBroadcastService,
      useFactory: (adminService: AdminService) => new ManagedBroadcastService(adminService),
      inject: [AdminService],
    },
    ManagedEntityCandidateSyncService,
    ManagedEntitiesService,
    ManagedEntitiesDiscoveryService,
    ManagedGiveawayService,
    ManagedPollService,
    PublicationService,
    PublisherPolicyService,
    PublisherAutoReplyService,
    PublisherReadinessService,
    VkParsingRateLimitService,
    VkApiClientService,
    VkParsingAccessService,
    VkParsingFeedService,
    VkSourceService,
    VkSyncService,
    VkPublishService,
    VkParsingMediaCacheService,
    VkParsingOwnershipService,
    VkParsingPostImportRepository,
    VkParsingService,
    SupportRequestsService,
  ],
})
export class AdminModule {}
