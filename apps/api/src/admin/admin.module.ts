import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ChatContextModule } from '../chat-context/chat-context.module';
import { MaxModule } from '../max/max.module';
import { RedisCounterService } from '../moderation/redis-counter.service';
import { GlobalSpammerIntelligenceService } from '../moderation/global-spammer-intelligence.service';
import { NightModeTransitionModule } from '../moderation/night-mode-transition.module';
import { getAppRole, roleRunsAction } from '../runtime/app-role';
import { SystemModule } from '../system/system.module';
import { AdminManagedEntitiesRefreshProcessor } from './admin-managed-entities-refresh.processor';
import { ADMIN_MANAGED_ENTITIES_REFRESH_QUEUE } from './admin-managed-entities-refresh.queue';
import { AdminManualFanoutProcessor } from './admin-manual-fanout.processor';
import { ADMIN_MANUAL_FANOUT_QUEUE } from './admin-manual-fanout.queue';
import { AdminSuggestionDeliveryProcessor } from './admin-suggestion-delivery.processor';
import { ADMIN_SUGGESTION_DELIVERY_QUEUE } from './admin-suggestion-delivery.queue';
import { AdminSuperBanProcessor } from './admin-super-ban.processor';
import { ADMIN_SUPER_BAN_QUEUE } from './admin-super-ban.queue';
import { AdminBroadcastController } from './admin-broadcast.controller';
import { AdminDialogController } from './admin-dialog.controller';
import { AdminGiveawayController } from './admin-giveaway.controller';
import { AdminManualModerationController } from './admin-manual-moderation.controller';
import { AdminSettingsService } from './admin-settings.service';
import { AdminManagedEntitiesController } from './admin-managed-entities.controller';
import { AdminSettingsController } from './admin-settings.controller';
import { AdminVkParsingController } from './admin-vk-parsing.controller';
import { ChannelDialogService } from './channel-dialog.service';
import { ManualModerationService } from './manual-moderation.service';
import { ManagedBroadcastRunnerService } from './managed-broadcast-runner.service';
import { ManagedBroadcastService } from './managed-broadcast.service';
import { ManagedEntitiesDiscoveryService } from './managed-entities-discovery.service';
import { ManagedEntitiesService } from './managed-entities.service';
import { ManagedGiveawayRunnerService } from './managed-giveaway-runner.service';
import { ManagedGiveawayService } from './managed-giveaway.service';
import { AdminService } from './admin.service';
import { ChannelStatsCollectorService } from './channel-stats-collector.service';
import { VkParsingPublishProcessor } from './vk-parsing-publish.processor';
import { VkParsingRunnerService } from './vk-parsing-runner.service';
import { VkParsingSyncProcessor } from './vk-parsing-sync.processor';
import { VK_PARSING_PUBLISH_QUEUE, VK_PARSING_SYNC_QUEUE } from './vk-parsing.queue';
import { VkApiClientService } from './vk-api-client.service';
import { VkParsingAccessService } from './vk-parsing-access.service';
import { VkParsingFeedService } from './vk-parsing-feed.service';
import { VkParsingMediaCacheService } from './vk-parsing-media-cache.service';
import { VkParsingPostImportRepository } from './vk-parsing-post-import.repository';
import { VkParsingRateLimitService } from './vk-parsing-rate-limit.service';
import { VkParsingService } from './vk-parsing.service';
import { VkPublishService } from './vk-publish.service';
import { VkSourceService } from './vk-source.service';
import { VkSyncService } from './vk-sync.service';

@Module({
  imports: [
    BullModule.registerQueue({ name: ADMIN_MANAGED_ENTITIES_REFRESH_QUEUE }),
    BullModule.registerQueue({ name: ADMIN_MANUAL_FANOUT_QUEUE }),
    BullModule.registerQueue({ name: ADMIN_SUPER_BAN_QUEUE }),
    BullModule.registerQueue({ name: ADMIN_SUGGESTION_DELIVERY_QUEUE }),
    BullModule.registerQueue({ name: VK_PARSING_SYNC_QUEUE }),
    BullModule.registerQueue({ name: VK_PARSING_PUBLISH_QUEUE }),
    AuthModule,
    MaxModule,
    ChatContextModule,
    SystemModule,
    NightModeTransitionModule,
  ],
  controllers: [
    AdminManagedEntitiesController,
    AdminSettingsController,
    AdminBroadcastController,
    AdminVkParsingController,
    AdminDialogController,
    AdminGiveawayController,
    AdminManualModerationController,
  ],
  providers: [
    AdminService,
    AdminSettingsService,
    ChannelDialogService,
    ChannelStatsCollectorService,
    ManualModerationService,
    RedisCounterService,
    GlobalSpammerIntelligenceService,
    ManagedBroadcastService,
    ManagedEntitiesService,
    ManagedEntitiesDiscoveryService,
    ManagedBroadcastRunnerService,
    ManagedGiveawayService,
    ManagedGiveawayRunnerService,
    VkParsingRateLimitService,
    VkApiClientService,
    VkParsingAccessService,
    VkParsingFeedService,
    VkSourceService,
    VkSyncService,
    VkPublishService,
    VkParsingMediaCacheService,
    VkParsingPostImportRepository,
    VkParsingService,
    ...(roleRunsAction(getAppRole()) ? [VkParsingRunnerService] : []),
    ...(roleRunsAction(getAppRole()) ? [VkParsingSyncProcessor] : []),
    ...(roleRunsAction(getAppRole()) ? [VkParsingPublishProcessor] : []),
    ...(roleRunsAction(getAppRole()) ? [AdminManagedEntitiesRefreshProcessor] : []),
    ...(roleRunsAction(getAppRole()) ? [AdminManualFanoutProcessor] : []),
    ...(roleRunsAction(getAppRole()) ? [AdminSuperBanProcessor] : []),
    ...(roleRunsAction(getAppRole()) ? [AdminSuggestionDeliveryProcessor] : []),
  ],
  exports: [
    AdminService,
    AdminSettingsService,
    ChannelDialogService,
    ManualModerationService,
    ManagedBroadcastService,
    ManagedEntitiesService,
    ManagedEntitiesDiscoveryService,
    ManagedGiveawayService,
    VkParsingRateLimitService,
    VkApiClientService,
    VkParsingAccessService,
    VkParsingFeedService,
    VkSourceService,
    VkSyncService,
    VkPublishService,
    VkParsingMediaCacheService,
    VkParsingPostImportRepository,
    VkParsingService,
  ],
})
export class AdminModule {}
