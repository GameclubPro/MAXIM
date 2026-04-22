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
import { AdminController } from './admin.controller';
import { DialogBrowserHandoffController } from './dialog-browser-handoff.controller';
import { ManagedBroadcastRunnerService } from './managed-broadcast-runner.service';
import { ManagedGiveawayRunnerService } from './managed-giveaway-runner.service';
import { ManagedGiveawayService } from './managed-giveaway.service';
import { AdminService } from './admin.service';
import { ChannelStatsCollectorService } from './channel-stats-collector.service';

@Module({
  imports: [
    BullModule.registerQueue({ name: ADMIN_MANAGED_ENTITIES_REFRESH_QUEUE }),
    BullModule.registerQueue({ name: ADMIN_MANUAL_FANOUT_QUEUE }),
    BullModule.registerQueue({ name: ADMIN_SUGGESTION_DELIVERY_QUEUE }),
    AuthModule,
    MaxModule,
    ChatContextModule,
    SystemModule,
  ],
  controllers: [AdminController, DialogBrowserHandoffController],
  providers: [
    AdminService,
    ChannelStatsCollectorService,
    RedisCounterService,
    ManagedBroadcastRunnerService,
    ManagedGiveawayService,
    ManagedGiveawayRunnerService,
    ...(roleRunsAction(getAppRole()) ? [AdminManagedEntitiesRefreshProcessor] : []),
    ...(roleRunsAction(getAppRole()) ? [AdminManualFanoutProcessor] : []),
    ...(roleRunsAction(getAppRole()) ? [AdminSuggestionDeliveryProcessor] : []),
  ],
  exports: [AdminService, ManagedGiveawayService],
})
export class AdminModule {}
