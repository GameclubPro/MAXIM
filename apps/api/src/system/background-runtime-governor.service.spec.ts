import type { ConfigService } from '@nestjs/config';
import { BackgroundRuntimeGovernorService } from './background-runtime-governor.service';

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

describe('BackgroundRuntimeGovernorService', () => {
  it('pauses background work during the recovery window before hard degrade', async () => {
    const service = new BackgroundRuntimeGovernorService(
      {
        getSnapshot: jest.fn().mockResolvedValue({
          webhookDefaultWorkerGroups: {},
          userFacingEffectiveLagSec: 0,
          effectiveLagSec: 0,
        }),
      } as never,
      {
        getEffectiveSnapshot: jest.fn().mockResolvedValue({
          mode: 'degrade',
          source: 'auto',
          reason: 'recovery window in progress',
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
      {
        getSourceSnapshot: jest.fn().mockResolvedValue({
          overall: {
            totalRequests: 10,
            trafficClasses: {
              critical: { totalRequests: 1 },
              interactive: { totalRequests: 3 },
              background: { totalRequests: 6 },
            },
          },
          sources: {},
        }),
      } as never,
      createConfigMock(),
      {
        recordBackgroundDecision: jest.fn().mockResolvedValue(undefined),
      } as never,
    );

    await expect(
      service.decide({ component: 'admin-managed-refresh', sourceTag: 'managed_refresh' }),
    ).resolves.toMatchObject({
      action: 'pause',
    });
  });

  it('slows background work when background source share grows too large', async () => {
    const service = new BackgroundRuntimeGovernorService(
      {
        getSnapshot: jest.fn().mockResolvedValue({
          webhookDefaultWorkerGroups: {
            'api-moderation': {
              queues: [],
              counters: { waiting: 1, active: 1, delayed: 0, failed: 0, completed: 0 },
            },
          },
          userFacingEffectiveLagSec: 0,
          effectiveLagSec: 0,
        }),
      } as never,
      {
        getEffectiveSnapshot: jest.fn().mockResolvedValue({
          mode: 'normal',
          source: 'auto',
          reason: 'healthy',
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
      {
        getSourceSnapshot: jest.fn().mockResolvedValue({
          overall: {
            totalRequests: 100,
            trafficClasses: {
              critical: { totalRequests: 5 },
              interactive: { totalRequests: 20 },
              background: { totalRequests: 75 },
            },
          },
          sources: {
            managed_refresh: {
              trafficClasses: {
                background: {
                  totalRequests: 50,
                  avgRps: 0.4,
                  peakRps: 6,
                },
              },
            },
          },
        }),
      } as never,
      createConfigMock({ BACKGROUND_GOVERNOR_BACKGROUND_SHARE_THRESHOLD: 0.4 }),
      {
        recordBackgroundDecision: jest.fn().mockResolvedValue(undefined),
      } as never,
    );

    await expect(
      service.decide({ component: 'channel-stats', sourceTag: 'channel_stats_sync' }),
    ).resolves.toMatchObject({
      action: 'slow',
    });
  });
});
