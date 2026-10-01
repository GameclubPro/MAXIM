import { Module } from '@nestjs/common';
import { MaxBotModule } from '../max/max-bot.module';
import { MAX_ACTION_ALL_QUEUE_NAMES } from '../max/max-action.queue';
import { GLOBAL_SPAMMER_DENORM_QUEUE } from '../moderation/global-spammer-denorm.queue';
import { RedisCounterModule } from '../moderation/redis-counter.module';
import { registerRuntimeQueues } from '../runtime/runtime-queues';
import { ALL_WEBHOOK_QUEUE_NAMES } from '../webhook/webhook-queues';
import { ActionHealthService } from './action-health.service';
import { ActionLatencyService } from './action-latency.service';
import { BackgroundRuntimeGovernorService } from './background-runtime-governor.service';
import { MaxApiMetricsService } from './max-api-metrics.service';
import { MaxActionLedgerWatchdogService } from './max-action-ledger-watchdog.service';
import { AUXILIARY_QUEUE_NAMES, QueueMetricsService } from './queue-metrics.service';
import { RuntimeDiagnosticsService } from './runtime-diagnostics.service';
import { SystemModeService } from './system-mode.service';
import { WebhookDynamicLeaseStatusService } from './webhook-dynamic-lease-status.service';
import { WebhookIngressMetricsService } from './webhook-ingress-metrics.service';
import { WebhookSloService } from './webhook-slo.service';
import { WebhookSubscriptionStatusService } from './webhook-subscription-status.service';

// FLAG: Governors, readiness and deletion fences retain the complete queue inventory and
// watchdog provider. HTTP/dashboard composition must not create second runtime providers.
@Module({
  imports: [
    MaxBotModule,
    RedisCounterModule,
    ...registerRuntimeQueues(...ALL_WEBHOOK_QUEUE_NAMES),
    ...registerRuntimeQueues(...MAX_ACTION_ALL_QUEUE_NAMES),
    ...registerRuntimeQueues(GLOBAL_SPAMMER_DENORM_QUEUE),
    ...registerRuntimeQueues(...AUXILIARY_QUEUE_NAMES),
  ],
  providers: [
    QueueMetricsService,
    ActionHealthService,
    ActionLatencyService,
    MaxApiMetricsService,
    MaxActionLedgerWatchdogService,
    RuntimeDiagnosticsService,
    BackgroundRuntimeGovernorService,
    SystemModeService,
    WebhookDynamicLeaseStatusService,
    WebhookIngressMetricsService,
    WebhookSloService,
    WebhookSubscriptionStatusService,
  ],
  exports: [
    QueueMetricsService,
    ActionHealthService,
    ActionLatencyService,
    MaxApiMetricsService,
    RuntimeDiagnosticsService,
    BackgroundRuntimeGovernorService,
    SystemModeService,
    WebhookDynamicLeaseStatusService,
    WebhookIngressMetricsService,
    WebhookSloService,
    WebhookSubscriptionStatusService,
  ],
})
export class SystemRuntimeModule {}
