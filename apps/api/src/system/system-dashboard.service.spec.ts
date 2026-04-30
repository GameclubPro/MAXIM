import type { ConfigService } from '@nestjs/config';
import { SystemDashboardService } from './system-dashboard.service';

function createConfigMock(values: Partial<Record<string, number>> = {}): ConfigService {
  return {
    get: jest.fn((key: string, fallback?: number) => {
      if (key in values) {
        return values[key];
      }
      return fallback;
    }),
  } as unknown as ConfigService;
}

function createWebhookSubscriptionSnapshot(
  overrides: Partial<{
    status: 'healthy' | 'warning' | 'critical' | 'disabled';
    configured: boolean;
    url: string | null;
    checkedAt: string | null;
    reconciledAt: string | null;
    requiredUpdateTypes: string[];
    actualUpdateTypes: string[];
    missingUpdateTypes: string[];
    extraUpdateTypes: string[];
    otherSubscriptionsCount: number;
    lastError: string | null;
    note: string | null;
  }> = {},
) {
  return {
    status: 'healthy' as const,
    configured: true,
    url: 'https://maxim.play-team.ru/api/webhook/max/777000_bot/***',
    checkedAt: '2026-03-29T12:00:00.000Z',
    reconciledAt: '2026-03-29T12:00:00.000Z',
    requiredUpdateTypes: ['message_created', 'message_callback', 'user_added'],
    actualUpdateTypes: ['message_created', 'message_callback', 'user_added'],
    missingUpdateTypes: [],
    extraUpdateTypes: [],
    otherSubscriptionsCount: 0,
    lastError: null,
    note: 'Webhook coverage OK',
    ...overrides,
  };
}

function createDefaultWorkerGroups(
  overrides: Partial<
    Record<
      | 'api-moderation'
      | 'api-moderation-realtime-b'
      | 'api-moderation-realtime-c'
      | 'api-moderation-realtime-d',
      {
        queues: string[];
        counters: {
          waiting: number;
          active: number;
          delayed: number;
          failed: number;
          completed: number;
        };
      }
    >
  > = {},
) {
  return {
    'api-moderation': {
      queues: [
        'moderation-default-0',
        'moderation-default-4',
        'moderation-default-8',
        'moderation-default-12',
      ],
      counters: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
    },
    'api-moderation-realtime-b': {
      queues: [
        'moderation-default-1',
        'moderation-default-5',
        'moderation-default-9',
        'moderation-default-13',
      ],
      counters: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
    },
    'api-moderation-realtime-c': {
      queues: [
        'moderation-default-2',
        'moderation-default-6',
        'moderation-default-10',
        'moderation-default-14',
      ],
      counters: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
    },
    'api-moderation-realtime-d': {
      queues: [
        'moderation-default-3',
        'moderation-default-7',
        'moderation-default-11',
        'moderation-default-15',
      ],
      counters: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
    },
    ...overrides,
  };
}

