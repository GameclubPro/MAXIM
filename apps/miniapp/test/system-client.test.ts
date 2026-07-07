import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getSystemBotRoutePreview,
  getSystemBots,
  getSystemDashboard,
} from '../src/lib/api/system-client';
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

function createRecordingApi(payload: unknown, paths: string[]): ApiTransport {
  return {
    request: async (path) => {
      paths.push(path);
      return payload;
    },
    requestKeepalive: () => undefined,
  };
}

function createSystemBotsResponse(overrides: Record<string, unknown> = {}) {
  return {
    generatedAt,
    summary: {
      total: 1,
      adminVisible: 1,
      active: 1,
      draining: 0,
      dormant: 0,
      disabled: 0,
      webhookWarningBotCount: 0,
      problemBotCount: 0,
      primaryEntities: { total: 1, chats: 1, channels: 0 },
      standbyEntities: { total: 0, chats: 0, channels: 0 },
      assistEntities: { total: 0, chats: 0, channels: 0 },
      lostAccess: 0,
      staleAccess: 0,
      deniedAccess: 0,
    },
    bots: [
      {
        botId: 'bot-1',
        label: 'Major',
        characterName: 'Major',
        lifecycleState: 'active',
        adminVisible: true,
        isDefault: true,
        contactId: '100',
        webhook: null,
        operationalDiagnostics: null,
        queue: null,
        maxApiLoad: {
          windowSec: 60,
          totalRequests: 0,
          avgRps: 0,
          peakRps: 0,
          avgLoad: 0,
          peakLoad: 0,
          smoothedLoad: 0,
          background: {
            totalRequests: 0,
            avgRps: 0,
            peakRps: 0,
          },
        },
        entities: {
          primary: { total: 1, chats: 1, channels: 0 },
          standby: { total: 0, chats: 0, channels: 0 },
          assist: { total: 0, chats: 0, channels: 0 },
        },
        access: {
          lost: 0,
          stale: 0,
          denied: 0,
          unknown: 0,
          removedAfterLoss: 0,
        },
        problemSamples: [],
      },
    ],
    ...overrides,
  };
}

function createSystemBotRoutePreviewResponse(overrides: Record<string, unknown> = {}) {
  return {
    generatedAt,
    query: {
      chatId: 'chat-1',
      purpose: 'send_message',
      action: null,
      capability: null,
      fallbackToPrimary: false,
      botId: null,
    },
    chat: {
      exists: true,
      chatId: 'chat-1',
      title: 'Ops Chat',
      entityType: 'chat',
      catalogKind: 'MANAGED',
      storedPrimaryBotId: 'bot-1',
      legacyBotId: null,
    },
    routes: [
      {
        purpose: 'send_message',
        action: null,
        capability: null,
        chatId: 'chat-1',
        primaryBotId: 'bot-1',
        botId: 'bot-1',
        candidateBotIds: ['bot-1'],
        reason: 'primary_confirmed',
        selectedBot: {
          botId: 'bot-1',
          label: 'Major',
          lifecycleState: 'active',
          adminVisible: true,
          isDefault: true,
        },
        candidateBots: [
          {
            botId: 'bot-1',
            label: 'Major',
            lifecycleState: 'active',
            adminVisible: true,
            isDefault: true,
          },
        ],
      },
    ],
    memberships: [
      {
        botId: 'bot-1',
        label: 'Major',
        configured: true,
        lifecycleState: 'active',
        operational: true,
        discoverable: true,
        executable: true,
        role: 'primary',
        status: 'active',
        botAccessState: 'confirmed_admin',
        capabilities: ['access_prewarm'],
        permissionsSummary: {
          checkedAt: generatedAt,
          isAdmin: true,
          isOwner: false,
          permissions: ['write'],
        },
        botAccessCheckedAt: generatedAt,
        botAccessExpiresAt: null,
        botAccessSource: 'snapshot',
        botAccessLastErrorCode: null,
        lastSeenAt: generatedAt,
        lastWebhookAt: generatedAt,
        issues: [],
      },
    ],
    warnings: [],
    ...overrides,
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

test('parses system bots snapshot through contract schema', async () => {
  const snapshot = await getSystemBots(createApi(createSystemBotsResponse()));

  assert.equal(snapshot.summary.total, 1);
  assert.equal(snapshot.bots[0]?.botId, 'bot-1');
  assert.equal(snapshot.bots[0]?.lifecycleState, 'active');
});

test('rejects invalid system bots lifecycle state', async () => {
  const payload = createSystemBotsResponse({
    bots: [
      {
        ...(createSystemBotsResponse().bots[0] as Record<string, unknown>),
        lifecycleState: 'retired',
      },
    ],
  });

  await assert.rejects(() => getSystemBots(createApi(payload)), /Invalid system bots snapshot/u);
});

test('fetches and parses system bot route preview through contract schema', async () => {
  const paths: string[] = [];
  const preview = await getSystemBotRoutePreview(
    createRecordingApi(createSystemBotRoutePreviewResponse(), paths),
    {
      chatId: 'chat-1',
      purpose: 'send_message',
      action: null,
      capability: null,
      fallbackToPrimary: false,
    },
  );

  assert.equal(
    paths[0],
    '/system/bots/routes/preview?chatId=chat-1&purpose=send_message&fallbackToPrimary=false',
  );
  assert.equal(preview.routes[0]?.selectedBot?.botId, 'bot-1');
  assert.equal(preview.memberships[0]?.botAccessState, 'confirmed_admin');
});
