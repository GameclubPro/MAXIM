import type {
  BotOwnershipFoundationSnapshot,
  BotWebhookSubscriptionSnapshot,
  SystemDashboardAlert,
  SystemDashboardResponse,
  SystemModeSnapshot,
  WebhookSubscriptionSnapshot,
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

function parseSystemDashboardBurst(value: unknown) {
  if (
    !isRecord(value) ||
    typeof value.active !== 'boolean' ||
    typeof value.peakLagSec !== 'number' ||
    (value.peakBotId !== null &&
      value.peakBotId !== undefined &&
      typeof value.peakBotId !== 'string') ||
    (value.startedAt !== null &&
      value.startedAt !== undefined &&
      typeof value.startedAt !== 'string') ||
    (value.lastRecoveredAt !== null &&
      value.lastRecoveredAt !== undefined &&
      typeof value.lastRecoveredAt !== 'string') ||
    typeof value.sampleAgeMs !== 'number'
  ) {
    throw new Error('Invalid system dashboard burst');
  }

  return {
    active: value.active,
    peakLagSec: value.peakLagSec,
    peakBotId: typeof value.peakBotId === 'string' ? value.peakBotId : null,
    startedAt: typeof value.startedAt === 'string' ? value.startedAt : null,
    lastRecoveredAt: typeof value.lastRecoveredAt === 'string' ? value.lastRecoveredAt : null,
    sampleAgeMs: value.sampleAgeMs,
  };
}

function parseSystemDashboardHotPath(value: unknown) {
  if (
    !isRecord(value) ||
    typeof value.windowSec !== 'number' ||
    typeof value.failOpenCount !== 'number' ||
    !Array.isArray(value.stages)
  ) {
    throw new Error('Invalid system dashboard hot path');
  }

  return {
    windowSec: value.windowSec,
    failOpenCount: value.failOpenCount,
    stages: value.stages.map((stage) => {
      if (
        !isRecord(stage) ||
        typeof stage.stage !== 'string' ||
        typeof stage.count !== 'number' ||
        typeof stage.slowCount !== 'number' ||
        typeof stage.timeoutCount !== 'number' ||
        typeof stage.skipCount !== 'number' ||
        typeof stage.failOpenCount !== 'number' ||
        typeof stage.avgElapsedMs !== 'number' ||
        typeof stage.maxElapsedMs !== 'number' ||
        (stage.lastObservedAt !== null &&
          stage.lastObservedAt !== undefined &&
          typeof stage.lastObservedAt !== 'string')
      ) {
        throw new Error('Invalid system dashboard hot path stage');
      }

      return {
        stage: stage.stage,
        count: stage.count,
        slowCount: stage.slowCount,
        timeoutCount: stage.timeoutCount,
        skipCount: stage.skipCount,
        failOpenCount: stage.failOpenCount,
        avgElapsedMs: stage.avgElapsedMs,
        maxElapsedMs: stage.maxElapsedMs,
        lastObservedAt: typeof stage.lastObservedAt === 'string' ? stage.lastObservedAt : null,
      };
    }),
  };
}

function parseSystemDashboardHotChats(value: unknown) {
  if (!isRecord(value) || typeof value.windowSec !== 'number' || !Array.isArray(value.items)) {
    throw new Error('Invalid system dashboard hot chats');
  }

  return {
    windowSec: value.windowSec,
    items: value.items.map((item) => {
      if (
        !isRecord(item) ||
        typeof item.chatId !== 'string' ||
        typeof item.messageCreatedCount !== 'number' ||
        typeof item.botsSeen !== 'number' ||
        typeof item.lastSeenAt !== 'string'
      ) {
        throw new Error('Invalid system dashboard hot chat');
      }

      return {
        chatId: item.chatId,
        messageCreatedCount: item.messageCreatedCount,
        botsSeen: item.botsSeen,
        lastSeenAt: item.lastSeenAt,
      };
    }),
  };
}

function parseSystemDashboardBackgroundBudget(value: unknown) {
  if (
    !isRecord(value) ||
    typeof value.windowSec !== 'number' ||
    typeof value.backgroundShare !== 'number' ||
    !Array.isArray(value.topSources) ||
    !Array.isArray(value.pauseReasons)
  ) {
    throw new Error('Invalid system dashboard background budget');
  }

  return {
    windowSec: value.windowSec,
    backgroundShare: value.backgroundShare,
    topSources: value.topSources.map((item) => {
      if (
        !isRecord(item) ||
        typeof item.sourceTag !== 'string' ||
        typeof item.totalRequests !== 'number' ||
        typeof item.avgRps !== 'number' ||
        typeof item.peakRps !== 'number'
      ) {
        throw new Error('Invalid system dashboard background budget source');
      }

      return {
        sourceTag: item.sourceTag,
        totalRequests: item.totalRequests,
        avgRps: item.avgRps,
        peakRps: item.peakRps,
      };
    }),
    pauseReasons: value.pauseReasons.map((item) => {
      if (
        !isRecord(item) ||
        typeof item.component !== 'string' ||
        typeof item.sourceTag !== 'string' ||
        (item.action !== 'run' && item.action !== 'slow' && item.action !== 'pause') ||
        typeof item.reason !== 'string' ||
        typeof item.count !== 'number' ||
        (item.lastObservedAt !== null &&
          item.lastObservedAt !== undefined &&
          typeof item.lastObservedAt !== 'string')
      ) {
        throw new Error('Invalid system dashboard background pause reason');
      }

      return {
        component: item.component,
        sourceTag: item.sourceTag,
        action: item.action as 'run' | 'slow' | 'pause',
        reason: item.reason,
        count: item.count,
        lastObservedAt: typeof item.lastObservedAt === 'string' ? item.lastObservedAt : null,
      };
    }),
  };
}

function parseSystemDashboardMembershipLookup(value: unknown) {
  if (
    !isRecord(value) ||
    typeof value.windowSec !== 'number' ||
    typeof value.hotChannels !== 'number' ||
    typeof value.backoffActiveChats !== 'number' ||
    typeof value.transientIssues !== 'number' ||
    typeof value.terminalIssues !== 'number' ||
    !Array.isArray(value.hotChannelsSample) ||
    !Array.isArray(value.backoffSample) ||
    !Array.isArray(value.issueSample)
  ) {
    throw new Error('Invalid system dashboard membership lookup');
  }

  const parseSample = (item: unknown) => {
    if (
      !isRecord(item) ||
      typeof item.chatId !== 'string' ||
      typeof item.policyName !== 'string' ||
      typeof item.lastObservedAt !== 'string' ||
      (item.retryAfterMs !== null &&
        item.retryAfterMs !== undefined &&
        typeof item.retryAfterMs !== 'number')
    ) {
      throw new Error('Invalid system dashboard membership sample');
    }

    return {
      chatId: item.chatId,
      policyName: item.policyName,
      lastObservedAt: item.lastObservedAt,
      retryAfterMs: typeof item.retryAfterMs === 'number' ? item.retryAfterMs : null,
    };
  };

  return {
    windowSec: value.windowSec,
    hotChannels: value.hotChannels,
    backoffActiveChats: value.backoffActiveChats,
    transientIssues: value.transientIssues,
    terminalIssues: value.terminalIssues,
    hotChannelsSample: value.hotChannelsSample.map((item) => parseSample(item)),
    backoffSample: value.backoffSample.map((item) => parseSample(item)),
    issueSample: value.issueSample.map((item) => {
      const parsed = parseSample(item);
      const kind = isRecord(item) ? item.kind : null;
      if (kind !== 'transient' && kind !== 'terminal') {
        throw new Error('Invalid system dashboard membership issue sample');
      }
      return {
        ...parsed,
        kind: kind as 'transient' | 'terminal',
      };
    }),
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

function parseBotOwnershipCoverage(value: unknown) {
  if (
    !isRecord(value) ||
    typeof value.total !== 'number' ||
    typeof value.withPrimary !== 'number' ||
    typeof value.withoutPrimary !== 'number' ||
    typeof value.coverageRatio !== 'number'
  ) {
    throw new Error('Invalid bot ownership coverage');
  }

  return {
    total: value.total,
    withPrimary: value.withPrimary,
    withoutPrimary: value.withoutPrimary,
    coverageRatio: value.coverageRatio,
  };
}

function parseBotOwnershipFoundation(value: unknown): BotOwnershipFoundationSnapshot {
  if (
    !isRecord(value) ||
    typeof value.generatedAt !== 'string' ||
    !isRecord(value.bots) ||
    !isRecord(value.entities) ||
    !isRecord(value.anomalies) ||
    !isRecord(value.repair)
  ) {
    throw new Error('Invalid bot ownership foundation snapshot');
  }

  const { bots, entities, anomalies, repair } = value;
  if (
    typeof bots.configured !== 'number' ||
    typeof bots.adminVisible !== 'number' ||
    typeof bots.active !== 'number' ||
    typeof bots.dormant !== 'number' ||
    typeof bots.draining !== 'number' ||
    typeof bots.disabled !== 'number' ||
    !isRecord(entities.total) ||
    !isRecord(entities.chats) ||
    !isRecord(entities.channels) ||
    typeof anomalies.noPrimary !== 'number' ||
    typeof anomalies.recoverableLegacyOnly !== 'number' ||
    typeof anomalies.recoverableFromMemberships !== 'number' ||
    typeof anomalies.unbound !== 'number' ||
    typeof anomalies.primaryBotUnknown !== 'number' ||
    typeof anomalies.legacyBotUnknown !== 'number' ||
    typeof anomalies.activeMembershipBotUnknown !== 'number' ||
    typeof anomalies.primaryWithoutActiveMembership !== 'number' ||
    typeof anomalies.primaryWithoutAdminAccess !== 'number' ||
    typeof anomalies.sharedChats !== 'number' ||
    typeof repair.enabled !== 'boolean' ||
    typeof repair.activeOnThisRole !== 'boolean' ||
    typeof repair.intervalMs !== 'number' ||
    (repair.lastRunAt !== null &&
      repair.lastRunAt !== undefined &&
      typeof repair.lastRunAt !== 'string') ||
    (repair.lastSuccessAt !== null &&
      repair.lastSuccessAt !== undefined &&
      typeof repair.lastSuccessAt !== 'string') ||
    (repair.lastError !== null &&
      repair.lastError !== undefined &&
      typeof repair.lastError !== 'string') ||
    typeof repair.lastAppliedChanges !== 'number' ||
    typeof repair.totalAppliedChanges !== 'number'
  ) {
    throw new Error('Invalid bot ownership foundation snapshot');
  }

  return {
    generatedAt: value.generatedAt,
    bots: {
      configured: bots.configured,
      adminVisible: bots.adminVisible,
      active: bots.active,
      dormant: bots.dormant,
      draining: bots.draining,
      disabled: bots.disabled,
    },
    entities: {
      total: parseBotOwnershipCoverage(entities.total),
      chats: parseBotOwnershipCoverage(entities.chats),
      channels: parseBotOwnershipCoverage(entities.channels),
    },
    anomalies: {
      noPrimary: anomalies.noPrimary,
      recoverableLegacyOnly: anomalies.recoverableLegacyOnly,
      recoverableFromMemberships: anomalies.recoverableFromMemberships,
      unbound: anomalies.unbound,
      primaryBotUnknown: anomalies.primaryBotUnknown,
      legacyBotUnknown: anomalies.legacyBotUnknown,
      activeMembershipBotUnknown: anomalies.activeMembershipBotUnknown,
      primaryWithoutActiveMembership: anomalies.primaryWithoutActiveMembership,
      primaryWithoutAdminAccess: anomalies.primaryWithoutAdminAccess,
      sharedChats: anomalies.sharedChats,
    },
    repair: {
      enabled: repair.enabled,
      activeOnThisRole: repair.activeOnThisRole,
      intervalMs: repair.intervalMs,
      lastRunAt: typeof repair.lastRunAt === 'string' ? repair.lastRunAt : null,
      lastSuccessAt: typeof repair.lastSuccessAt === 'string' ? repair.lastSuccessAt : null,
      lastError: typeof repair.lastError === 'string' ? repair.lastError : null,
      lastAppliedChanges: repair.lastAppliedChanges,
      totalAppliedChanges: repair.totalAppliedChanges,
    },
  };
}

function parseBotQueueMetricsSnapshot(value: unknown) {
  if (
    !isRecord(value) ||
    !isRecord(value.webhookEvents) ||
    !isRecord(value.queuedByQueue) ||
    !isRecord(value.actionHealth) ||
    (value.oldestQueuedEventId !== null &&
      value.oldestQueuedEventId !== undefined &&
      typeof value.oldestQueuedEventId !== 'string') ||
    (value.oldestQueuedCreatedAt !== null &&
      value.oldestQueuedCreatedAt !== undefined &&
      typeof value.oldestQueuedCreatedAt !== 'string') ||
    typeof value.oldestQueuedLagSec !== 'number' ||
    (value.oldestReceivedEventId !== null &&
      value.oldestReceivedEventId !== undefined &&
      typeof value.oldestReceivedEventId !== 'string') ||
    (value.oldestReceivedCreatedAt !== null &&
      value.oldestReceivedCreatedAt !== undefined &&
      typeof value.oldestReceivedCreatedAt !== 'string') ||
    typeof value.oldestReceivedLagSec !== 'number' ||
    typeof value.effectiveLagSec !== 'number'
  ) {
    throw new Error('Invalid bot queue metrics');
  }

  return {
    webhookEvents: {
      received: parseWebhookStatusMetrics(value.webhookEvents.received),
      queued: parseWebhookStatusMetrics(value.webhookEvents.queued),
      failed: parseWebhookStatusMetrics(value.webhookEvents.failed),
    },
    queuedByQueue: Object.fromEntries(
      Object.entries(value.queuedByQueue).map(([queueName, count]) => [
        queueName,
        typeof count === 'number' ? count : 0,
      ]),
    ),
    actionHealth: parseActionHealthSnapshot(value.actionHealth),
    oldestQueuedEventId:
      typeof value.oldestQueuedEventId === 'string' ? value.oldestQueuedEventId : null,
    oldestQueuedCreatedAt:
      typeof value.oldestQueuedCreatedAt === 'string' ? value.oldestQueuedCreatedAt : null,
    oldestQueuedLagSec: value.oldestQueuedLagSec,
    oldestReceivedEventId:
      typeof value.oldestReceivedEventId === 'string' ? value.oldestReceivedEventId : null,
    oldestReceivedCreatedAt:
      typeof value.oldestReceivedCreatedAt === 'string' ? value.oldestReceivedCreatedAt : null,
    oldestReceivedLagSec: value.oldestReceivedLagSec,
    effectiveLagSec: value.effectiveLagSec,
  };
}

function parseBotWebhookSubscriptionSnapshot(value: unknown): BotWebhookSubscriptionSnapshot {
  if (
    !isRecord(value) ||
    typeof value.botId !== 'string' ||
    (value.status !== 'healthy' &&
      value.status !== 'warning' &&
      value.status !== 'critical' &&
      value.status !== 'disabled') ||
    typeof value.configured !== 'boolean' ||
    (value.url !== null && value.url !== undefined && typeof value.url !== 'string') ||
    (value.checkedAt !== null &&
      value.checkedAt !== undefined &&
      typeof value.checkedAt !== 'string') ||
    (value.reconciledAt !== null &&
      value.reconciledAt !== undefined &&
      typeof value.reconciledAt !== 'string') ||
    !Array.isArray(value.requiredUpdateTypes) ||
    !Array.isArray(value.actualUpdateTypes) ||
    !Array.isArray(value.missingUpdateTypes) ||
    !Array.isArray(value.extraUpdateTypes) ||
    typeof value.otherSubscriptionsCount !== 'number' ||
    (value.lastError !== null &&
      value.lastError !== undefined &&
      typeof value.lastError !== 'string') ||
    (value.note !== null && value.note !== undefined && typeof value.note !== 'string')
  ) {
    throw new Error('Invalid bot webhook subscription snapshot');
  }

  return {
    botId: value.botId,
    status: value.status,
    configured: value.configured,
    url: typeof value.url === 'string' ? value.url : null,
    checkedAt: typeof value.checkedAt === 'string' ? value.checkedAt : null,
    reconciledAt: typeof value.reconciledAt === 'string' ? value.reconciledAt : null,
    requiredUpdateTypes: value.requiredUpdateTypes.filter(
      (item): item is string => typeof item === 'string',
    ),
    actualUpdateTypes: value.actualUpdateTypes.filter(
      (item): item is string => typeof item === 'string',
    ),
    missingUpdateTypes: value.missingUpdateTypes.filter(
      (item): item is string => typeof item === 'string',
    ),
    extraUpdateTypes: value.extraUpdateTypes.filter(
      (item): item is string => typeof item === 'string',
    ),
    otherSubscriptionsCount: value.otherSubscriptionsCount,
    lastError: typeof value.lastError === 'string' ? value.lastError : null,
    note: typeof value.note === 'string' ? value.note : null,
  };
}

function parseWebhookSubscriptionSnapshot(value: unknown): WebhookSubscriptionSnapshot {
  if (
    !isRecord(value) ||
    (value.status !== 'healthy' &&
      value.status !== 'warning' &&
      value.status !== 'critical' &&
      value.status !== 'disabled') ||
    typeof value.configured !== 'boolean' ||
    (value.url !== null && value.url !== undefined && typeof value.url !== 'string') ||
    (value.checkedAt !== null &&
      value.checkedAt !== undefined &&
      typeof value.checkedAt !== 'string') ||
    (value.reconciledAt !== null &&
      value.reconciledAt !== undefined &&
      typeof value.reconciledAt !== 'string') ||
    !Array.isArray(value.requiredUpdateTypes) ||
    !Array.isArray(value.actualUpdateTypes) ||
    !Array.isArray(value.missingUpdateTypes) ||
    !Array.isArray(value.extraUpdateTypes) ||
    typeof value.otherSubscriptionsCount !== 'number' ||
    (value.lastError !== null &&
      value.lastError !== undefined &&
      typeof value.lastError !== 'string') ||
    (value.note !== null && value.note !== undefined && typeof value.note !== 'string') ||
    typeof value.botCount !== 'number' ||
    !isRecord(value.bots)
  ) {
    throw new Error('Invalid webhook subscription snapshot');
  }

  return {
    status: value.status,
    configured: value.configured,
    url: typeof value.url === 'string' ? value.url : null,
    checkedAt: typeof value.checkedAt === 'string' ? value.checkedAt : null,
    reconciledAt: typeof value.reconciledAt === 'string' ? value.reconciledAt : null,
    requiredUpdateTypes: value.requiredUpdateTypes.filter(
      (item): item is string => typeof item === 'string',
    ),
    actualUpdateTypes: value.actualUpdateTypes.filter(
      (item): item is string => typeof item === 'string',
    ),
    missingUpdateTypes: value.missingUpdateTypes.filter(
      (item): item is string => typeof item === 'string',
    ),
    extraUpdateTypes: value.extraUpdateTypes.filter(
      (item): item is string => typeof item === 'string',
    ),
    otherSubscriptionsCount: value.otherSubscriptionsCount,
    lastError: typeof value.lastError === 'string' ? value.lastError : null,
    note: typeof value.note === 'string' ? value.note : null,
    botCount: value.botCount,
    bots: Object.fromEntries(
      Object.entries(value.bots).map(([botId, snapshot]) => [
        botId,
        parseBotWebhookSubscriptionSnapshot(snapshot),
      ]),
    ),
  };
}

function parseSystemDashboardResponse(value: unknown): SystemDashboardResponse {
  if (
    !isRecord(value) ||
    !isRecord(value.summary) ||
    !Array.isArray(value.alerts) ||
    !isRecord(value.queues) ||
    !isRecord(value.webhookSubscription) ||
    !isRecord(value.ownership)
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
      bots: Object.fromEntries(
        Object.entries(isRecord(queues.bots) ? queues.bots : {}).map(([botId, snapshot]) => [
          botId,
          parseBotQueueMetricsSnapshot(snapshot),
        ]),
      ),
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
    webhookSubscription: parseWebhookSubscriptionSnapshot(value.webhookSubscription),
    ownership: parseBotOwnershipFoundation(value.ownership),
    ...(value.burst ? { burst: parseSystemDashboardBurst(value.burst) } : {}),
    ...(value.hotPath ? { hotPath: parseSystemDashboardHotPath(value.hotPath) } : {}),
    ...(value.hotChats ? { hotChats: parseSystemDashboardHotChats(value.hotChats) } : {}),
    ...(value.backgroundBudget
      ? { backgroundBudget: parseSystemDashboardBackgroundBudget(value.backgroundBudget) }
      : {}),
    ...(value.membershipLookup
      ? { membershipLookup: parseSystemDashboardMembershipLookup(value.membershipLookup) }
      : {}),
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
