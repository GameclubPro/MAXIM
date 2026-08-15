import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getSystemBotRoutePreview,
  getSystemBots,
  getSystemDashboard,
} from '../src/lib/api/system-client';
import { systemDashboardResponseSchema } from '@maxim/contracts/system';
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

function emptyLatencyPercentiles() {
  return {
    sampleCount: 0,
    p50Ms: null,
    p95Ms: null,
    p99Ms: null,
  };
}

function actionLatencySnapshot() {
  return {
    basis: 'terminal_outcomes',
    windowBasis: 'completed_at',
    actionStartBasis: 'max_enqueued_at_scheduled_for',
    windowSec: 900,
    windowStartedAt: '2026-07-06T09:45:00.000Z',
    sampleLimit: 5_000,
    actionSampleCount: 0,
    actionSampleTruncated: false,
    actionSampledFrom: null,
    overall: {
      effectiveReadyToLastAttempt: emptyLatencyPercentiles(),
      lastAttemptToTerminal: emptyLatencyPercentiles(),
      effectiveReadyToTerminal: emptyLatencyPercentiles(),
    },
    byAction: [],
    byOutcome: [],
    bySource: [],
    byBot: [],
    byTrafficClass: [],
    moderationDelete: {
      sampleCount: 0,
      sampleTruncated: false,
      sampledFrom: null,
      overall: {
        messageToFirstAttempt: emptyLatencyPercentiles(),
        firstAttemptToTerminal: emptyLatencyPercentiles(),
        messageToTerminal: emptyLatencyPercentiles(),
      },
      byOutcome: [],
    },
    generatedAt,
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
      actionQueues: {
        'moderation-actions': queueCounters(),
        'max-actions-critical': { ...queueCounters(), waiting: 2 },
        'max-actions-interactive': queueCounters(),
        'max-actions-background': queueCounters(),
      },
      globalSpammerDenorm: queueCounters(),
      auxiliaryQueues: {},
      webhookEvents: {
        received: webhookMetrics(),
        queued: webhookMetrics(),
        failed: webhookMetrics(),
      },
      actionHealth: actionHealth(),
      actionLedgerWatchdog: {
        enabled: true,
        activeOnThisRole: true,
        staleAfterSec: 300,
        intervalSec: 60,
        lastRunAt: generatedAt,
        lastSuccessAt: generatedAt,
        lastError: null,
        lastRunReason: 'scheduled',
        staleCount: 1,
        staleEnqueuedCount: 0,
        staleInProgressCount: 1,
        oldestStaleAgeSec: 600,
        lastScannedCount: 1,
        lastReconciledCount: 1,
        lastQuarantinedCount: 1,
        lastTerminalFailedCount: 0,
        lastRecoveredSucceededCount: 0,
        lastDeferredCount: 0,
        lastConflictCount: 0,
        lastScanTruncated: false,
        generatedAt,
      },
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
      routingStates: {
        ready: 0,
        noEligibleBot: 0,
      },
      anomalies: {
        noPrimary: 0,
        recoverableLegacyOnly: 0,
        recoverableFromMemberships: 0,
        noEligibleBot: 0,
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
        rebalanceMode: 'off',
        rebalanceCanaryPercent: 0,
        rebalanceMaxMovesPerRun: 25,
        recommendedMoves: 0,
        lastAppliedMoves: 0,
        lastRunAt: null,
        lastSuccessAt: null,
        lastError: null,
        lastAppliedChanges: 0,
        totalAppliedChanges: 0,
      },
    },
    actionLatency: actionLatencySnapshot(),
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
  assert.equal(dashboard.queues.actionQueues['max-actions-critical']?.waiting, 2);
  assert.equal(dashboard.queues.actionLedgerWatchdog?.lastQuarantinedCount, 1);
  assert.equal(dashboard.actionLatency?.actionStartBasis, 'max_enqueued_at_scheduled_for');
  assert.equal(dashboard.actionLatency?.overall.effectiveReadyToLastAttempt.sampleCount, 0);
});

