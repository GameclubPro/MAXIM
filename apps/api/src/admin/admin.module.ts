import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ChatContextModule } from '../chat-context/chat-context.module';
import { MaxModule } from '../max/max.module';
import { RedisCounterService } from '../moderation/redis-counter.service';
import { getAppRole, roleRunsAction } from '../runtime/app-role';
import { SystemModule } from '../system/system.module';
import { AdminManagedEntitiesRefreshProcessor } from './admin-managed-entities-refresh.processor';
import { ADMIN_MANAGED_ENTITIES_REFRESH_QUEUE } from './admin-managed-entities-refresh.queue';
import { AdminManualFanoutProcessor } from './admin-manual-fanout.processor';
import { ADMIN_MANUAL_FANOUT_QUEUE } from './admin-manual-fanout.queue';
import { AdminSuggestionDeliveryProcessor } from './admin-suggestion-delivery.processor';
import { ADMIN_SUGGESTION_DELIVERY_QUEUE } from './admin-suggestion-delivery.queue';
import { AdminSettingsService } from './admin-settings.service';
import { AdminController } from './admin.controller';
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
import { VkParsingRateLimitService } from './vk-parsing-rate-limit.service';
import { VkParsingService } from './vk-parsing.service';

@Module({
  imports: [
    BullModule.registerQueue({ name: ADMIN_MANAGED_ENTITIES_REFRESH_QUEUE }),
    BullModule.registerQueue({ name: ADMIN_MANUAL_FANOUT_QUEUE }),
    BullModule.registerQueue({ name: ADMIN_SUGGESTION_DELIVERY_QUEUE }),
    BullModule.registerQueue({ name: VK_PARSING_SYNC_QUEUE }),
    BullModule.registerQueue({ name: VK_PARSING_PUBLISH_QUEUE }),
    AuthModule,
    MaxModule,
    ChatContextModule,
    SystemModule,
  ],
  controllers: [AdminController],
  providers: [
    AdminService,
    AdminSettingsService,
    ChannelDialogService,
    ChannelStatsCollectorService,
    ManualModerationService,
    RedisCounterService,
    ManagedBroadcastService,
    ManagedEntitiesService,
    ManagedEntitiesDiscoveryService,
    ManagedBroadcastRunnerService,
    ManagedGiveawayService,
    ManagedGiveawayRunnerService,
    VkParsingRateLimitService,
    VkParsingService,
    ...(roleRunsAction(getAppRole()) ? [VkParsingRunnerService] : []),
    ...(roleRunsAction(getAppRole()) ? [VkParsingSyncProcessor] : []),
    ...(roleRunsAction(getAppRole()) ? [VkParsingPublishProcessor] : []),
    ...(roleRunsAction(getAppRole()) ? [AdminManagedEntitiesRefreshProcessor] : []),
    ...(roleRunsAction(getAppRole()) ? [AdminManualFanoutProcessor] : []),
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
    VkParsingService,
  ],
})
export class AdminModule {}
