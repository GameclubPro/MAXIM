import type { ConfigService } from '@nestjs/config';
import { BackgroundRuntimeGovernorService } from './background-runtime-governor.service';

type ConfigValue = boolean | number | string;

type SystemPressureSnapshotForTest = {
  enabled: boolean;
  loadAverage1m: number | null;
  loadRatio1m: number | null;
  cpuCount: number;
  ioWaitRatio: number | null;
  sampleWindowMs: number | null;
  thresholds: {
    loadSlow: number;
    loadPause: number;
    ioWaitSlow: number;
    ioWaitPause: number;
  };
};

function createConfigMock(values: Partial<Record<string, ConfigValue>> = {}): ConfigService {
  return {
    get: jest.fn((key: string, fallback?: unknown) => {
      if (key in values) {
        return values[key];
      }
      return fallback;
    }),
  } as unknown as ConfigService;
}

function mockSystemPressure(
  service: BackgroundRuntimeGovernorService,
  overrides: Partial<SystemPressureSnapshotForTest> = {},
): void {
  jest
    .spyOn(
      service as unknown as {
        buildSystemPressureSnapshot: () => Promise<SystemPressureSnapshotForTest>;
      },
      'buildSystemPressureSnapshot',
    )
    .mockResolvedValue({
      enabled: true,
      loadAverage1m: 1,
      loadRatio1m: 0.1,
      cpuCount: 10,
      ioWaitRatio: 0,
      sampleWindowMs: 1_000,
      thresholds: {
        loadSlow: 0.85,
        loadPause: 1.25,
        ioWaitSlow: 0.15,
        ioWaitPause: 0.35,
      },
      ...overrides,
    });
}

function createStackRateLimitSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    windowSec: 60,
    smoothedLoad: 0,
    peakLoad: 0,
    avgLoad: 0,
    ...overrides,
  };
}

function createDecisionSnapshotForTest() {
  return {
    generatedAt: '2026-07-12T10:00:00.000Z',
    mode: {
      mode: 'normal',
      source: 'auto',
      reason: 'healthy',
      updatedAt: '2026-07-12T10:00:00.000Z',
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
    },
    queues: {
      webhookDefaultWorkerGroups: {},
      userFacingEffectiveLagSec: 0,
      effectiveLagSec: 0,
    },
    backgroundShare: 0,
    systemPressure: {
      enabled: true,
      loadAverage1m: 1,
      loadRatio1m: 0.1,
      cpuCount: 10,
      ioWaitRatio: 0,
      sampleWindowMs: 1_000,
      thresholds: {
        loadSlow: 0.85,
        loadPause: 1.25,
        ioWaitSlow: 0.15,
        ioWaitPause: 0.35,
      },
    },
    stackLoad: {
      windowSec: 60,
      smoothedLoad: 0,
      peakLoad: 0,
      avgLoad: 0,
      slowThreshold: 0.35,
      pauseThreshold: 0.7,
    },
    botLoad: {
      maxSmoothedLoad: 0,
      maxPeakLoad: 0,
      slowThreshold: 0.35,
      pauseThreshold: 0.7,
      topBots: [],
    },
    topSources: [],
    workerSkew: { groupName: null, pressure: 0, totalPressure: 0, share: 0 },
  };
}