test('parses webhook sample metadata with a pre-rejected-counter ingress payload', async () => {
  const dashboard = await getSystemDashboard(
    createApi(
      createDashboardResponse({
        webhookSlo: {
          status: 'healthy',
          windowSec: 300,
          targetProcessingMs: 1_000,
          totalEvents: 1,
          processedEvents: 1,
          failedEvents: 0,
          sampleLimit: 1,
          sampledProcessedEvents: 1,
          processedSampleTruncated: false,
          processedSampledFrom: generatedAt,
          p95ProcessingMs: 100,
          p99ProcessingMs: 100,
          underTargetRatio: 1,
          oldestUnprocessedLagSec: 0,
          oldestUnprocessedEventId: null,
          lastProcessedAt: generatedAt,
          ingress: {
            available: true,
            targetMs: 1_000,
            attemptedReceipts: 1,
            persistedReceipts: 1,
            failedReceipts: 0,
            sampledReceipts: 1,
            p95LatencyMs: 50,
            p99LatencyMs: 50,
            underTargetRatio: 1,
            bots: {
              'bot-1': {
                attemptedReceipts: 1,
                persistedReceipts: 1,
                failedReceipts: 0,
              },
            },
            route: {
              attemptedRequests: 2,
              outcomes: {
                accepted: 1,
                authentication_rejected: 0,
                admission_rejected: 0,
                invalid_json: 0,
                invalid_payload: 1,
                payload_too_large: 0,
                timed_out: 0,
                failed: 0,
              },
              bots: {
                'bot-1': {
                  attemptedRequests: 2,
                  outcomes: {
                    accepted: 1,
                    authentication_rejected: 0,
                    admission_rejected: 0,
                    invalid_json: 0,
                    invalid_payload: 1,
                    payload_too_large: 0,
                    timed_out: 0,
                    failed: 0,
                  },
                },
              },
            },
          },
          enqueue: {
            targetMs: 1_000,
            sampledEvents: 1,
            sampleTruncated: false,
            sampledFrom: generatedAt,
            p95LatencyMs: 50,
            p99LatencyMs: 50,
            underTargetRatio: 1,
            oldestPendingLagSec: 0,
            oldestPendingEventId: null,
            lastQueuedAt: generatedAt,
          },
          generatedAt,
        },
      }),
    ),
  );

  assert.equal(dashboard.webhookSlo?.ingress?.rejectedReceipts, 0);
  assert.equal(dashboard.webhookSlo?.ingress?.bots['bot-1']?.rejectedReceipts, 0);
  assert.equal(dashboard.webhookSlo?.ingress?.route.attemptedRequests, 2);
  assert.equal(dashboard.webhookSlo?.ingress?.route.outcomes.invalid_payload, 1);
  assert.equal(dashboard.webhookSlo?.ingress?.route.bots['bot-1']?.outcomes.invalid_payload, 1);
  assert.equal(dashboard.webhookSlo?.processedSampleTruncated, false);
  assert.equal(dashboard.webhookSlo?.processedSampledFrom, generatedAt);
  assert.equal(dashboard.webhookSlo?.enqueue?.sampleTruncated, false);
  assert.equal(dashboard.webhookSlo?.enqueue?.sampledFrom, generatedAt);
});

test('preserves failed webhook active and stale metrics from the API', async () => {
  const base = createDashboardResponse();
  const dashboard = await getSystemDashboard(
    createApi({
      ...base,
      queues: {
        ...(base.queues as Record<string, unknown>),
        webhookEvents: {
          received: webhookMetrics(),
          queued: webhookMetrics(),
          failed: {
            ...webhookMetrics(),
            count: 7,
            activeCount: 2,
            staleCount: 5,
            activeWindowSec: 21600,
          },
        },
        userFacingWebhookEvents: {
          received: webhookMetrics(),
          queued: webhookMetrics(),
          failed: {
            ...webhookMetrics(),
            count: 3,
            activeCount: 1,
            staleCount: 2,
            activeWindowSec: 21600,
          },
        },
      },
    }),
  );

  assert.equal(dashboard.queues.webhookEvents.failed.activeCount, 2);
  assert.equal(dashboard.queues.webhookEvents.failed.staleCount, 5);
  assert.equal(dashboard.queues.webhookEvents.failed.activeWindowSec, 21600);
  assert.equal(dashboard.queues.userFacingWebhookEvents.failed.activeCount, 1);
});

test('contract schema preserves failed webhook active and stale metrics', () => {
  const parsed = systemDashboardResponseSchema.parse(
    createDashboardResponse({
      queues: {
        ...createDashboardResponse().queues,
        webhookEvents: {
          received: webhookMetrics(),
          queued: webhookMetrics(),
          failed: {
            ...webhookMetrics(),
            count: 7,
            activeCount: 2,
            staleCount: 5,
            activeWindowSec: 21600,
          },
        },
      },
    }),
  );

  assert.equal(parsed.queues.webhookEvents.failed.activeCount, 2);
  assert.equal(parsed.queues.webhookEvents.failed.staleCount, 5);
  assert.equal(parsed.queues.webhookEvents.failed.activeWindowSec, 21600);
});

test('rejects invalid runtime dashboard enum values', async () => {
  const payload = createDashboardResponse({
    runtimeProfile: {
      ...createDashboardResponse().runtimeProfile,
      appRole: 'public-api',
    },
  });

  await assert.rejects(
    () => getSystemDashboard(createApi(payload)),
    /Invalid system runtime profile/u,
  );
});

test('rejects present falsy action latency payloads instead of treating them as absent', async () => {
  for (const actionLatency of [null, false, 0, '']) {
    await assert.rejects(
      () => getSystemDashboard(createApi(createDashboardResponse({ actionLatency }))),
      /Invalid system dashboard action latency/u,
    );
  }
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
