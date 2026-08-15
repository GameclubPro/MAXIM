import {
  maxActionLedgerWatchdogSnapshotSchema,
  systemBotRoutePreviewResponseSchema,
  systemBotsSnapshotSchema,
  systemCanaryStateSchema,
  systemDashboardActionLatencySchema,
  systemDashboardWebhookSloSchema,
  systemQueueGroupHealthSchema,
  systemRollbackReadinessSchema,
  systemRuntimeProfileSchema,
} from '@maxim/contracts/system';
import type { ManagedEntityBotCapability } from '@maxim/contracts/managed-entities';
import type {
  BotOwnershipFoundationSnapshot,
  BotWebhookSubscriptionSnapshot,
  SystemCanaryState,
  SystemDashboardAlert,
  SystemDashboardResponse,
  SystemDashboardSpammerReadModel,
  SystemDashboardSpammerSurfaces,
  SystemDashboardWebhookSlo,
  SystemBotsSnapshot,
  SystemBotRouteModerationAction,
  SystemBotRoutePreviewResponse,
  SystemBotRoutePurpose,
  SystemModeSnapshot,
  SystemQueueGroupHealth,
  SystemRollbackReadiness,
  SystemRuntimeProfile,
  WebhookSubscriptionSnapshot,
} from '@maxim/contracts/system';
import type { ApiTransport } from './transport';

type ContractParser<T> = {
  parse(value: unknown): T;
};

export type SystemBotRoutePreviewQuery = {
  chatId: string;
  purpose: 'all' | SystemBotRoutePurpose;
  action?: SystemBotRouteModerationAction | null;
  capability?: ManagedEntityBotCapability | null;
  fallbackToPrimary: boolean;
  botId?: string | null;
};

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
    ...(value.stackLoad ? { stackLoad: parseSystemDashboardStackLoad(value.stackLoad) } : {}),
    ...(value.botLoad ? { botLoad: parseSystemDashboardBotLoad(value.botLoad) } : {}),
  };
}

function parseSystemDashboardStackLoad(value: unknown) {
  if (
    !isRecord(value) ||
    typeof value.windowSec !== 'number' ||
    typeof value.smoothedLoad !== 'number' ||
    typeof value.peakLoad !== 'number' ||
    typeof value.avgLoad !== 'number' ||
    typeof value.slowThreshold !== 'number' ||
    typeof value.pauseThreshold !== 'number'
  ) {
    throw new Error('Invalid system dashboard stack load');
  }

  return {
    windowSec: value.windowSec,
    smoothedLoad: value.smoothedLoad,
    peakLoad: value.peakLoad,
    avgLoad: value.avgLoad,
    slowThreshold: value.slowThreshold,
    pauseThreshold: value.pauseThreshold,
  };
}