describe('BackgroundRuntimeGovernorService', () => {
  it.each([
    {
      label: 'stack-wide MAX capacity',
      pressure: { stackLoad: { smoothedLoad: 0.8, peakLoad: 0.9, avgLoad: 0.7 } },
      reason: 'MAX API stack load 80.0%',
    },
    {
      label: 'per-bot MAX capacity',
      pressure: { botLoad: { maxSmoothedLoad: 0.8, maxPeakLoad: 0.9 } },
      reason: 'MAX API bot load 80.0%',
    },
  ])('allows bounded slow progress under $label pressure', ({ pressure, reason }) => {
    const service = new BackgroundRuntimeGovernorService(
      {} as never,
      {} as never,
      {} as never,
      createConfigMock(),
    );
    const base = createDecisionSnapshotForTest();
    const snapshot = {
      ...base,
      ...(pressure.stackLoad ? { stackLoad: { ...base.stackLoad, ...pressure.stackLoad } } : {}),
      ...(pressure.botLoad ? { botLoad: { ...base.botLoad, ...pressure.botLoad } } : {}),
    };

    expect((service as any).buildDecisionFromSnapshot(snapshot)).toMatchObject({
      action: 'pause',
      reason,
    });
    expect(
      (service as any).buildDecisionFromSnapshot(snapshot, {
        allowMaxApiCapacitySlowPath: true,
      }),
    ).toMatchObject({
      action: 'slow',
      retryAfterMs: 20_000,
      reason,
    });
  });

  it('does not let the MAX capacity slow path bypass mode, queue, or host pressure pauses', () => {
    const service = new BackgroundRuntimeGovernorService(
      {} as never,
      {} as never,
      {} as never,
      createConfigMock(),
    );
    const base = createDecisionSnapshotForTest();
    const options = { allowMaxApiCapacitySlowPath: true };
    const stackLoad = { ...base.stackLoad, smoothedLoad: 0.8 };

    expect(
      (service as any).buildDecisionFromSnapshot(
        {
          ...base,
          mode: { ...base.mode, mode: 'degrade', reason: 'manual maintenance' },
          stackLoad,
        },
        options,
      ),
    ).toMatchObject({ action: 'pause', reason: 'manual maintenance' });
    expect(
      (service as any).buildDecisionFromSnapshot(
        {
          ...base,
          queues: { ...base.queues, userFacingEffectiveLagSec: 12, effectiveLagSec: 12 },
          stackLoad,
        },
        options,
      ),
    ).toMatchObject({ action: 'pause', reason: 'user-facing queue lag 12.0s' });
    expect(
      (service as any).buildDecisionFromSnapshot(
        {
          ...base,
          systemPressure: { ...base.systemPressure, ioWaitRatio: 0.5 },
          stackLoad,
        },
        options,
      ),
    ).toMatchObject({ action: 'pause', reason: 'system iowait 50.0%' });
  });

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
        getStackRateLimitSnapshot: jest.fn().mockResolvedValue(createStackRateLimitSnapshot()),
      } as never,
      createConfigMock(),
      {
        recordBackgroundDecision: jest.fn().mockResolvedValue(undefined),
      } as never,
    );
    mockSystemPressure(service);

    await expect(
      service.decide({ component: 'admin-managed-refresh', sourceTag: 'managed_refresh' }),
    ).resolves.toMatchObject({
      action: 'pause',
    });
  });

  it('lets explicitly user-triggered work run during the recovery window when queue lag is healthy', async () => {
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
        getStackRateLimitSnapshot: jest.fn().mockResolvedValue(createStackRateLimitSnapshot()),
      } as never,
      createConfigMock(),
      {
        recordBackgroundDecision: jest.fn().mockResolvedValue(undefined),
      } as never,
    );
    mockSystemPressure(service);

    await expect(
      service.decide({
        component: 'admin-managed-refresh',
        sourceTag: 'managed_refresh',
        allowRecoveryWindowRun: true,
      }),
    ).resolves.toMatchObject({
      action: 'slow',
    });
  });

  it('downgrades soft queue-lag pauses to slow when an explicit slow-path ceiling is provided', async () => {
    const service = new BackgroundRuntimeGovernorService(
      {
        getSnapshot: jest.fn().mockResolvedValue({
          webhookDefaultWorkerGroups: {},
          userFacingEffectiveLagSec: 12.7,
          effectiveLagSec: 12.7,
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
            totalRequests: 10,
            trafficClasses: {
              critical: { totalRequests: 1 },
              interactive: { totalRequests: 3 },
              background: { totalRequests: 6 },
            },
          },
          sources: {},
        }),
        getStackRateLimitSnapshot: jest.fn().mockResolvedValue(createStackRateLimitSnapshot()),
      } as never,
      createConfigMock(),
      {
        recordBackgroundDecision: jest.fn().mockResolvedValue(undefined),
      } as never,
    );
    mockSystemPressure(service);

    await expect(
      service.decide({
        component: 'admin-managed-refresh',
        sourceTag: 'managed_refresh',
        allowQueueLagSlowPathBelowSec: 30,
      }),
    ).resolves.toMatchObject({
      action: 'slow',
      reason: 'user-facing queue lag 12.7s',
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
        getStackRateLimitSnapshot: jest.fn().mockResolvedValue(createStackRateLimitSnapshot()),
      } as never,
      createConfigMock({ BACKGROUND_GOVERNOR_BACKGROUND_SHARE_THRESHOLD: 0.4 }),
      {
        recordBackgroundDecision: jest.fn().mockResolvedValue(undefined),
      } as never,
    );
    mockSystemPressure(service);

    await expect(
      service.decide({ component: 'channel-stats', sourceTag: 'channel_stats_sync' }),
    ).resolves.toMatchObject({
      action: 'slow',
    });
  });

  it('pauses background work when host iowait crosses the pause threshold', async () => {
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
            totalRequests: 0,
            trafficClasses: {
              critical: { totalRequests: 0 },
              interactive: { totalRequests: 0 },
              background: { totalRequests: 0 },
            },
          },
          sources: {},
        }),
        getStackRateLimitSnapshot: jest.fn().mockResolvedValue(createStackRateLimitSnapshot()),
        getBotRateLimitSnapshot: jest.fn().mockResolvedValue({}),
      } as never,
      createConfigMock({
        BACKGROUND_GOVERNOR_IOWAIT_SLOW_THRESHOLD: 0.15,
        BACKGROUND_GOVERNOR_IOWAIT_PAUSE_THRESHOLD: 0.35,
      }),
      {
        recordBackgroundDecision: jest.fn().mockResolvedValue(undefined),
      } as never,
    );
    mockSystemPressure(service, {
      ioWaitRatio: 0.42,
    });

    await expect(
      service.decide({ component: 'channel-stats', sourceTag: 'channel_stats_sync' }),
    ).resolves.toMatchObject({
      action: 'pause',
      reason: 'system iowait 42.0%',
    });
  });

  it('ignores host pressure when the system pressure guard is disabled', async () => {
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
            totalRequests: 0,
            trafficClasses: {
              critical: { totalRequests: 0 },
              interactive: { totalRequests: 0 },
              background: { totalRequests: 0 },
            },
          },
          sources: {},
        }),
        getStackRateLimitSnapshot: jest.fn().mockResolvedValue(createStackRateLimitSnapshot()),
        getBotRateLimitSnapshot: jest.fn().mockResolvedValue({}),
      } as never,
      createConfigMock({
        BACKGROUND_GOVERNOR_SYSTEM_PRESSURE_ENABLED: false,
      }),
      {
        recordBackgroundDecision: jest.fn().mockResolvedValue(undefined),
      } as never,
    );
    mockSystemPressure(service, {
      enabled: false,
      loadAverage1m: 12,
      loadRatio1m: 2,
      ioWaitRatio: 0.75,
    });

    await expect(
      service.decide({ component: 'channel-stats', sourceTag: 'channel_stats_sync' }),
    ).resolves.toMatchObject({
      action: 'run',
    });
  });

  it('slows background work when stack-wide MAX API load is high across bots', async () => {
    const service = new BackgroundRuntimeGovernorService(
      {
        getSnapshot: jest.fn().mockResolvedValue({
          webhookDefaultWorkerGroups: {},
          userFacingEffectiveLagSec: 0,
          effectiveLagSec: 0,
          bots: {
            'bot-a': {},
            'bot-b': {},
            'bot-c': {},
          },
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
            totalRequests: 0,
            trafficClasses: {
              critical: { totalRequests: 0 },
              interactive: { totalRequests: 0 },
              background: { totalRequests: 0 },
            },
          },
          sources: {},
        }),
        getStackRateLimitSnapshot: jest
          .fn()
          .mockResolvedValue(createStackRateLimitSnapshot({ smoothedLoad: 0.48 })),
        getBotRateLimitSnapshot: jest.fn().mockResolvedValue({
          'bot-a': { smoothedLoad: 0.18, peakLoad: 0.2, avgLoad: 0.05 },
          'bot-b': { smoothedLoad: 0.17, peakLoad: 0.2, avgLoad: 0.05 },
          'bot-c': { smoothedLoad: 0.16, peakLoad: 0.2, avgLoad: 0.05 },
        }),
      } as never,
      createConfigMock({
        BACKGROUND_GOVERNOR_BOT_LOAD_SLOW_THRESHOLD: 0.35,
        BACKGROUND_GOVERNOR_BOT_LOAD_PAUSE_THRESHOLD: 0.7,
      }),
      {
        recordBackgroundDecision: jest.fn().mockResolvedValue(undefined),
      } as never,
    );
    mockSystemPressure(service, { enabled: false });

    await expect(
      service.decide({ component: 'channel-stats', sourceTag: 'channel_stats_sync' }),
    ).resolves.toMatchObject({
      action: 'slow',
      reason: 'MAX API stack load 48.0%',
    });
  });
});
