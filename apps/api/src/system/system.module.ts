import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MiniappBootTraceController } from './miniapp-boot-trace.controller';
import { MiniappBootTraceService } from './miniapp-boot-trace.service';
import { MiniappMutationTunnelController } from './miniapp-mutation-tunnel.controller';
import { SystemBotsService } from './system-bots.service';
import { SystemController } from './system.controller';
import { SystemDashboardService } from './system-dashboard.service';
import { SystemRuntimeModule } from './system-runtime.module';

@Module({
  imports: [AuthModule, SystemRuntimeModule],
  controllers: [SystemController, MiniappBootTraceController, MiniappMutationTunnelController],
  providers: [MiniappBootTraceService, SystemBotsService, SystemDashboardService],
  exports: [SystemRuntimeModule, SystemBotsService, SystemDashboardService],
})
export class SystemModule {}