function parseSystemDashboardBotLoad(value: unknown) {
  if (
    !isRecord(value) ||
    typeof value.maxSmoothedLoad !== 'number' ||
    typeof value.maxPeakLoad !== 'number' ||
    typeof value.slowThreshold !== 'number' ||
    typeof value.pauseThreshold !== 'number' ||
    !Array.isArray(value.topBots)
  ) {
    throw new Error('Invalid system dashboard bot load');
  }

  return {
    maxSmoothedLoad: value.maxSmoothedLoad,
    maxPeakLoad: value.maxPeakLoad,
    slowThreshold: value.slowThreshold,
    pauseThreshold: value.pauseThreshold,
    topBots: value.topBots.map((item) => {
      if (
        !isRecord(item) ||
        typeof item.botId !== 'string' ||
        typeof item.smoothedLoad !== 'number' ||
        typeof item.peakLoad !== 'number' ||
        typeof item.avgLoad !== 'number'
      ) {
        throw new Error('Invalid system dashboard bot load item');
      }

      return {
        botId: item.botId,
        smoothedLoad: item.smoothedLoad,
        peakLoad: item.peakLoad,
        avgLoad: item.avgLoad,
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

function parseSystemDashboardProblemChats(value: unknown) {
  if (!isRecord(value) || typeof value.windowSec !== 'number' || !Array.isArray(value.items)) {
    throw new Error('Invalid system dashboard problem chats');
  }

  return {
    windowSec: value.windowSec,
    items: value.items.map((item) => {
      if (
        !isRecord(item) ||
        typeof item.chatId !== 'string' ||
        (item.botId !== null && item.botId !== undefined && typeof item.botId !== 'string') ||
        typeof item.category !== 'string' ||
        (item.severity !== 'info' && item.severity !== 'warning' && item.severity !== 'critical') ||
        (item.action !== null && item.action !== undefined && typeof item.action !== 'string') ||
        (item.statusCode !== null &&
          item.statusCode !== undefined &&
          typeof item.statusCode !== 'number') ||
        typeof item.reason !== 'string' ||
        typeof item.count !== 'number' ||
        typeof item.lastObservedAt !== 'string'
      ) {
        throw new Error('Invalid system dashboard problem chat');
      }

      const severity = item.severity as 'info' | 'warning' | 'critical';
      return {
        chatId: item.chatId,
        botId: typeof item.botId === 'string' ? item.botId : null,
        category: item.category,
        severity,
        action: typeof item.action === 'string' ? item.action : null,
        statusCode: typeof item.statusCode === 'number' ? item.statusCode : null,
        reason: item.reason,
        count: item.count,
        lastObservedAt: item.lastObservedAt,
      };
    }),
  };
}

function parseSystemDashboardSpammerSurfaces(value: unknown): SystemDashboardSpammerSurfaces {
  if (!isRecord(value) || typeof value.windowSec !== 'number' || !Array.isArray(value.timings)) {
    throw new Error('Invalid system dashboard spammer surfaces');
  }

  return {
    windowSec: value.windowSec,
    timings: value.timings.map((item) => {
      if (
        !isRecord(item) ||
        typeof item.surface !== 'string' ||
        typeof item.stage !== 'string' ||
        typeof item.count !== 'number' ||
        typeof item.avgMs !== 'number' ||
        typeof item.p95Ms !== 'number' ||
        typeof item.p99Ms !== 'number' ||
        typeof item.maxMs !== 'number' ||
        (item.lastObservedAt !== null &&
          item.lastObservedAt !== undefined &&
          typeof item.lastObservedAt !== 'string')
      ) {
        throw new Error('Invalid system dashboard spammer surface timing');
      }

      return {
        surface: item.surface,
        stage: item.stage,
        count: item.count,
        avgMs: item.avgMs,
        p95Ms: item.p95Ms,
        p99Ms: item.p99Ms,
        maxMs: item.maxMs,
        lastObservedAt: typeof item.lastObservedAt === 'string' ? item.lastObservedAt : null,
      };
    }),
  };
}

function parseSystemDashboardSpammerReadModel(value: unknown): SystemDashboardSpammerReadModel {
  if (
    !isRecord(value) ||
    typeof value.windowSec !== 'number' ||
    !isRecord(value.profileReads) ||
    !isRecord(value.shadow) ||
    !isRecord(value.profileWrites) ||
    !isRecord(value.denormJobs)
  ) {
    throw new Error('Invalid system dashboard spammer read model');
  }

  const { profileReads, shadow, profileWrites, denormJobs } = value;
  if (
    typeof profileReads.hits !== 'number' ||
    typeof profileReads.misses !== 'number' ||
    typeof profileReads.stale !== 'number' ||
    typeof profileReads.fallbacks !== 'number' ||
    typeof profileReads.hitRate !== 'number' ||
    typeof shadow.compared !== 'number' ||
    typeof shadow.matched !== 'number' ||
    typeof shadow.mismatched !== 'number' ||
    (shadow.scoreDrift !== undefined && typeof shadow.scoreDrift !== 'number') ||
    (shadow.scoreDriftRate !== undefined && typeof shadow.scoreDriftRate !== 'number') ||
    typeof shadow.mismatchRate !== 'number' ||
    typeof profileWrites.success !== 'number' ||
    typeof profileWrites.failure !== 'number' ||
    typeof denormJobs.enqueued !== 'number' ||
    typeof denormJobs.enqueueFailed !== 'number' ||
    typeof denormJobs.fastPathEnqueued !== 'number' ||
    typeof denormJobs.fastPathFallbacks !== 'number' ||
    typeof denormJobs.fastPathReplayed !== 'number' ||
    typeof denormJobs.fastPathReplayMissing !== 'number' ||
    typeof denormJobs.processed !== 'number' ||
    typeof denormJobs.failed !== 'number' ||
    typeof denormJobs.avgAgeMs !== 'number' ||
    typeof denormJobs.maxAgeMs !== 'number' ||
    (denormJobs.lastSuccessAt !== null &&
      denormJobs.lastSuccessAt !== undefined &&
      typeof denormJobs.lastSuccessAt !== 'string') ||
    (denormJobs.lastFailureAt !== null &&
      denormJobs.lastFailureAt !== undefined &&
      typeof denormJobs.lastFailureAt !== 'string')
  ) {
    throw new Error('Invalid system dashboard spammer read model');
  }

  return {
    windowSec: value.windowSec,
    profileReads: {
      hits: profileReads.hits,
      misses: profileReads.misses,
      stale: profileReads.stale,
      fallbacks: profileReads.fallbacks,
      hitRate: profileReads.hitRate,
    },
    shadow: {
      compared: shadow.compared,
      matched: shadow.matched,
      mismatched: shadow.mismatched,
      scoreDrift: shadow.scoreDrift ?? 0,
      scoreDriftRate:
        shadow.scoreDriftRate ??
        (shadow.compared > 0
          ? Number((((shadow.scoreDrift ?? 0) as number) / shadow.compared).toFixed(4))
          : 0),
      mismatchRate: shadow.mismatchRate,
    },
    profileWrites: {
      success: profileWrites.success,
      failure: profileWrites.failure,
    },
    denormJobs: {
      enqueued: denormJobs.enqueued,
      enqueueFailed: denormJobs.enqueueFailed,
      fastPathEnqueued: denormJobs.fastPathEnqueued,
      fastPathFallbacks: denormJobs.fastPathFallbacks,
      fastPathReplayed: denormJobs.fastPathReplayed,
      fastPathReplayMissing: denormJobs.fastPathReplayMissing,
      processed: denormJobs.processed,
      failed: denormJobs.failed,
      avgAgeMs: denormJobs.avgAgeMs,
      maxAgeMs: denormJobs.maxAgeMs,
      lastSuccessAt: typeof denormJobs.lastSuccessAt === 'string' ? denormJobs.lastSuccessAt : null,
      lastFailureAt: typeof denormJobs.lastFailureAt === 'string' ? denormJobs.lastFailureAt : null,
    },
  };
}

function parseSystemDashboardWebhookSlo(value: unknown): SystemDashboardWebhookSlo {
  return parseContractValue(systemDashboardWebhookSloSchema, value, 'system dashboard webhook SLO');
}

function parseSystemRuntimeProfile(value: unknown): SystemRuntimeProfile {
  return parseContractValue(systemRuntimeProfileSchema, value, 'system runtime profile');
}

function parseSystemCanaryState(value: unknown): SystemCanaryState {
  return parseContractValue(systemCanaryStateSchema, value, 'system canary state');
}

function parseSystemRollbackReadiness(value: unknown): SystemRollbackReadiness {
  return parseContractValue(systemRollbackReadinessSchema, value, 'system rollback readiness');
}

function parseSystemQueueGroupHealth(value: unknown): SystemQueueGroupHealth {
  return parseContractValue(systemQueueGroupHealthSchema, value, 'system queue group health');
}

function parseContractValue<T>(schema: ContractParser<T>, value: unknown, label: string): T {
  try {
    return schema.parse(value);
  } catch {
    throw new Error(`Invalid ${label}`);
  }
}

function parseQueueCounters(value: unknown) {
  const normalizedValue = value ?? {
    waiting: 0,
    prioritized: 0,
    active: 0,
    delayed: 0,
    failed: 0,
    completed: 0,
  };
  if (
    !isRecord(normalizedValue) ||
    typeof normalizedValue.waiting !== 'number' ||
    typeof normalizedValue.active !== 'number' ||
    typeof normalizedValue.delayed !== 'number' ||
    typeof normalizedValue.failed !== 'number' ||
    typeof normalizedValue.completed !== 'number'
  ) {
    throw new Error('Invalid queue counters');
  }

  return {
    waiting: normalizedValue.waiting,
    prioritized: typeof normalizedValue.prioritized === 'number' ? normalizedValue.prioritized : 0,
    active: normalizedValue.active,
    delayed: normalizedValue.delayed,
    failed: normalizedValue.failed,
    completed: normalizedValue.completed,
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
    ...(typeof value.activeCount === 'number' ? { activeCount: value.activeCount } : {}),
    ...(typeof value.staleCount === 'number' ? { staleCount: value.staleCount } : {}),
    ...(typeof value.activeWindowSec === 'number'
      ? { activeWindowSec: value.activeWindowSec }
      : {}),
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

  const { bots, entities, routingStates, anomalies, repair } = value;
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
    (routingStates !== undefined &&
      (!isRecord(routingStates) ||
        typeof routingStates.ready !== 'number' ||
        typeof routingStates.noEligibleBot !== 'number')) ||
    typeof anomalies.noPrimary !== 'number' ||
    typeof anomalies.recoverableLegacyOnly !== 'number' ||
    typeof anomalies.recoverableFromMemberships !== 'number' ||
    (anomalies.noEligibleBot !== undefined && typeof anomalies.noEligibleBot !== 'number') ||
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
    (repair.rebalanceMode !== undefined &&
      repair.rebalanceMode !== 'off' &&
      repair.rebalanceMode !== 'shadow' &&
      repair.rebalanceMode !== 'canary' &&
      repair.rebalanceMode !== 'on') ||
    (repair.rebalanceCanaryPercent !== undefined &&
      typeof repair.rebalanceCanaryPercent !== 'number') ||
    (repair.rebalanceMaxMovesPerRun !== undefined &&
      typeof repair.rebalanceMaxMovesPerRun !== 'number') ||
    (repair.recommendedMoves !== undefined && typeof repair.recommendedMoves !== 'number') ||
    (repair.lastAppliedMoves !== undefined && typeof repair.lastAppliedMoves !== 'number') ||
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
    routingStates: isRecord(routingStates)
      ? {
          ready: routingStates.ready as number,
          noEligibleBot: routingStates.noEligibleBot as number,
        }
      : {
          ready: Math.max(
            0,
            (entities.total.total as number) -
              (typeof anomalies.noEligibleBot === 'number' ? anomalies.noEligibleBot : 0),
          ),
          noEligibleBot: typeof anomalies.noEligibleBot === 'number' ? anomalies.noEligibleBot : 0,
        },
    anomalies: {
      noPrimary: anomalies.noPrimary,
      recoverableLegacyOnly: anomalies.recoverableLegacyOnly,
      recoverableFromMemberships: anomalies.recoverableFromMemberships,
      noEligibleBot: typeof anomalies.noEligibleBot === 'number' ? anomalies.noEligibleBot : 0,
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
      rebalanceMode:
        repair.rebalanceMode === 'shadow' ||
        repair.rebalanceMode === 'canary' ||
        repair.rebalanceMode === 'on'
          ? repair.rebalanceMode
          : 'off',
      rebalanceCanaryPercent:
        typeof repair.rebalanceCanaryPercent === 'number' ? repair.rebalanceCanaryPercent : 0,
      rebalanceMaxMovesPerRun:
        typeof repair.rebalanceMaxMovesPerRun === 'number' ? repair.rebalanceMaxMovesPerRun : 25,
      recommendedMoves: typeof repair.recommendedMoves === 'number' ? repair.recommendedMoves : 0,
      lastAppliedMoves: typeof repair.lastAppliedMoves === 'number' ? repair.lastAppliedMoves : 0,
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

  const userFacingWebhookEvents = isRecord(value.userFacingWebhookEvents)
    ? {
        received: parseWebhookStatusMetrics(value.userFacingWebhookEvents.received),
        queued: parseWebhookStatusMetrics(value.userFacingWebhookEvents.queued),
        failed: parseWebhookStatusMetrics(value.userFacingWebhookEvents.failed),
      }
    : {
        received: parseWebhookStatusMetrics(value.webhookEvents.received),
        queued: parseWebhookStatusMetrics(value.webhookEvents.queued),
        failed: parseWebhookStatusMetrics(value.webhookEvents.failed),
      };

  return {
    webhookEvents: {
      received: parseWebhookStatusMetrics(value.webhookEvents.received),
      queued: parseWebhookStatusMetrics(value.webhookEvents.queued),
      failed: parseWebhookStatusMetrics(value.webhookEvents.failed),
    },
    userFacingWebhookEvents,
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
    userFacingOldestQueuedEventId:
      typeof value.userFacingOldestQueuedEventId === 'string'
        ? value.userFacingOldestQueuedEventId
        : null,
    userFacingOldestQueuedCreatedAt:
      typeof value.userFacingOldestQueuedCreatedAt === 'string'
        ? value.userFacingOldestQueuedCreatedAt
        : null,
    userFacingOldestQueuedLagSec:
      typeof value.userFacingOldestQueuedLagSec === 'number'
        ? value.userFacingOldestQueuedLagSec
        : 0,
    userFacingOldestReceivedEventId:
      typeof value.userFacingOldestReceivedEventId === 'string'
        ? value.userFacingOldestReceivedEventId
        : null,
    userFacingOldestReceivedCreatedAt:
      typeof value.userFacingOldestReceivedCreatedAt === 'string'
        ? value.userFacingOldestReceivedCreatedAt
        : null,
    userFacingOldestReceivedLagSec:
      typeof value.userFacingOldestReceivedLagSec === 'number'
        ? value.userFacingOldestReceivedLagSec
        : 0,
    userFacingEffectiveLagSec:
      typeof value.userFacingEffectiveLagSec === 'number' ? value.userFacingEffectiveLagSec : 0,
  };
}

function parseBotWebhookOperationalDiagnostics(
  value: unknown,
): NonNullable<BotWebhookSubscriptionSnapshot['operationalDiagnostics']> {
  if (
    !isRecord(value) ||
    typeof value.lifecycleState !== 'string' ||
    typeof value.activeMemberships !== 'number' ||
    typeof value.hasCurrentSubscription !== 'boolean' ||
    (value.lastIncomingWebhookAt !== null &&
      value.lastIncomingWebhookAt !== undefined &&
      typeof value.lastIncomingWebhookAt !== 'string') ||
    (value.lastMembershipWebhookAt !== null &&
      value.lastMembershipWebhookAt !== undefined &&
      typeof value.lastMembershipWebhookAt !== 'string') ||
    !Array.isArray(value.issueCodes)
  ) {
    throw new Error('Invalid bot webhook operational diagnostics');
  }

  return {
    lifecycleState: value.lifecycleState,
    activeMemberships: value.activeMemberships,
    hasCurrentSubscription: value.hasCurrentSubscription,
    lastIncomingWebhookAt:
      typeof value.lastIncomingWebhookAt === 'string' ? value.lastIncomingWebhookAt : null,
    lastMembershipWebhookAt:
      typeof value.lastMembershipWebhookAt === 'string' ? value.lastMembershipWebhookAt : null,
    issueCodes: value.issueCodes.filter(
      (item): item is 'no-active-memberships' | 'no-incoming-webhooks' =>
        item === 'no-active-memberships' || item === 'no-incoming-webhooks',
    ),
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
    ...(value.operationalDiagnostics !== undefined
      ? {
          operationalDiagnostics: parseBotWebhookOperationalDiagnostics(
            value.operationalDiagnostics,
          ),
        }
      : {}),
  };
}

function parseWebhookSubscriptionOperationalDiagnostics(
  value: unknown,
): NonNullable<WebhookSubscriptionSnapshot['operationalDiagnostics']> {
  if (
    !isRecord(value) ||
    typeof value.warningBotCount !== 'number' ||
    !Array.isArray(value.warningBotIds) ||
    !Array.isArray(value.noActiveMembershipBotIds) ||
    !Array.isArray(value.noIncomingWebhookBotIds)
  ) {
    throw new Error('Invalid webhook subscription operational diagnostics');
  }

  return {
    warningBotCount: value.warningBotCount,
    warningBotIds: value.warningBotIds.filter((item): item is string => typeof item === 'string'),
    noActiveMembershipBotIds: value.noActiveMembershipBotIds.filter(
      (item): item is string => typeof item === 'string',
    ),
    noIncomingWebhookBotIds: value.noIncomingWebhookBotIds.filter(
      (item): item is string => typeof item === 'string',
    ),
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
    ...(value.operationalDiagnostics !== undefined
      ? {
          operationalDiagnostics: parseWebhookSubscriptionOperationalDiagnostics(
            value.operationalDiagnostics,
          ),
        }
      : {}),
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
      webhookJoin: parseQueueCounters(queues.webhookJoin),
      webhookJoinShards: Object.fromEntries(
        Object.entries(isRecord(queues.webhookJoinShards) ? queues.webhookJoinShards : {}).map(
          ([queueName, counters]) => [queueName, parseQueueCounters(counters)],
        ),
      ),
      webhookDefault: parseQueueCounters(queues.webhookDefault),
      webhookDefaultShards: Object.fromEntries(
        Object.entries(
          isRecord(queues.webhookDefaultShards) ? queues.webhookDefaultShards : {},
        ).map(([queueName, counters]) => [queueName, parseQueueCounters(counters)]),
      ),
      webhookDefaultWorkerGroups: Object.fromEntries(
        Object.entries(
          isRecord(queues.webhookDefaultWorkerGroups) ? queues.webhookDefaultWorkerGroups : {},
        ).map(([groupName, rawGroup]) => {
          const group = isRecord(rawGroup) ? rawGroup : {};
          return [
            groupName,
            {
              queues: Array.isArray(group.queues)
                ? group.queues.filter((item): item is string => typeof item === 'string')
                : [],
              counters: parseQueueCounters(group.counters),
            },
          ];
        }),
      ),
      webhookBackground: parseQueueCounters(queues.webhookBackground),
      webhookLegacy: parseQueueCounters(queues.webhookLegacy),
      actions: parseQueueCounters(queues.actions),
      actionQueues: Object.fromEntries(
        Object.entries(isRecord(queues.actionQueues) ? queues.actionQueues : {}).map(
          ([queueName, counters]) => [queueName, parseQueueCounters(counters)],
        ),
      ),
      globalSpammerDenorm: parseQueueCounters(queues.globalSpammerDenorm),
      auxiliaryQueues: Object.fromEntries(
        Object.entries(isRecord(queues.auxiliaryQueues) ? queues.auxiliaryQueues : {}).map(
          ([queueName, counters]) => [queueName, parseQueueCounters(counters)],
        ),
      ),
      webhookEvents: {
        received: parseWebhookStatusMetrics(queues.webhookEvents.received),
        queued: parseWebhookStatusMetrics(queues.webhookEvents.queued),
        failed: parseWebhookStatusMetrics(queues.webhookEvents.failed),
      },
      userFacingWebhookEvents: isRecord(queues.userFacingWebhookEvents)
        ? {
            received: parseWebhookStatusMetrics(queues.userFacingWebhookEvents.received),
            queued: parseWebhookStatusMetrics(queues.userFacingWebhookEvents.queued),
            failed: parseWebhookStatusMetrics(queues.userFacingWebhookEvents.failed),
          }
        : {
            received: parseWebhookStatusMetrics(queues.webhookEvents.received),
            queued: parseWebhookStatusMetrics(queues.webhookEvents.queued),
            failed: parseWebhookStatusMetrics(queues.webhookEvents.failed),
          },
      actionHealth: parseActionHealthSnapshot(queues.actionHealth),
      actionLedgerWatchdog:
        queues.actionLedgerWatchdog === null || queues.actionLedgerWatchdog === undefined
          ? null
          : maxActionLedgerWatchdogSnapshotSchema.parse(queues.actionLedgerWatchdog),
      webhookDynamicLeases: queues.webhookDynamicLeases ?? null,
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
      userFacingOldestQueuedEventId:
        typeof queues.userFacingOldestQueuedEventId === 'string'
          ? queues.userFacingOldestQueuedEventId
          : null,
      userFacingOldestQueuedCreatedAt:
        typeof queues.userFacingOldestQueuedCreatedAt === 'string'
          ? queues.userFacingOldestQueuedCreatedAt
          : null,
      userFacingOldestQueuedLagSec:
        typeof queues.userFacingOldestQueuedLagSec === 'number'
          ? queues.userFacingOldestQueuedLagSec
          : 0,
      userFacingOldestReceivedEventId:
        typeof queues.userFacingOldestReceivedEventId === 'string'
          ? queues.userFacingOldestReceivedEventId
          : null,
      userFacingOldestReceivedCreatedAt:
        typeof queues.userFacingOldestReceivedCreatedAt === 'string'
          ? queues.userFacingOldestReceivedCreatedAt
          : null,
      userFacingOldestReceivedLagSec:
        typeof queues.userFacingOldestReceivedLagSec === 'number'
          ? queues.userFacingOldestReceivedLagSec
          : 0,
      userFacingEffectiveLagSec:
        typeof queues.userFacingEffectiveLagSec === 'number' ? queues.userFacingEffectiveLagSec : 0,
      generatedAt: queues.generatedAt,
    },
    mode: parseSystemModeSnapshot(value.mode),
    webhookSubscription: parseWebhookSubscriptionSnapshot(value.webhookSubscription),
    ownership: parseBotOwnershipFoundation(value.ownership),
    ...(value.runtimeProfile
      ? { runtimeProfile: parseSystemRuntimeProfile(value.runtimeProfile) }
      : {}),
    ...(value.canaryState ? { canaryState: parseSystemCanaryState(value.canaryState) } : {}),
    ...(value.rollbackReadiness
      ? { rollbackReadiness: parseSystemRollbackReadiness(value.rollbackReadiness) }
      : {}),
    ...(value.queueGroupHealth
      ? { queueGroupHealth: parseSystemQueueGroupHealth(value.queueGroupHealth) }
      : {}),
    ...(value.burst ? { burst: parseSystemDashboardBurst(value.burst) } : {}),
    ...(value.hotPath ? { hotPath: parseSystemDashboardHotPath(value.hotPath) } : {}),
    ...(value.hotChats ? { hotChats: parseSystemDashboardHotChats(value.hotChats) } : {}),
    ...(value.backgroundBudget
      ? { backgroundBudget: parseSystemDashboardBackgroundBudget(value.backgroundBudget) }
      : {}),
    ...(value.membershipLookup
      ? { membershipLookup: parseSystemDashboardMembershipLookup(value.membershipLookup) }
      : {}),
    ...(value.problemChats
      ? { problemChats: parseSystemDashboardProblemChats(value.problemChats) }
      : {}),
    ...(value.spammerSurfaces
      ? { spammerSurfaces: parseSystemDashboardSpammerSurfaces(value.spammerSurfaces) }
      : {}),
    ...(value.spammerReadModel
      ? { spammerReadModel: parseSystemDashboardSpammerReadModel(value.spammerReadModel) }
      : {}),
    ...(value.webhookSlo ? { webhookSlo: parseSystemDashboardWebhookSlo(value.webhookSlo) } : {}),
    ...(value.slo ? { slo: parseSystemDashboardWebhookSlo(value.slo) } : {}),
    ...(value.actionLatency !== undefined
      ? {
          actionLatency: parseContractValue(
            systemDashboardActionLatencySchema,
            value.actionLatency,
            'system dashboard action latency',
          ),
        }
      : {}),
  };
}

export async function getSystemDashboard(api: ApiTransport): Promise<SystemDashboardResponse> {
  const response = await api.request('/system/dashboard');
  return parseSystemDashboardResponse(response);
}

export async function getSystemBots(api: ApiTransport): Promise<SystemBotsSnapshot> {
  const response = await api.request('/system/bots');
  return parseContractValue(systemBotsSnapshotSchema, response, 'system bots snapshot');
}

export async function getSystemBotRoutePreview(
  api: ApiTransport,
  query: SystemBotRoutePreviewQuery,
): Promise<SystemBotRoutePreviewResponse> {
  const params = new URLSearchParams({
    chatId: query.chatId,
    purpose: query.purpose,
    fallbackToPrimary: query.fallbackToPrimary ? 'true' : 'false',
  });

  if (query.action) {
    params.set('action', query.action);
  }
  if (query.capability) {
    params.set('capability', query.capability);
  }
  if (query.botId) {
    params.set('botId', query.botId);
  }

  const response = await api.request(`/system/bots/routes/preview?${params.toString()}`);
  return parseContractValue(
    systemBotRoutePreviewResponseSchema,
    response,
    'system bot route preview',
  );
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
