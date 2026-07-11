import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MaxBotModule } from '../max/max-bot.module';
import { MAX_ACTION_ALL_QUEUE_NAMES } from '../max/max-action.queue';
import { GLOBAL_SPAMMER_DENORM_QUEUE } from '../moderation/global-spammer-denorm.queue';
import { RedisCounterModule } from '../moderation/redis-counter.module';
import { ALL_WEBHOOK_QUEUE_NAMES } from '../webhook/webhook-queues';
import { ActionHealthService } from './action-health.service';
import { BackgroundRuntimeGovernorService } from './background-runtime-governor.service';
import { MaxApiMetricsService } from './max-api-metrics.service';
import { MaxActionLedgerWatchdogService } from './max-action-ledger-watchdog.service';
import { MiniappBootTraceController } from './miniapp-boot-trace.controller';
import { MiniappBootTraceService } from './miniapp-boot-trace.service';
import { MiniappMutationTunnelController } from './miniapp-mutation-tunnel.controller';
import { AUXILIARY_QUEUE_NAMES, QueueMetricsService } from './queue-metrics.service';
import { RuntimeDiagnosticsService } from './runtime-diagnostics.service';
import { SystemBotsService } from './system-bots.service';
import { SystemController } from './system.controller';
import { SystemDashboardService } from './system-dashboard.service';
import { SystemModeService } from './system-mode.service';
import { WebhookDynamicLeaseStatusService } from './webhook-dynamic-lease-status.service';
import { WebhookIngressMetricsService } from './webhook-ingress-metrics.service';
import { WebhookSloService } from './webhook-slo.service';
import { WebhookSubscriptionStatusService } from './webhook-subscription-status.service';

@Module({
  imports: [
    AuthModule,
    MaxBotModule,
    RedisCounterModule,
    BullModule.registerQueue(...ALL_WEBHOOK_QUEUE_NAMES.map((name) => ({ name }))),
    BullModule.registerQueue(...MAX_ACTION_ALL_QUEUE_NAMES.map((name) => ({ name }))),
    BullModule.registerQueue({ name: GLOBAL_SPAMMER_DENORM_QUEUE }),
    BullModule.registerQueue(...AUXILIARY_QUEUE_NAMES.map((name) => ({ name }))),
  ],
  controllers: [SystemController, MiniappBootTraceController, MiniappMutationTunnelController],
  providers: [
    QueueMetricsService,
    ActionHealthService,
    MaxApiMetricsService,
    MaxActionLedgerWatchdogService,
    MiniappBootTraceService,
    RuntimeDiagnosticsService,
    BackgroundRuntimeGovernorService,
    SystemBotsService,
    SystemModeService,
    SystemDashboardService,
    WebhookDynamicLeaseStatusService,
    WebhookIngressMetricsService,
    WebhookSloService,
    WebhookSubscriptionStatusService,
  ],
  exports: [
    QueueMetricsService,
    ActionHealthService,
    MaxApiMetricsService,
    RuntimeDiagnosticsService,
    BackgroundRuntimeGovernorService,
    SystemBotsService,
    SystemModeService,
    SystemDashboardService,
    WebhookDynamicLeaseStatusService,
    WebhookIngressMetricsService,
    WebhookSloService,
    WebhookSubscriptionStatusService,
  ],
})
export class SystemModule {}
