import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ChatContextModule } from '../chat-context/chat-context.module';
import { MaxModule } from '../max/max.module';
import { getAppRole, roleRunsAction } from '../runtime/app-role';
import { SystemModule } from '../system/system.module';
import { AdminManualFanoutProcessor } from './admin-manual-fanout.processor';
import { ADMIN_MANUAL_FANOUT_QUEUE } from './admin-manual-fanout.queue';
import { AdminSuggestionDeliveryProcessor } from './admin-suggestion-delivery.processor';
import { ADMIN_SUGGESTION_DELIVERY_QUEUE } from './admin-suggestion-delivery.queue';
import { AdminController } from './admin.controller';
import { ManagedBroadcastRunnerService } from './managed-broadcast-runner.service';
import { ManagedGiveawayRunnerService } from './managed-giveaway-runner.service';
import { ManagedGiveawayService } from './managed-giveaway.service';
import { AdminService } from './admin.service';
import { ChannelStatsCollectorService } from './channel-stats-collector.service';
import { RedisCounterService } from '../moderation/redis-counter.service';

@Module({
  imports: [
    BullModule.registerQueue({ name: ADMIN_MANUAL_FANOUT_QUEUE }),
    BullModule.registerQueue({ name: ADMIN_SUGGESTION_DELIVERY_QUEUE }),
    AuthModule,
    MaxModule,
    ChatContextModule,
    SystemModule,
  ],
  controllers: [AdminController],
  providers: [
    AdminService,
    ChannelStatsCollectorService,
    RedisCounterService,
    ManagedBroadcastRunnerService,
    ManagedGiveawayService,
    ManagedGiveawayRunnerService,
    ...(roleRunsAction(getAppRole()) ? [AdminManualFanoutProcessor] : []),
    ...(roleRunsAction(getAppRole()) ? [AdminSuggestionDeliveryProcessor] : []),
  ],
  exports: [AdminService, ManagedGiveawayService],
})
export class AdminModule {}
