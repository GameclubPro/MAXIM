import assert from 'node:assert/strict';
import test from 'node:test';
import { getSystemDashboard } from '../src/lib/api/system-client';
import type { ApiTransport } from '../src/lib/api/transport';

const generatedAt = '2026-07-06T10:00:00.000Z';

function queueCounters() {
  return {
    waiting: 0,
    prioritized: 0,
    active: 0,
    delayed: 0,
    failed: 0,
    completed: 1,
  };
}

function webhookMetrics() {
  return {
    count: 0,
    oldestEventId: null,
    oldestCreatedAt: null,
    oldestLagSec: 0,
  };
}

function actionHealth() {
  return {
    windowSec: 60,
    total: 0,
    success: 0,
    failure: 0,
    critical: 0,
    errorRate: 0,
    criticalRate: 0,
  };
}

function ownershipCoverage() {
  return {
    total: 0,
    withPrimary: 0,
    withoutPrimary: 0,
    coverageRatio: 1,
  };
}

function createDashboardResponse(overrides: Record<string, unknown> = {}) {
  return {
    summary: {
      status: 'healthy',
      title: 'OK',
      detail: 'Runtime is healthy',
      generatedAt,
      stabilizing: false,
    },
    alerts: [],
    queues: {
      moderation: queueCounters(),
      webhookCritical: queueCounters(),
      webhookDefault: queueCounters(),
      webhookBackground: queueCounters(),
      webhookLegacy: queueCounters(),
      actions: queueCounters(),
      globalSpammerDenorm: queueCounters(),
      auxiliaryQueues: {},
      webhookEvents: {
        received: webhookMetrics(),
        queued: webhookMetrics(),
        failed: webhookMetrics(),
      },
      actionHealth: actionHealth(),
      bots: {},
      oldestQueuedEventId: null,
      oldestQueuedCreatedAt: null,
      oldestQueuedLagSec: 0,
      oldestReceivedEventId: null,
      oldestReceivedCreatedAt: null,
      oldestReceivedLagSec: 0,
      effectiveLagSec: 0,
      generatedAt,
    },
    mode: {
      mode: 'normal',
      source: 'auto',
      reason: 'ok',
      updatedAt: generatedAt,
      manualMode: null,
      queueLagSec: 0,
      action: actionHealth(),
    },
    webhookSubscription: {
      status: 'healthy',
      configured: true,
      url: 'https://major-maksimov.ru/api/v1/max/webhook',
      checkedAt: generatedAt,
      reconciledAt: generatedAt,
      requiredUpdateTypes: [],
      actualUpdateTypes: [],
      missingUpdateTypes: [],
      extraUpdateTypes: [],
      otherSubscriptionsCount: 0,
      lastError: null,
      note: null,
      botCount: 0,
      bots: {},
    },
    ownership: {
      generatedAt,
      bots: {
        configured: 0,
        adminVisible: 0,
        active: 0,
        dormant: 0,
        draining: 0,
        disabled: 0,
      },
      entities: {
        total: ownershipCoverage(),
        chats: ownershipCoverage(),
        channels: ownershipCoverage(),
      },
      anomalies: {
        noPrimary: 0,
        recoverableLegacyOnly: 0,
        recoverableFromMemberships: 0,
        unbound: 0,
        primaryBotUnknown: 0,
        legacyBotUnknown: 0,
        activeMembershipBotUnknown: 0,
        primaryWithoutActiveMembership: 0,
        primaryWithoutAdminAccess: 0,
        sharedChats: 0,
      },
      repair: {
        enabled: true,
        activeOnThisRole: false,
        intervalMs: 300000,
        lastRunAt: null,
        lastSuccessAt: null,
        lastError: null,
        lastAppliedChanges: 0,
        totalAppliedChanges: 0,
      },
    },
    runtimeProfile: {
      appRole: 'ingress',
      serviceName: 'api-ingress',
      serviceTitle: 'Ingress API',
      queueProfile: 'ingress',
      queuePriority: 'http-ingress',
      topologySource: 'declared-service',
      httpEnabled: true,
      ingressEnabled: true,
      adminEnabled: false,
      enqueueEnabled: false,
      moderationEnabled: false,
      actionEnabled: false,
      enabledQueues: [],
      dynamicLeasesMode: 'off',
      dynamicLeasesWorkerGroup: null,
      canaryShardIds: [],
      targetWebhookP95Ms: 1000,
      generatedAt,
    },
    canaryState: {
      enabled: false,
      mode: 'off',
      status: 'disabled',
      recommendation: 'observe',
      workerGroup: null,
      canaryShardIds: [],
      liveWorkerGroups: [],
      handoffPendingQueues: [],
      unhealthyQueues: [],
      reason: 'disabled',
    },
    rollbackReadiness: {
      status: 'ready',
      canRollbackRuntime: true,
      liveOk: true,
      readyOk: true,
      webhookSloOk: true,
      queueLagOk: true,
      failedWebhookOk: true,
      reasons: [],
      command: './infra/scripts/vps-connect.sh rollback-runtime <git-ref>',
    },
    queueGroupHealth: {
      status: 'healthy',
      groups: [],
      generatedAt,
    },
    ...overrides,
  };
}

function createApi(payload: unknown): ApiTransport {
  return {
    request: async () => payload,
    requestKeepalive: () => undefined,
  };
}

test('parses runtime dashboard fields through contract schemas', async () => {
  const dashboard = await getSystemDashboard(createApi(createDashboardResponse()));

  assert.equal(dashboard.runtimeProfile?.appRole, 'ingress');
  assert.equal(dashboard.canaryState?.status, 'disabled');
  assert.equal(dashboard.rollbackReadiness?.status, 'ready');
  assert.equal(dashboard.queueGroupHealth?.status, 'healthy');
});

test('rejects invalid runtime dashboard enum values', async () => {
  const payload = createDashboardResponse({
    runtimeProfile: {
      ...createDashboardResponse().runtimeProfile,
      appRole: 'public-api',
    },
  });

  await assert.rejects(() => getSystemDashboard(createApi(payload)), /Invalid system runtime profile/u);
});
