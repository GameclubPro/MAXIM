import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ChatContextModule } from '../chat-context/chat-context.module';
import { MaxModule } from '../max/max.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { ChannelStatsCollectorService } from './channel-stats-collector.service';

@Module({
  imports: [AuthModule, MaxModule, ChatContextModule],
  controllers: [AdminController],
  providers: [AdminService, ChannelStatsCollectorService],
  exports: [AdminService],
})
export class AdminModule {}
