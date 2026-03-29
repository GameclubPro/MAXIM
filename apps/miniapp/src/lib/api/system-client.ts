import type {
  SystemDashboardAlert,
  SystemDashboardResponse,
  SystemModeSnapshot,
} from '@maxim/contracts';
import type { ApiTransport } from './transport';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseActionHealthSnapshot(value: unknown) {
  if (
    !isRecord(value) ||
    typeof value.windowSec !== 'number' ||
    typeof value.total !== 'number' ||
    typeof value.success !== 'number' ||
    typeof value.failure !== 'number' ||
    typeof value.critical !== 'number' ||
    typeof value.errorRate !== 'number' ||
    typeof value.criticalRate !== 'number'
  ) {
    throw new Error('Invalid action health snapshot');
  }

  return {
    windowSec: value.windowSec,
    total: value.total,
    success: value.success,
    failure: value.failure,
    critical: value.critical,
    errorRate: value.errorRate,
    criticalRate: value.criticalRate,
  };
}

function parseSystemModeSnapshot(value: unknown): SystemModeSnapshot {
  if (!isRecord(value)) {
    throw new Error('Invalid system mode response');
  }

  if (
    (value.mode !== 'normal' && value.mode !== 'degrade') ||
    (value.source !== 'auto' && value.source !== 'manual') ||
    typeof value.reason !== 'string' ||
    typeof value.updatedAt !== 'string' ||
    (value.manualMode !== null &&
      value.manualMode !== undefined &&
      value.manualMode !== 'normal' &&
      value.manualMode !== 'degrade') ||
    typeof value.queueLagSec !== 'number' ||
    !isRecord(value.action)
  ) {
    throw new Error('Invalid system mode response');
  }

  return {
    mode: value.mode,
    source: value.source,
    reason: value.reason,
    updatedAt: value.updatedAt,
    manualMode: value.manualMode ?? null,
    queueLagSec: value.queueLagSec,
    action: parseActionHealthSnapshot(value.action),
  };
}

function parseSystemDashboardAlert(value: unknown): SystemDashboardAlert {
  if (
    !isRecord(value) ||
    typeof value.code !== 'string' ||
    (value.level !== 'info' && value.level !== 'warning' && value.level !== 'critical') ||
    typeof value.title !== 'string' ||
    typeof value.detail !== 'string' ||
    typeof value.recommendedAction !== 'string'
  ) {
    throw new Error('Invalid system dashboard alert');
  }

  return {
    code: value.code,
    level: value.level,
    title: value.title,
    detail: value.detail,
    recommendedAction: value.recommendedAction,
  };
}

function parseQueueCounters(value: unknown) {
  if (
    !isRecord(value) ||
    typeof value.waiting !== 'number' ||
    typeof value.active !== 'number' ||
    typeof value.delayed !== 'number' ||
    typeof value.failed !== 'number' ||
    typeof value.completed !== 'number'
  ) {
    throw new Error('Invalid queue counters');
  }

  return {
    waiting: value.waiting,
    active: value.active,
    delayed: value.delayed,
    failed: value.failed,
    completed: value.completed,
  };
}

function parseWebhookStatusMetrics(value: unknown) {
  if (
    !isRecord(value) ||
    typeof value.count !== 'number' ||
    (value.oldestEventId !== null &&
      value.oldestEventId !== undefined &&
      typeof value.oldestEventId !== 'string') ||
    (value.oldestCreatedAt !== null &&
      value.oldestCreatedAt !== undefined &&
      typeof value.oldestCreatedAt !== 'string') ||
    typeof value.oldestLagSec !== 'number'
  ) {
    throw new Error('Invalid webhook status metrics');
  }

  return {
    count: value.count,
    oldestEventId: value.oldestEventId ?? null,
    oldestCreatedAt: value.oldestCreatedAt ?? null,
    oldestLagSec: value.oldestLagSec,
  };
}

function parseSystemDashboardResponse(value: unknown): SystemDashboardResponse {
  if (
    !isRecord(value) ||
    !isRecord(value.summary) ||
    !Array.isArray(value.alerts) ||
    !isRecord(value.queues)
  ) {
    throw new Error('Invalid system dashboard response');
  }

  const { summary, queues } = value;
  if (
    (summary.status !== 'healthy' &&
      summary.status !== 'warning' &&
      summary.status !== 'critical') ||
    typeof summary.title !== 'string' ||
    typeof summary.detail !== 'string' ||
    typeof summary.generatedAt !== 'string' ||
    typeof summary.stabilizing !== 'boolean'
  ) {
    throw new Error('Invalid system dashboard response');
  }

  if (
    !isRecord(queues.webhookEvents) ||
    typeof queues.oldestQueuedLagSec !== 'number' ||
    typeof queues.oldestReceivedLagSec !== 'number' ||
    typeof queues.effectiveLagSec !== 'number' ||
    typeof queues.generatedAt !== 'string'
  ) {
    throw new Error('Invalid system dashboard response');
  }

  return {
    summary: {
      status: summary.status,
      title: summary.title,
      detail: summary.detail,
      generatedAt: summary.generatedAt,
      stabilizing: summary.stabilizing,
    },
    alerts: value.alerts.map((alert) => parseSystemDashboardAlert(alert)),
    queues: {
      moderation: parseQueueCounters(queues.moderation),
      webhookCritical: parseQueueCounters(queues.webhookCritical),
      webhookDefault: parseQueueCounters(queues.webhookDefault),
      webhookBackground: parseQueueCounters(queues.webhookBackground),
      webhookLegacy: parseQueueCounters(queues.webhookLegacy),
      actions: parseQueueCounters(queues.actions),
      webhookEvents: {
        received: parseWebhookStatusMetrics(queues.webhookEvents.received),
        queued: parseWebhookStatusMetrics(queues.webhookEvents.queued),
        failed: parseWebhookStatusMetrics(queues.webhookEvents.failed),
      },
      actionHealth: parseActionHealthSnapshot(queues.actionHealth),
      oldestQueuedEventId:
        typeof queues.oldestQueuedEventId === 'string' ? queues.oldestQueuedEventId : null,
      oldestQueuedCreatedAt:
        typeof queues.oldestQueuedCreatedAt === 'string' ? queues.oldestQueuedCreatedAt : null,
      oldestQueuedLagSec: queues.oldestQueuedLagSec,
      oldestReceivedEventId:
        typeof queues.oldestReceivedEventId === 'string' ? queues.oldestReceivedEventId : null,
      oldestReceivedCreatedAt:
        typeof queues.oldestReceivedCreatedAt === 'string' ? queues.oldestReceivedCreatedAt : null,
      oldestReceivedLagSec: queues.oldestReceivedLagSec,
      effectiveLagSec: queues.effectiveLagSec,
      generatedAt: queues.generatedAt,
    },
    mode: parseSystemModeSnapshot(value.mode),
  };
}

export async function getSystemDashboard(api: ApiTransport): Promise<SystemDashboardResponse> {
  const response = await api.request('/system/dashboard');
  return parseSystemDashboardResponse(response);
}

export async function setSystemMode(
  api: ApiTransport,
  mode: 'auto' | 'normal' | 'degrade',
): Promise<SystemModeSnapshot> {
  const response = await api.request('/system/mode', {
    method: 'POST',
    body: JSON.stringify({ mode }),
  });
  return parseSystemModeSnapshot(response);
}
