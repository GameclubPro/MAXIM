import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { GLOBAL_SPAMMER_DENORM_QUEUE } from '../moderation/global-spammer-denorm.queue';
import { ALL_WEBHOOK_QUEUE_NAMES } from '../webhook/webhook-queues';
import { ActionHealthService } from './action-health.service';
import { BackgroundRuntimeGovernorService } from './background-runtime-governor.service';
import { MaxApiMetricsService } from './max-api-metrics.service';
import { MiniappBootTraceController } from './miniapp-boot-trace.controller';
import { MiniappBootTraceService } from './miniapp-boot-trace.service';
import { MiniappMutationTunnelController } from './miniapp-mutation-tunnel.controller';
import { QueueMetricsService } from './queue-metrics.service';
import { RuntimeDiagnosticsService } from './runtime-diagnostics.service';
import { SystemController } from './system.controller';
import { SystemDashboardService } from './system-dashboard.service';
import { SystemModeService } from './system-mode.service';
import { WebhookDynamicLeaseStatusService } from './webhook-dynamic-lease-status.service';
import { WebhookSloService } from './webhook-slo.service';
import { WebhookSubscriptionStatusService } from './webhook-subscription-status.service';

@Module({
  imports: [
    AuthModule,
    BullModule.registerQueue(...ALL_WEBHOOK_QUEUE_NAMES.map((name) => ({ name }))),
    BullModule.registerQueue({ name: 'moderation-actions' }),
    BullModule.registerQueue({ name: GLOBAL_SPAMMER_DENORM_QUEUE }),
  ],
  controllers: [SystemController, MiniappBootTraceController, MiniappMutationTunnelController],
  providers: [
    QueueMetricsService,
    ActionHealthService,
    MaxApiMetricsService,
    MiniappBootTraceService,
    RuntimeDiagnosticsService,
    BackgroundRuntimeGovernorService,
    SystemModeService,
    SystemDashboardService,
    WebhookDynamicLeaseStatusService,
    WebhookSloService,
    WebhookSubscriptionStatusService,
  ],
  exports: [
    QueueMetricsService,
    ActionHealthService,
    MaxApiMetricsService,
    RuntimeDiagnosticsService,
    BackgroundRuntimeGovernorService,
    SystemModeService,
    SystemDashboardService,
    WebhookDynamicLeaseStatusService,
    WebhookSloService,
    WebhookSubscriptionStatusService,
  ],
})
export class SystemModule {}
