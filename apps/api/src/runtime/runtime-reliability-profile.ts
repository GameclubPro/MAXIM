import type {
  SystemCanaryRecommendation,
  SystemCanaryState,
  SystemDashboardWebhookSlo,
  SystemDynamicLeasesMode,
  SystemQueueGroup,
  SystemQueueGroupHealth,
  SystemQueueGroupStatus,
  SystemRollbackReadiness,
  SystemRuntimeProfile,
} from '@maxim/contracts/system';
import { type AppRole, getAppRole } from './app-role';
import {
  getEnabledModerationProcessorQueues,
  getWebhookDynamicLeasesMode,
  getWebhookDynamicLeasesWorkerGroup,
} from './moderation-runtime';
import type { QueueCounters, QueueMetricsSnapshot } from '../system/queue-metrics.service';

export const DEFAULT_WEBHOOK_P95_TARGET_MS = 1_000;
const QUEUE_GROUP_WAITING_WARNING = 1;
const QUEUE_GROUP_WAITING_CRITICAL = 50;

export type RuntimeRoleProfile = Pick<
  SystemRuntimeProfile,
  | 'httpEnabled'
  | 'ingressEnabled'
  | 'adminEnabled'
  | 'enqueueEnabled'
  | 'moderationEnabled'
  | 'actionEnabled'
>;

export const RUNTIME_ROLE_PROFILES = Object.freeze({
  all: {
    httpEnabled: true,
    ingressEnabled: true,
    adminEnabled: true,
    enqueueEnabled: true,
    moderationEnabled: true,
    actionEnabled: true,
  },
  ingress: {
    httpEnabled: true,
    ingressEnabled: true,
    adminEnabled: false,
    enqueueEnabled: false,
    moderationEnabled: false,
    actionEnabled: false,
  },
  admin: {
    httpEnabled: true,
    ingressEnabled: false,
    adminEnabled: true,
    enqueueEnabled: false,
    moderationEnabled: false,
    actionEnabled: false,
  },
  enqueue: {
    httpEnabled: false,
    ingressEnabled: false,
    adminEnabled: false,
    enqueueEnabled: true,
    moderationEnabled: false,
    actionEnabled: false,
  },
  moderation: {
    httpEnabled: false,
    ingressEnabled: false,
    adminEnabled: false,
    enqueueEnabled: false,
    moderationEnabled: true,
    actionEnabled: false,
  },
  action: {
    httpEnabled: false,
    ingressEnabled: false,
    adminEnabled: false,
    enqueueEnabled: false,
    moderationEnabled: false,
    actionEnabled: true,
  },
} as const satisfies Record<AppRole, RuntimeRoleProfile>);

type RuntimeReliabilityInput = {
  queues: QueueMetricsSnapshot;
  dashboardStatus: 'healthy' | 'warning' | 'critical';
  queueLagSec: number;
  queueLagCriticalThresholdSec: number;
  activeFailedWebhooks: number;
  webhookSlo?: SystemDashboardWebhookSlo | null;
};

export function buildSystemRuntimeProfile(
  targetWebhookP95Ms = DEFAULT_WEBHOOK_P95_TARGET_MS,
): SystemRuntimeProfile {
  const appRole = getAppRole();
  const roleProfile = RUNTIME_ROLE_PROFILES[appRole];
  const workerGroup = getWebhookDynamicLeasesWorkerGroup();

  return {
    appRole,
    ...roleProfile,
    enabledQueues: Array.from(getEnabledModerationProcessorQueues()).sort(),
    dynamicLeasesMode: getWebhookDynamicLeasesMode(),
    dynamicLeasesWorkerGroup: workerGroup,
    canaryShardIds: readCsvEnv('WEBHOOK_DYNAMIC_LEASES_CANARY_SHARDS'),
    targetWebhookP95Ms,
    generatedAt: new Date().toISOString(),
  };
}

