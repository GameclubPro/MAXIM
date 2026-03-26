import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ChatContextModule } from '../chat-context/chat-context.module';
import { MaxModule } from '../max/max.module';
import { SystemModule } from '../system/system.module';
import { AdminController } from './admin.controller';
import { ManagedBroadcastRunnerService } from './managed-broadcast-runner.service';
import { ManagedGiveawayRunnerService } from './managed-giveaway-runner.service';
import { ManagedGiveawayService } from './managed-giveaway.service';
import { AdminService } from './admin.service';
import { ChannelStatsCollectorService } from './channel-stats-collector.service';
import { RedisCounterService } from '../moderation/redis-counter.service';

@Module({
  imports: [AuthModule, MaxModule, ChatContextModule, SystemModule],
  controllers: [AdminController],
  providers: [
    AdminService,
    ChannelStatsCollectorService,
    RedisCounterService,
    ManagedBroadcastRunnerService,
    ManagedGiveawayService,
    ManagedGiveawayRunnerService,
  ],
  exports: [AdminService, ManagedGiveawayService],
})
export class AdminModule {}
