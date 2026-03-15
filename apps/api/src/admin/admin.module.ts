import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ChatContextModule } from '../chat-context/chat-context.module';
import { MaxModule } from '../max/max.module';
import { AdminController } from './admin.controller';
import { ManagedBroadcastRunnerService } from './managed-broadcast-runner.service';
import { ManagedGiveawayRunnerService } from './managed-giveaway-runner.service';
import { ManagedGiveawayService } from './managed-giveaway.service';
import { AdminService } from './admin.service';
import { ChannelStatsCollectorService } from './channel-stats-collector.service';
import { SurfaceOrchestratorService } from './surface-orchestrator.service';

@Module({
  imports: [AuthModule, MaxModule, ChatContextModule],
  controllers: [AdminController],
  providers: [
    AdminService,
    ChannelStatsCollectorService,
    SurfaceOrchestratorService,
    ManagedBroadcastRunnerService,
    ManagedGiveawayService,
    ManagedGiveawayRunnerService,
  ],
  exports: [AdminService, ManagedGiveawayService, SurfaceOrchestratorService],
})
export class AdminModule {}