export function buildSystemQueueGroupHealth(queues: QueueMetricsSnapshot): SystemQueueGroupHealth {
  const groups: SystemQueueGroup[] = [
    buildQueueGroup('webhook-critical', ['moderation-critical'], queues.webhookCritical),
    buildQueueGroup(
      'webhook-join',
      Object.keys(queues.webhookJoinShards ?? {}),
      queues.webhookJoin,
    ),
    ...Object.entries(queues.webhookDefaultWorkerGroups ?? {}).map(([groupName, group]) =>
      buildQueueGroup(groupName, group.queues, group.counters),
    ),
    buildQueueGroup('webhook-background', ['moderation-background'], queues.webhookBackground),
    buildQueueGroup('webhook-legacy', ['moderation-legacy'], queues.webhookLegacy),
    buildQueueGroup('actions', ['moderation-actions'], queues.actions),
  ];

  return {
    status: resolveWorstQueueGroupStatus(groups),
    groups,
    generatedAt: new Date().toISOString(),
  };
}

export function buildSystemCanaryState(input: RuntimeReliabilityInput): SystemCanaryState {
  const profile = buildSystemRuntimeProfile(input.webhookSlo?.targetProcessingMs);
  const mode = profile.dynamicLeasesMode;
  const dynamicLeaseQueues = Object.entries(input.queues.webhookDynamicLeases?.queues ?? {});
  const handoffPendingQueues = dynamicLeaseQueues
    .filter(([, queue]) => queue.handoffPending)
    .map(([queueName]) => queueName)
    .sort();
  const unhealthyQueues = dynamicLeaseQueues
    .filter(
      ([, queue]) => queue.pressure >= QUEUE_GROUP_WAITING_CRITICAL || queue.reason === 'stale',
    )
    .map(([queueName]) => queueName)
    .sort();

  if (mode === 'off') {
    return {
      enabled: false,
      mode,
      status: 'disabled',
      recommendation: 'observe',
      workerGroup: profile.dynamicLeasesWorkerGroup,
      canaryShardIds: profile.canaryShardIds,
      liveWorkerGroups: input.queues.webhookDynamicLeases?.liveWorkerGroups ?? [],
      handoffPendingQueues,
      unhealthyQueues,
      reason: 'Dynamic leases are disabled for this runtime.',
    };
  }

  const status = resolveCanaryStatus({
    mode,
    dashboardStatus: input.dashboardStatus,
    webhookSlo: input.webhookSlo ?? null,
    unhealthyQueues,
  });
  const recommendation = resolveCanaryRecommendation(status, mode, handoffPendingQueues);

  return {
    enabled: true,
    mode,
    status,
    recommendation,
    workerGroup: profile.dynamicLeasesWorkerGroup,
    canaryShardIds: profile.canaryShardIds,
    liveWorkerGroups: input.queues.webhookDynamicLeases?.liveWorkerGroups ?? [],
    handoffPendingQueues,
    unhealthyQueues,
    reason: buildCanaryReason(status, recommendation, mode),
  };
}

export function buildSystemRollbackReadiness(
  input: RuntimeReliabilityInput,
): SystemRollbackReadiness {
  const webhookSloOk = !input.webhookSlo || input.webhookSlo.status === 'healthy';
  const queueLagOk = input.queueLagSec <= input.queueLagCriticalThresholdSec;
  const failedWebhookOk = input.activeFailedWebhooks === 0;
  const readyOk = input.dashboardStatus !== 'critical' && webhookSloOk && queueLagOk;
  const reasons = [
    ...(webhookSloOk ? [] : ['Webhook SLO is outside the target window.']),
    ...(queueLagOk
      ? []
      : [`Queue lag ${input.queueLagSec.toFixed(1)}s is above the critical threshold.`]),
    ...(failedWebhookOk ? [] : [`${input.activeFailedWebhooks} active failed webhook events.`]),
    ...(input.dashboardStatus === 'critical' ? ['System dashboard status is critical.'] : []),
  ];
  const status =
    input.dashboardStatus === 'critical' || !webhookSloOk
      ? 'rollback-recommended'
      : readyOk
        ? 'ready'
        : 'blocked';

  return {
    status,
    canRollbackRuntime: true,
    liveOk: true,
    readyOk,
    webhookSloOk,
    queueLagOk,
    failedWebhookOk,
    reasons,
    command:
      './infra/scripts/vps-connect.sh rollback-runtime <git-ref> api-enqueue api-moderation api-moderation-critical api-moderation-join api-moderation-realtime-b api-moderation-realtime-c api-moderation-realtime-d api-moderation-background api-action api-ingress api-admin',
  };
}