describe('SystemDashboardService', () => {
  it('builds a healthy summary when queues and MAX action health are clean', async () => {
    const service = new SystemDashboardService(
      {
        getSnapshot: jest.fn().mockResolvedValue({
          moderation: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
          webhookCritical: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
          webhookDefault: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
          webhookDefaultWorkerGroups: createDefaultWorkerGroups(),
          webhookBackground: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
          webhookLegacy: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
          actions: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
          webhookEvents: {
            received: { count: 0, oldestEventId: null, oldestCreatedAt: null, oldestLagSec: 0 },
            queued: { count: 0, oldestEventId: null, oldestCreatedAt: null, oldestLagSec: 0 },
            failed: { count: 0, oldestEventId: null, oldestCreatedAt: null, oldestLagSec: 0 },
          },
          actionHealth: {
            windowSec: 60,
            total: 12,
            success: 12,
            failure: 0,
            critical: 0,
            errorRate: 0,
            criticalRate: 0,
          },
          oldestQueuedEventId: null,
          oldestQueuedCreatedAt: null,
          oldestQueuedLagSec: 0,
          oldestReceivedEventId: null,
          oldestReceivedCreatedAt: null,
          oldestReceivedLagSec: 0,
          effectiveLagSec: 0,
          generatedAt: '2026-03-29T12:00:00.000Z',
        }),
      } as never,
      {
        getEffectiveSnapshot: jest.fn().mockResolvedValue({
          mode: 'normal',
          source: 'auto',
          reason: 'system healthy',
          updatedAt: '2026-03-29T12:00:00.000Z',
          manualMode: null,
          queueLagSec: 0,
          action: {
            windowSec: 60,
            total: 12,
            success: 12,
            failure: 0,
            critical: 0,
            errorRate: 0,
            criticalRate: 0,
          },
        }),
      } as never,
      createConfigMock({ QUEUE_LAG_DEGRADE_SEC: 10 }),
      {
        getSnapshot: jest.fn().mockResolvedValue(createWebhookSubscriptionSnapshot()),
      } as never,
    );

    await expect(service.getSnapshot()).resolves.toMatchObject({
      summary: {
        status: 'healthy',
        title: 'Бот работает ровно',
        stabilizing: false,
      },
      alerts: [],
    });
  });

  it('does not raise a failed-webhooks alert for stale historical FAILED tails without recent failures', async () => {
    const service = new SystemDashboardService(
      {
        getSnapshot: jest.fn().mockResolvedValue({
          moderation: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
          webhookCritical: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
          webhookJoin: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
          webhookJoinShards: {},
          webhookDefault: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
          webhookDefaultShards: {},
          webhookDefaultWorkerGroups: createDefaultWorkerGroups(),
          webhookBackground: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
          webhookLegacy: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
          actions: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
          webhookEvents: {
            received: { count: 0, oldestEventId: null, oldestCreatedAt: null, oldestLagSec: 0 },
            queued: { count: 0, oldestEventId: null, oldestCreatedAt: null, oldestLagSec: 0 },
            failed: {
              count: 141,
              activeCount: 0,
              staleCount: 141,
              activeWindowSec: 21600,
              oldestEventId: 'evt-stale-1',
              oldestCreatedAt: null,
              oldestLagSec: 86400,
            },
          },
          userFacingWebhookEvents: {
            received: { count: 0, oldestEventId: null, oldestCreatedAt: null, oldestLagSec: 0 },
            queued: { count: 0, oldestEventId: null, oldestCreatedAt: null, oldestLagSec: 0 },
            failed: {
              count: 141,
              activeCount: 0,
              staleCount: 141,
              activeWindowSec: 21600,
              oldestEventId: 'evt-stale-1',
              oldestCreatedAt: null,
              oldestLagSec: 86400,
            },
          },
          actionHealth: {
            windowSec: 60,
            total: 12,
            success: 12,
            failure: 0,
            critical: 0,
            errorRate: 0,
            criticalRate: 0,
          },
          webhookDynamicLeases: null,
          bots: {},
          oldestQueuedEventId: null,
          oldestQueuedCreatedAt: null,
          oldestQueuedLagSec: 0,
          oldestReceivedEventId: null,
          oldestReceivedCreatedAt: null,
          oldestReceivedLagSec: 0,
          effectiveLagSec: 0,
          userFacingOldestQueuedEventId: null,
          userFacingOldestQueuedCreatedAt: null,
          userFacingOldestQueuedLagSec: 0,
          userFacingOldestReceivedEventId: null,
          userFacingOldestReceivedCreatedAt: null,
          userFacingOldestReceivedLagSec: 0,
          userFacingEffectiveLagSec: 0,
          generatedAt: '2026-03-29T12:00:00.000Z',
        }),
      } as never,
      {
        getEffectiveSnapshot: jest.fn().mockResolvedValue({
          mode: 'normal',
          source: 'auto',
          reason: 'system healthy',
          updatedAt: '2026-03-29T12:00:00.000Z',
          manualMode: null,
          queueLagSec: 0,
          action: {
            windowSec: 60,
            total: 12,
            success: 12,
            failure: 0,
            critical: 0,
            errorRate: 0,
            criticalRate: 0,
          },
        }),
      } as never,
      createConfigMock({ QUEUE_LAG_DEGRADE_SEC: 10 }),
      {
        getSnapshot: jest.fn().mockResolvedValue(createWebhookSubscriptionSnapshot()),
      } as never,
    );

    await expect(service.getSnapshot()).resolves.toMatchObject({
      summary: {
        status: 'healthy',
        title: 'Бот работает ровно',
      },
      alerts: [],
    });
  });

  it('builds a critical summary with operator guidance during degrade', async () => {
    const service = new SystemDashboardService(
      {
        getSnapshot: jest.fn().mockResolvedValue({
          moderation: { waiting: 2, active: 1, delayed: 0, failed: 0, completed: 120 },
          webhookCritical: { waiting: 0, active: 1, delayed: 0, failed: 0, completed: 25 },
          webhookDefault: { waiting: 4, active: 2, delayed: 0, failed: 1, completed: 90 },
          webhookDefaultWorkerGroups: createDefaultWorkerGroups({
            'api-moderation-realtime-c': {
              queues: [
                'moderation-default-2',
                'moderation-default-6',
                'moderation-default-10',
                'moderation-default-14',
              ],
              counters: { waiting: 4, active: 2, delayed: 0, failed: 0, completed: 45 },
            },
          }),
          webhookBackground: { waiting: 3, active: 0, delayed: 0, failed: 0, completed: 10 },
          webhookLegacy: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
          actions: { waiting: 1, active: 1, delayed: 0, failed: 0, completed: 42 },
          webhookEvents: {
            received: { count: 9, oldestEventId: 'evt-1', oldestCreatedAt: null, oldestLagSec: 8 },
            queued: { count: 5, oldestEventId: 'evt-2', oldestCreatedAt: null, oldestLagSec: 13 },
            failed: { count: 141, oldestEventId: 'evt-3', oldestCreatedAt: null, oldestLagSec: 55 },
          },
          actionHealth: {
            windowSec: 60,
            total: 220,
            success: 194,
            failure: 26,
            critical: 14,
            errorRate: 0.118,
            criticalRate: 0.063,
          },
          oldestQueuedEventId: 'evt-2',
          oldestQueuedCreatedAt: null,
          oldestQueuedLagSec: 13,
          oldestReceivedEventId: 'evt-1',
          oldestReceivedCreatedAt: null,
          oldestReceivedLagSec: 8,
          effectiveLagSec: 13,
          generatedAt: '2026-03-29T12:10:00.000Z',
        }),
      } as never,
      {
        getEffectiveSnapshot: jest.fn().mockResolvedValue({
          mode: 'degrade',
          source: 'auto',
          reason: 'queue lag 13.0s; critical MAX API rate 6.30%',
          updatedAt: '2026-03-29T12:10:00.000Z',
          manualMode: null,
          queueLagSec: 13,
          action: {
            windowSec: 60,
            total: 220,
            success: 194,
            failure: 26,
            critical: 14,
            errorRate: 0.118,
            criticalRate: 0.063,
          },
        }),
      } as never,
      createConfigMock({ QUEUE_LAG_DEGRADE_SEC: 10 }),
      {
        getSnapshot: jest.fn().mockResolvedValue(createWebhookSubscriptionSnapshot()),
      } as never,
    );

    await expect(service.getSnapshot()).resolves.toMatchObject({
      summary: {
        status: 'critical',
        title: 'Нужна реакция оператора',
      },
      alerts: expect.arrayContaining([
        expect.objectContaining({ code: 'queue-lag', level: 'critical' }),
        expect.objectContaining({ code: 'failed-webhooks', level: 'critical' }),
        expect.objectContaining({ code: 'critical-rate', level: 'critical' }),
        expect.objectContaining({ code: 'default-worker-skew', level: 'warning' }),
      ]),
    });
  });

  it('adds runtime diagnostics and background budget fields when the services are available', async () => {
    const service = new SystemDashboardService(
      {
        getSnapshot: jest.fn().mockResolvedValue({
          moderation: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
          webhookCritical: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
          webhookJoin: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
          webhookJoinShards: {},
          webhookDefault: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
          webhookDefaultShards: {},
          webhookDefaultWorkerGroups: createDefaultWorkerGroups(),
          webhookBackground: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
          webhookLegacy: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
          actions: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
          webhookEvents: {
            received: { count: 0, oldestEventId: null, oldestCreatedAt: null, oldestLagSec: 0 },
            queued: { count: 0, oldestEventId: null, oldestCreatedAt: null, oldestLagSec: 0 },
            failed: { count: 0, oldestEventId: null, oldestCreatedAt: null, oldestLagSec: 0 },
          },
          userFacingWebhookEvents: {
            received: { count: 0, oldestEventId: null, oldestCreatedAt: null, oldestLagSec: 0 },
            queued: { count: 0, oldestEventId: null, oldestCreatedAt: null, oldestLagSec: 0 },
            failed: { count: 0, oldestEventId: null, oldestCreatedAt: null, oldestLagSec: 0 },
          },
          actionHealth: {
            windowSec: 60,
            total: 0,
            success: 0,
            failure: 0,
            critical: 0,
            errorRate: 0,
            criticalRate: 0,
          },
          bots: {},
          webhookDynamicLeases: null,
          oldestQueuedEventId: null,
          oldestQueuedCreatedAt: null,
          oldestQueuedLagSec: 0,
          oldestReceivedEventId: null,
          oldestReceivedCreatedAt: null,
          oldestReceivedLagSec: 0,
          effectiveLagSec: 0,
          userFacingOldestQueuedEventId: null,
          userFacingOldestQueuedCreatedAt: null,
          userFacingOldestQueuedLagSec: 0,
          userFacingOldestReceivedEventId: null,
          userFacingOldestReceivedCreatedAt: null,
          userFacingOldestReceivedLagSec: 0,
          userFacingEffectiveLagSec: 0,
          generatedAt: '2026-03-29T12:00:00.000Z',
        }),
      } as never,
      {
        getEffectiveSnapshot: jest.fn().mockResolvedValue({
          mode: 'normal',
          source: 'auto',
          reason: 'system healthy',
          updatedAt: '2026-03-29T12:00:00.000Z',
          manualMode: null,
          queueLagSec: 0,
          action: {
            windowSec: 60,
            total: 0,
            success: 0,
            failure: 0,
            critical: 0,
            errorRate: 0,
            criticalRate: 0,
          },
        }),
      } as never,
      createConfigMock({ QUEUE_LAG_DEGRADE_SEC: 10 }),
      {
        getSnapshot: jest.fn().mockResolvedValue(createWebhookSubscriptionSnapshot()),
      } as never,
      undefined,
      {
        recordQueueLagSnapshot: jest.fn().mockResolvedValue(undefined),
        getDashboardSnapshot: jest.fn().mockResolvedValue({
          burst: {
            active: false,
            peakLagSec: 0,
            peakBotId: null,
            startedAt: null,
            lastRecoveredAt: '2026-03-29T11:58:00.000Z',
            sampleAgeMs: 1200,
          },
          hotPath: {
            windowSec: 900,
            failOpenCount: 2,
            stages: [
              {
                stage: 'required-subscription',
                count: 10,
                slowCount: 2,
                timeoutCount: 1,
                skipCount: 1,
                failOpenCount: 2,
                avgElapsedMs: 1800,
                maxElapsedMs: 6200,
                lastObservedAt: '2026-03-29T12:00:00.000Z',
              },
            ],
          },
          hotChats: {
            windowSec: 1800,
            items: [
              {
                chatId: 'chat-1',
                messageCreatedCount: 42,
                botsSeen: 2,
                lastSeenAt: '2026-03-29T12:00:00.000Z',
              },
            ],
          },
          membershipLookup: {
            windowSec: 900,
            hotChannels: 1,
            backoffActiveChats: 1,
            transientIssues: 1,
            terminalIssues: 0,
            hotChannelsSample: [],
            backoffSample: [],
            issueSample: [],
          },
        }),
      } as never,
      {
        getDashboardBudgetSummary: jest.fn().mockResolvedValue({
          windowSec: 600,
          backgroundShare: 0.45,
          topSources: [
            {
              sourceTag: 'managed_refresh',
              totalRequests: 150,
              avgRps: 0.25,
              peakRps: 5,
            },
          ],
          pauseReasons: [
            {
              component: 'admin-managed-refresh',
              sourceTag: 'managed_refresh',
              action: 'pause',
              reason: 'recovery window in progress',
              count: 3,
              lastObservedAt: '2026-03-29T12:00:00.000Z',
            },
          ],
        }),
      } as never,
    );

    await expect(service.getSnapshot()).resolves.toMatchObject({
      burst: {
        active: false,
        sampleAgeMs: 1200,
      },
      hotPath: {
        failOpenCount: 2,
      },
      hotChats: {
        items: [expect.objectContaining({ chatId: 'chat-1', botsSeen: 2 })],
      },
      backgroundBudget: {
        backgroundShare: 0.45,
      },
      membershipLookup: {
        hotChannels: 1,
      },
    });
  });

  it('adds a critical alert when webhook subscription coverage is broken', async () => {
    const service = new SystemDashboardService(
      {
        getSnapshot: jest.fn().mockResolvedValue({
          moderation: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
          webhookCritical: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
          webhookDefault: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
          webhookDefaultWorkerGroups: createDefaultWorkerGroups(),
          webhookBackground: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
          webhookLegacy: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
          actions: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
          webhookEvents: {
            received: { count: 0, oldestEventId: null, oldestCreatedAt: null, oldestLagSec: 0 },
            queued: { count: 0, oldestEventId: null, oldestCreatedAt: null, oldestLagSec: 0 },
            failed: { count: 0, oldestEventId: null, oldestCreatedAt: null, oldestLagSec: 0 },
          },
          actionHealth: {
            windowSec: 60,
            total: 12,
            success: 12,
            failure: 0,
            critical: 0,
            errorRate: 0,
            criticalRate: 0,
          },
          oldestQueuedEventId: null,
          oldestQueuedCreatedAt: null,
          oldestQueuedLagSec: 0,
          oldestReceivedEventId: null,
          oldestReceivedCreatedAt: null,
          oldestReceivedLagSec: 0,
          effectiveLagSec: 0,
          generatedAt: '2026-03-29T12:00:00.000Z',
        }),
      } as never,
      {
        getEffectiveSnapshot: jest.fn().mockResolvedValue({
          mode: 'normal',
          source: 'auto',
          reason: 'system healthy',
          updatedAt: '2026-03-29T12:00:00.000Z',
          manualMode: null,
          queueLagSec: 0,
          action: {
            windowSec: 60,
            total: 12,
            success: 12,
            failure: 0,
            critical: 0,
            errorRate: 0,
            criticalRate: 0,
          },
        }),
      } as never,
      createConfigMock({ QUEUE_LAG_DEGRADE_SEC: 10 }),
      {
        getSnapshot: jest.fn().mockResolvedValue(
          createWebhookSubscriptionSnapshot({
            status: 'critical',
            actualUpdateTypes: ['message_created'],
            missingUpdateTypes: ['message_callback', 'user_added'],
            note: 'Coverage drift',
          }),
        ),
      } as never,
    );

    await expect(service.getSnapshot()).resolves.toMatchObject({
      summary: {
        status: 'critical',
      },
      alerts: expect.arrayContaining([
        expect.objectContaining({ code: 'webhook-subscription-critical', level: 'critical' }),
      ]),
    });
  });

  it('adds an informational alert when dynamic leases are in shadow mode with pending recommendations', async () => {
    const service = new SystemDashboardService(
      {
        getSnapshot: jest.fn().mockResolvedValue({
          moderation: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
          webhookCritical: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
          webhookDefault: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
          webhookDefaultWorkerGroups: createDefaultWorkerGroups(),
          webhookDynamicLeases: {
            mode: 'shadow',
            generatedAt: '2026-03-31T00:00:00.000Z',
            liveWorkerGroups: [
              'api-moderation',
              'api-moderation-realtime-b',
              'api-moderation-realtime-c',
              'api-moderation-realtime-d',
            ],
            queues: {
              'moderation-default-0': {
                homeOwner: 'api-moderation',
                actualOwner: 'api-moderation',
                desiredOwner: 'api-moderation-realtime-b',
                eligibleForDynamicLeases: true,
                handoffPending: true,
                activeJobs: 0,
                pressure: 8,
                reason: 'rebalance-least-loaded',
                claimFencingToken: null,
                claimLeaseUntil: null,
                lastHandoffAt: null,
              },
            },
          },
          webhookBackground: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
          webhookLegacy: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
          actions: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
          webhookEvents: {
            received: { count: 0, oldestEventId: null, oldestCreatedAt: null, oldestLagSec: 0 },
            queued: { count: 0, oldestEventId: null, oldestCreatedAt: null, oldestLagSec: 0 },
            failed: { count: 0, oldestEventId: null, oldestCreatedAt: null, oldestLagSec: 0 },
          },
          actionHealth: {
            windowSec: 60,
            total: 12,
            success: 12,
            failure: 0,
            critical: 0,
            errorRate: 0,
            criticalRate: 0,
          },
          oldestQueuedEventId: null,
          oldestQueuedCreatedAt: null,
          oldestQueuedLagSec: 0,
          oldestReceivedEventId: null,
          oldestReceivedCreatedAt: null,
          oldestReceivedLagSec: 0,
          effectiveLagSec: 0,
          generatedAt: '2026-03-31T00:00:00.000Z',
        }),
      } as never,
      {
        getEffectiveSnapshot: jest.fn().mockResolvedValue({
          mode: 'normal',
          source: 'auto',
          reason: 'system healthy',
          updatedAt: '2026-03-31T00:00:00.000Z',
          manualMode: null,
          queueLagSec: 0,
          action: {
            windowSec: 60,
            total: 12,
            success: 12,
            failure: 0,
            critical: 0,
            errorRate: 0,
            criticalRate: 0,
          },
        }),
      } as never,
      createConfigMock({ QUEUE_LAG_DEGRADE_SEC: 10 }),
      {
        getSnapshot: jest.fn().mockResolvedValue(createWebhookSubscriptionSnapshot()),
      } as never,
    );

    await expect(service.getSnapshot()).resolves.toMatchObject({
      alerts: expect.arrayContaining([
        expect.objectContaining({ code: 'dynamic-lease-shadow', level: 'info' }),
      ]),
    });
  });

  it('surfaces ownership foundation gaps as rollout guidance without marking runtime unhealthy', async () => {
    const service = new SystemDashboardService(
      {
        getSnapshot: jest.fn().mockResolvedValue({
          moderation: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
          webhookCritical: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
          webhookDefault: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
          webhookDefaultWorkerGroups: createDefaultWorkerGroups(),
          webhookBackground: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
          webhookLegacy: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
          actions: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
          webhookEvents: {
            received: { count: 0, oldestEventId: null, oldestCreatedAt: null, oldestLagSec: 0 },
            queued: { count: 0, oldestEventId: null, oldestCreatedAt: null, oldestLagSec: 0 },
            failed: { count: 0, oldestEventId: null, oldestCreatedAt: null, oldestLagSec: 0 },
          },
          actionHealth: {
            windowSec: 60,
            total: 12,
            success: 12,
            failure: 0,
            critical: 0,
            errorRate: 0,
            criticalRate: 0,
          },
          oldestQueuedEventId: null,
          oldestQueuedCreatedAt: null,
          oldestQueuedLagSec: 0,
          oldestReceivedEventId: null,
          oldestReceivedCreatedAt: null,
          oldestReceivedLagSec: 0,
          effectiveLagSec: 0,
          generatedAt: '2026-03-31T00:10:00.000Z',
        }),
      } as never,
      {
        getEffectiveSnapshot: jest.fn().mockResolvedValue({
          mode: 'normal',
          source: 'auto',
          reason: 'system healthy',
          updatedAt: '2026-03-31T00:10:00.000Z',
          manualMode: null,
          queueLagSec: 0,
          action: {
            windowSec: 60,
            total: 12,
            success: 12,
            failure: 0,
            critical: 0,
            errorRate: 0,
            criticalRate: 0,
          },
        }),
      } as never,
      createConfigMock({ QUEUE_LAG_DEGRADE_SEC: 10 }),
      {
        getSnapshot: jest.fn().mockResolvedValue(createWebhookSubscriptionSnapshot()),
      } as never,
      {
        getSnapshot: jest.fn().mockResolvedValue({
          generatedAt: '2026-03-31T00:10:00.000Z',
          bots: {
            configured: 2,
            adminVisible: 2,
            active: 1,
            dormant: 1,
            draining: 0,
            disabled: 0,
          },
          entities: {
            total: { total: 100, withPrimary: 72, withoutPrimary: 28, coverageRatio: 0.72 },
            chats: { total: 90, withPrimary: 66, withoutPrimary: 24, coverageRatio: 0.7333 },
            channels: { total: 10, withPrimary: 6, withoutPrimary: 4, coverageRatio: 0.6 },
          },
          anomalies: {
            noPrimary: 26,
            recoverableLegacyOnly: 2,
            recoverableFromMemberships: 1,
            unbound: 23,
            primaryBotUnknown: 0,
            legacyBotUnknown: 0,
            activeMembershipBotUnknown: 0,
            primaryWithoutActiveMembership: 0,
            primaryWithoutAdminAccess: 0,
            sharedChats: 0,
          },
          repair: {
            enabled: true,
            activeOnThisRole: true,
            intervalMs: 300_000,
            lastRunAt: '2026-03-31T00:10:00.000Z',
            lastSuccessAt: '2026-03-31T00:10:00.000Z',
            lastError: null,
            lastAppliedChanges: 3,
            totalAppliedChanges: 12,
          },
        }),
      } as never,
    );

    await expect(service.getSnapshot()).resolves.toMatchObject({
      summary: {
        status: 'healthy',
      },
      alerts: expect.arrayContaining([
        expect.objectContaining({ code: 'ownership-foundation', level: 'warning' }),
      ]),
      ownership: expect.objectContaining({
        entities: expect.objectContaining({
          total: expect.objectContaining({ withoutPrimary: 28 }),
        }),
      }),
    });
  });

  it('does not treat primary bots without admin rights as ownership blockers', () => {
    const service = new SystemDashboardService(
      {} as never,
      {} as never,
      createConfigMock({ QUEUE_LAG_DEGRADE_SEC: 10 }),
    );

    const alert = (
      service as unknown as {
        buildOwnershipCoverageAlert: (ownership: unknown) => unknown;
      }
    ).buildOwnershipCoverageAlert({
      generatedAt: '2026-03-31T00:10:00.000Z',
      bots: {
        configured: 2,
        adminVisible: 2,
        active: 2,
        dormant: 0,
        draining: 0,
        disabled: 0,
      },
      entities: {
        total: { total: 100, withPrimary: 100, withoutPrimary: 0, coverageRatio: 1 },
        chats: { total: 90, withPrimary: 90, withoutPrimary: 0, coverageRatio: 1 },
        channels: { total: 10, withPrimary: 10, withoutPrimary: 0, coverageRatio: 1 },
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
        primaryWithoutAdminAccess: 42,
        sharedChats: 0,
      },
      repair: {
        enabled: true,
        activeOnThisRole: true,
        intervalMs: 300_000,
        lastRunAt: '2026-03-31T00:10:00.000Z',
        lastSuccessAt: '2026-03-31T00:10:00.000Z',
        lastError: null,
        lastAppliedChanges: 0,
        totalAppliedChanges: 0,
      },
    });

    expect(alert).toBeNull();
  });
});
