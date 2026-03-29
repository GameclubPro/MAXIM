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

describe('SystemDashboardService', () => {
  it('builds a healthy summary when queues and MAX action health are clean', async () => {
    const service = new SystemDashboardService(
      {
        getSnapshot: jest.fn().mockResolvedValue({
          moderation: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
          webhookCritical: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
          webhookDefault: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
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

  it('builds a critical summary with operator guidance during degrade', async () => {
    const service = new SystemDashboardService(
      {
        getSnapshot: jest.fn().mockResolvedValue({
          moderation: { waiting: 2, active: 1, delayed: 0, failed: 0, completed: 120 },
          webhookCritical: { waiting: 0, active: 1, delayed: 0, failed: 0, completed: 25 },
          webhookDefault: { waiting: 4, active: 2, delayed: 0, failed: 1, completed: 90 },
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
      ]),
    });
  });

  it('adds a critical alert when webhook subscription coverage is broken', async () => {
    const service = new SystemDashboardService(
      {
        getSnapshot: jest.fn().mockResolvedValue({
          moderation: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
          webhookCritical: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
          webhookDefault: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
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
});