function buildQueueGroup(
  name: string,
  queues: readonly string[],
  counters: QueueCounters | undefined,
): SystemQueueGroup {
  const safeCounters = counters ?? {
    waiting: 0,
    active: 0,
    delayed: 0,
    failed: 0,
    completed: 0,
    prioritized: 0,
  };
  const pressure = safeCounters.waiting + safeCounters.active + safeCounters.delayed;

  return {
    name,
    queues: [...queues],
    waiting: safeCounters.waiting,
    active: safeCounters.active,
    delayed: safeCounters.delayed,
    failed: safeCounters.failed,
    completed: safeCounters.completed,
    pressure,
    status: resolveQueueGroupStatus(safeCounters),
  };
}

function resolveQueueGroupStatus(counters: QueueCounters): SystemQueueGroupStatus {
  if (counters.failed > 0 || counters.waiting >= QUEUE_GROUP_WAITING_CRITICAL) {
    return 'critical';
  }

  if (counters.waiting >= QUEUE_GROUP_WAITING_WARNING || counters.delayed > 0) {
    return 'warning';
  }

  return 'healthy';
}

function resolveWorstQueueGroupStatus(groups: readonly SystemQueueGroup[]): SystemQueueGroupStatus {
  if (groups.some((group) => group.status === 'critical')) {
    return 'critical';
  }

  if (groups.some((group) => group.status === 'warning')) {
    return 'warning';
  }

  return 'healthy';
}

function resolveCanaryStatus(input: {
  mode: SystemDynamicLeasesMode;
  dashboardStatus: 'healthy' | 'warning' | 'critical';
  webhookSlo: SystemDashboardWebhookSlo | null;
  unhealthyQueues: readonly string[];
}): SystemCanaryState['status'] {
  if (
    input.dashboardStatus === 'critical' ||
    input.webhookSlo?.status === 'critical' ||
    input.unhealthyQueues.length > 0
  ) {
    return 'degraded';
  }

  if (input.mode === 'shadow') {
    return 'shadow';
  }

  if (input.mode === 'on') {
    return 'active';
  }

  return 'canary';
}

function resolveCanaryRecommendation(
  status: SystemCanaryState['status'],
  mode: SystemDynamicLeasesMode,
  handoffPendingQueues: readonly string[],
): SystemCanaryRecommendation {
  if (status === 'degraded') {
    return 'rollback';
  }

  if (handoffPendingQueues.length > 0) {
    return 'hold';
  }

  if (status === 'canary' && mode === 'canary') {
    return 'expand';
  }

  return 'observe';
}

function buildCanaryReason(
  status: SystemCanaryState['status'],
  recommendation: SystemCanaryRecommendation,
  mode: SystemDynamicLeasesMode,
): string {
  if (recommendation === 'rollback') {
    return 'Canary/runtime health is degraded; rollback is safer than expanding worker coverage.';
  }

  if (recommendation === 'hold') {
    return 'Dynamic lease handoff is still settling; keep the current canary window.';
  }

  if (recommendation === 'expand') {
    return 'Current canary window is healthy and can be expanded to the next worker group.';
  }

  if (status === 'shadow') {
    return 'Dynamic leases are observing worker ownership without moving queues.';
  }

  return `Dynamic leases mode is ${mode}; keep observing SLO and queue group health.`;
}

function readCsvEnv(key: string): string[] {
  const rawValue = process.env[key];
  if (typeof rawValue !== 'string') {
    return [];
  }

  return rawValue
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .sort();
}
