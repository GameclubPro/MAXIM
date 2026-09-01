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
    totalRequests: 0,
    trafficClasses: {
      critical: { totalRequests: 0 },
      interactive: { totalRequests: 0 },
      background: { totalRequests: 0 },
    },
    smoothedLoad: 0,
    peakLoad: 0,
    avgLoad: 0,
    ...overrides,
  };
}

function createCriticalLimiterSnapshot(internalRejects = 0) {
  return { windowSec: 600, internalRejects };
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
    criticalLimiter: null,
    workerSkew: { groupName: null, pressure: 0, totalPressure: 0, share: 0 },
  };
}

describe('BackgroundRuntimeGovernorService', () => {
  it('keeps aggregate and hottest-bot MAX load observational', () => {
    const service = new BackgroundRuntimeGovernorService(
      {} as never,
      {} as never,
      {} as never,
      createConfigMock(),
    );
    const base = createDecisionSnapshotForTest();
    const snapshot = {
      ...base,
      stackLoad: { ...base.stackLoad, smoothedLoad: 0.8, peakLoad: 0.9, avgLoad: 0.7 },
      botLoad: { ...base.botLoad, maxSmoothedLoad: 0.8, maxPeakLoad: 0.9 },
    };

    expect((service as any).buildDecisionFromSnapshot(snapshot)).toMatchObject({
      action: 'run',
      reason: 'background headroom available',
    });
    expect(
      (service as any).buildDecisionFromSnapshot(snapshot, {
        allowMaxApiCapacitySlowPath: true,
      }),
    ).toMatchObject({
      action: 'run',
      reason: 'background headroom available',
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
    const botLoad = { ...base.botLoad, maxSmoothedLoad: 0.8 };

    expect(
      (service as any).buildDecisionFromSnapshot(
        {
          ...base,
          mode: { ...base.mode, mode: 'degrade', reason: 'manual maintenance' },
          botLoad,
        },
        options,
      ),
    ).toMatchObject({ action: 'pause', reason: 'manual maintenance' });
    expect(
      (service as any).buildDecisionFromSnapshot(
        {
          ...base,
          queues: { ...base.queues, userFacingEffectiveLagSec: 12, effectiveLagSec: 12 },
          botLoad,
        },
        options,
      ),
    ).toMatchObject({ action: 'pause', reason: 'user-facing queue lag 12.0s' });
    expect(
      (service as any).buildDecisionFromSnapshot(
        {
          ...base,
          systemPressure: { ...base.systemPressure, ioWaitRatio: 0.5 },
          botLoad,
        },
        options,
      ),
    ).toMatchObject({ action: 'pause', reason: 'system iowait 50.0%' });
  });

  it.each([
    {
      label: 'global background share',
      pressure: { backgroundShare: 0.8 },
      guardedDecision: { action: 'slow', reason: 'background share 80.0%' },
    },
  ])(
    'can ignore only the max_api_traffic domain under $label pressure',
    ({ pressure, guardedDecision }) => {
      const service = new BackgroundRuntimeGovernorService(
        {} as never,
        {} as never,
        {} as never,
        createConfigMock(),
      );
      const base = createDecisionSnapshotForTest();
      const snapshot = {
        ...base,
        backgroundShare: pressure.backgroundShare,
      };

      expect((service as any).buildDecisionFromSnapshot(snapshot)).toMatchObject(guardedDecision);
      expect(
        (service as any).buildDecisionFromSnapshot(snapshot, {
          ignoredPressureDomains: ['max_api_traffic'],
        }),
      ).toMatchObject({ action: 'run', reason: 'background headroom available' });
    },
  );

  it.each([
    {
      label: 'hard degrade',
      pressure: { mode: { mode: 'degrade', reason: 'manual maintenance' } },
      options: {},
      decision: { action: 'pause', reason: 'manual maintenance' },
    },
    {
      label: 'degrade recovery window',
      pressure: { mode: { mode: 'degrade', reason: 'recovery window in progress' } },
      options: {},
      decision: { action: 'pause', reason: 'recovery window in progress' },
    },
    {
      label: 'queue lag pause',
      pressure: {
        queues: { userFacingEffectiveLagSec: 12, effectiveLagSec: 12 },
      },
      options: {},
      decision: { action: 'pause', reason: 'user-facing queue lag 12.0s' },
    },
    {
      label: 'queue lag slow path',
      pressure: {
        queues: { userFacingEffectiveLagSec: 12, effectiveLagSec: 12 },
      },
      options: { allowQueueLagSlowPathBelowSec: 30 },
      decision: { action: 'slow', reason: 'user-facing queue lag 12.0s' },
    },
    {
      label: 'host load slow pressure',
      pressure: { systemPressure: { loadRatio1m: 0.9 } },
      options: {},
      decision: { action: 'slow', reason: 'system load 90.0% of 10 CPUs' },
    },
    {
      label: 'host load pause pressure',
      pressure: { systemPressure: { loadRatio1m: 1.3 } },
      options: {},
      decision: { action: 'pause', reason: 'system load 130.0% of 10 CPUs' },
    },
    {
      label: 'host iowait slow pressure',
      pressure: { systemPressure: { ioWaitRatio: 0.2 } },
      options: {},
      decision: { action: 'slow', reason: 'system iowait 20.0%' },
    },
    {
      label: 'host iowait pause pressure',
      pressure: { systemPressure: { ioWaitRatio: 0.5 } },
      options: {},
      decision: { action: 'pause', reason: 'system iowait 50.0%' },
    },
    {
      label: 'worker skew',
      pressure: {
        workerSkew: { groupName: 'api-moderation', pressure: 7, totalPressure: 8, share: 0.875 },
      },
      options: {},
      decision: { action: 'slow', reason: 'default worker skew api-moderation 7/8' },
    },
  ])('does not let ignored max_api_traffic bypass $label', ({ pressure, options, decision }) => {
    const service = new BackgroundRuntimeGovernorService(
      {} as never,
      {} as never,
      {} as never,
      createConfigMock(),
    );
    const base = createDecisionSnapshotForTest();
    const snapshot = {
      ...base,
      ...(pressure.mode ? { mode: { ...base.mode, ...pressure.mode } } : {}),
      ...(pressure.queues ? { queues: { ...base.queues, ...pressure.queues } } : {}),
      ...(pressure.systemPressure
        ? { systemPressure: { ...base.systemPressure, ...pressure.systemPressure } }
        : {}),
      ...(pressure.workerSkew
        ? { workerSkew: { ...base.workerSkew, ...pressure.workerSkew } }
        : {}),
      stackLoad: { ...base.stackLoad, smoothedLoad: 0.8 },
      botLoad: { ...base.botLoad, maxSmoothedLoad: 0.8 },
      backgroundShare: 0.8,
    };

    expect(
      (service as any).buildDecisionFromSnapshot(snapshot, {
        ...options,
        ignoredPressureDomains: ['max_api_traffic'],
      }),
    ).toMatchObject(decision);
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
        getSourceTrafficSnapshot: jest.fn().mockResolvedValue({
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
        getStackCriticalLimiterSnapshot: jest
          .fn()
          .mockResolvedValue(createCriticalLimiterSnapshot()),
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
        getSourceTrafficSnapshot: jest.fn().mockResolvedValue({
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
        getStackRateLimitSnapshot: jest.fn().mockResolvedValue(
          createStackRateLimitSnapshot({
            totalRequests: 10,
            trafficClasses: {
              critical: { totalRequests: 1 },
              interactive: { totalRequests: 3 },
              background: { totalRequests: 6 },
            },
          }),
        ),
        getStackCriticalLimiterSnapshot: jest
          .fn()
          .mockResolvedValue(createCriticalLimiterSnapshot()),
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
        getSourceTrafficSnapshot: jest.fn().mockResolvedValue({
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
        getStackCriticalLimiterSnapshot: jest
          .fn()
          .mockResolvedValue(createCriticalLimiterSnapshot()),
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

  it('slows background work from bounded shared stack background share', async () => {
    const getSourceTrafficSnapshot = jest.fn();
    const getStackRateLimitSnapshot = jest
      .fn()
      .mockImplementation((options: { capacityScope?: 'shared' | 'service' }) =>
        Promise.resolve(
          options.capacityScope === 'shared'
            ? createStackRateLimitSnapshot({
                totalRequests: 100,
                trafficClasses: {
                  critical: { totalRequests: 5 },
                  interactive: { totalRequests: 20 },
                  background: { totalRequests: 75 },
                },
              })
            : createStackRateLimitSnapshot(),
        ),
      );
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
        getSourceTrafficSnapshot,
        getStackRateLimitSnapshot,
        getStackCriticalLimiterSnapshot: jest
          .fn()
          .mockResolvedValue(createCriticalLimiterSnapshot()),
      } as never,
      createConfigMock({
        BACKGROUND_GOVERNOR_SOURCE_WINDOW_SEC: 300,
        BACKGROUND_GOVERNOR_BACKGROUND_SHARE_THRESHOLD: 0.4,
      }),
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
    expect(getSourceTrafficSnapshot).not.toHaveBeenCalled();
    expect(getStackRateLimitSnapshot).toHaveBeenNthCalledWith(1, {
      windowSec: 300,
      capacityScope: 'shared',
    });
    expect(getStackRateLimitSnapshot).toHaveBeenNthCalledWith(2, {
      windowSec: 60,
      capacityScope: 'service',
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
        getSourceTrafficSnapshot: jest.fn().mockResolvedValue({
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
        getStackCriticalLimiterSnapshot: jest
          .fn()
          .mockResolvedValue(createCriticalLimiterSnapshot()),
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
        getSourceTrafficSnapshot: jest.fn().mockResolvedValue({
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
        getStackCriticalLimiterSnapshot: jest
          .fn()
          .mockResolvedValue(createCriticalLimiterSnapshot()),
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

  it('keeps aggregate stack and hottest-bot load observational at runtime', async () => {
    const getSourceTrafficSnapshot = jest.fn();
    const getStackRateLimitSnapshot = jest
      .fn()
      .mockResolvedValue(createStackRateLimitSnapshot({ smoothedLoad: 0.48 }));
    const getBotRateLimitSnapshot = jest.fn().mockResolvedValue({
      'bot-a': { smoothedLoad: 0.8, peakLoad: 0.9, avgLoad: 0.7 },
      'bot-b': { smoothedLoad: 0.17, peakLoad: 0.2, avgLoad: 0.05 },
      'bot-c': { smoothedLoad: 0.16, peakLoad: 0.2, avgLoad: 0.05 },
    });
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
        getSourceTrafficSnapshot,
        getStackRateLimitSnapshot,
        getStackCriticalLimiterSnapshot: jest
          .fn()
          .mockResolvedValue(createCriticalLimiterSnapshot()),
        getBotRateLimitSnapshot,
      } as never,
      createConfigMock({
        BACKGROUND_GOVERNOR_SOURCE_WINDOW_SEC: 60,
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
      action: 'run',
      reason: 'background headroom available',
    });
    await expect(
      service.decide({
        component: 'commercial-image-ocr',
        sourceTag: 'commercial_image_ocr',
        ignoredPressureDomains: ['max_api_traffic'],
      }),
    ).resolves.toMatchObject({
      action: 'run',
      reason: 'background headroom available',
    });
    expect(getStackRateLimitSnapshot).toHaveBeenCalledWith({
      windowSec: 60,
      capacityScope: 'shared',
    });
    expect(getStackRateLimitSnapshot).toHaveBeenCalledWith({
      windowSec: 60,
      capacityScope: 'service',
    });
    expect(getStackRateLimitSnapshot).toHaveBeenCalledTimes(2);
    expect(getSourceTrafficSnapshot).not.toHaveBeenCalled();
    expect(getBotRateLimitSnapshot).toHaveBeenCalledWith(['bot-a', 'bot-b', 'bot-c'], {
      windowSec: 60,
      capacityScope: 'service',
    });
  });

  it('reports service class capacity and shared per-bot capacity on the dashboard', async () => {
    const getSourceSnapshot = jest.fn();
    const getSourceTrafficSnapshot = jest.fn().mockResolvedValue({
      overall: {
        totalRequests: 10,
        trafficClasses: {
          critical: { totalRequests: 1 },
          interactive: { totalRequests: 3 },
          background: { totalRequests: 6 },
        },
      },
      sources: {
        managed_refresh: {
          trafficClasses: {
            background: {
              totalRequests: 6,
              avgRps: 0.1,
              peakRps: 2,
            },
          },
        },
      },
    });
    const getRateLimitOutcomeSnapshot = jest.fn().mockResolvedValue({
      windowSec: 600,
      stack: {
        trafficClasses: {
          critical: { internalLimiterRejects: 4 },
        },
      },
    });
    const getStackRateLimitSnapshot = jest
      .fn()
      .mockImplementation((options: { capacityScope?: 'shared' | 'service' }) =>
        Promise.resolve(
          options.capacityScope === 'shared'
            ? createStackRateLimitSnapshot({
                totalRequests: 10,
                trafficClasses: {
                  critical: { totalRequests: 1 },
                  interactive: { totalRequests: 3 },
                  background: { totalRequests: 6 },
                },
              })
            : createStackRateLimitSnapshot({ smoothedLoad: 0.48 }),
        ),
      );
    const getStackCriticalLimiterSnapshot = jest
      .fn()
      .mockResolvedValueOnce({ windowSec: 60, internalRejects: 1 })
      .mockResolvedValueOnce(createCriticalLimiterSnapshot(4));
    const getBotRateLimitSnapshot = jest
      .fn()
      .mockResolvedValueOnce({
        'bot-a': { smoothedLoad: 0.4, peakLoad: 0.5, avgLoad: 0.2 },
      })
      .mockResolvedValue({
        'bot-a': { smoothedLoad: 0.1, peakLoad: 0.2, avgLoad: 0.05 },
      });
    const service = new BackgroundRuntimeGovernorService(
      {
        getSnapshot: jest.fn().mockResolvedValue({
          webhookDefaultWorkerGroups: {},
          userFacingEffectiveLagSec: 0,
          effectiveLagSec: 0,
          bots: { 'bot-a': {} },
        }),
      } as never,
      {
        getEffectiveSnapshot: jest.fn().mockResolvedValue(createDecisionSnapshotForTest().mode),
      } as never,
      {
        getSourceSnapshot,
        getSourceTrafficSnapshot,
        getRateLimitOutcomeSnapshot,
        getStackRateLimitSnapshot,
        getStackCriticalLimiterSnapshot,
        getBotRateLimitSnapshot,
      } as never,
      createConfigMock({ BACKGROUND_GOVERNOR_SOURCE_WINDOW_SEC: 60 }),
      {
        getBackgroundDecisionSummary: jest.fn().mockResolvedValue({ pauseReasons: [] }),
      } as never,
    );
    mockSystemPressure(service, { enabled: false });

    const [firstDashboard, secondDashboard] = await Promise.all([
      service.getDashboardBudgetSummary(),
      service.getDashboardBudgetSummary(),
    ]);
    expect(firstDashboard).toMatchObject({
      backgroundShare: 0.6,
      topSources: [
        {
          sourceTag: 'managed_refresh',
          totalRequests: 6,
          avgRps: 0.1,
          peakRps: 2,
        },
      ],
      stackLoad: { smoothedLoad: 0.48 },
      botLoad: {
        maxSmoothedLoad: 0.1,
        topBots: [expect.objectContaining({ botId: 'bot-a', smoothedLoad: 0.1 })],
      },
    });
    expect(secondDashboard).toMatchObject({
      backgroundShare: 0.6,
      topSources: [expect.objectContaining({ sourceTag: 'managed_refresh', totalRequests: 6 })],
    });
    await expect(service.getDashboardBudgetSummary()).resolves.toMatchObject({
      backgroundShare: 0.6,
      topSources: [expect.objectContaining({ sourceTag: 'managed_refresh', totalRequests: 6 })],
    });
    await expect(service.getCriticalLimiterSnapshot()).resolves.toEqual({
      windowSec: 600,
      internalRejects: 4,
    });
    await expect(service.getCriticalLimiterSnapshot()).resolves.toEqual({
      windowSec: 600,
      internalRejects: 4,
    });
    expect(getSourceTrafficSnapshot).toHaveBeenCalledWith({ windowSec: 60 });
    expect(getSourceTrafficSnapshot).toHaveBeenCalledTimes(1);
    expect(getSourceSnapshot).not.toHaveBeenCalled();
    expect(getStackCriticalLimiterSnapshot).toHaveBeenCalledTimes(2);
    expect(getStackCriticalLimiterSnapshot).toHaveBeenNthCalledWith(1, { windowSec: 600 });
    expect(getStackCriticalLimiterSnapshot).toHaveBeenNthCalledWith(2, { windowSec: 600 });
    expect(getRateLimitOutcomeSnapshot).not.toHaveBeenCalled();
    expect(getStackRateLimitSnapshot).toHaveBeenNthCalledWith(1, {
      windowSec: 60,
      capacityScope: 'shared',
    });
    expect(getStackRateLimitSnapshot).toHaveBeenNthCalledWith(2, {
      windowSec: 60,
      capacityScope: 'service',
    });
    expect(getStackRateLimitSnapshot).toHaveBeenCalledTimes(2);
    expect(getBotRateLimitSnapshot).toHaveBeenNthCalledWith(1, ['bot-a'], {
      windowSec: 60,
      capacityScope: 'service',
    });
    expect(getBotRateLimitSnapshot).toHaveBeenNthCalledWith(2, ['bot-a'], { windowSec: 60 });
    expect(getBotRateLimitSnapshot).toHaveBeenNthCalledWith(3, ['bot-a'], { windowSec: 60 });
    expect(getBotRateLimitSnapshot).toHaveBeenNthCalledWith(4, ['bot-a'], { windowSec: 60 });
  });

  it('reuses the direct critical limiter snapshot for the default alert window', async () => {
    const getRateLimitOutcomeSnapshot = jest.fn();
    const service = new BackgroundRuntimeGovernorService(
      {
        getSnapshot: jest.fn().mockResolvedValue({
          webhookDefaultWorkerGroups: {},
          userFacingEffectiveLagSec: 0,
          effectiveLagSec: 0,
          bots: {},
        }),
      } as never,
      {
        getEffectiveSnapshot: jest.fn().mockResolvedValue(createDecisionSnapshotForTest().mode),
      } as never,
      {
        getSourceTrafficSnapshot: jest.fn().mockResolvedValue({
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
        getRateLimitOutcomeSnapshot,
        getStackRateLimitSnapshot: jest.fn().mockResolvedValue(createStackRateLimitSnapshot()),
        getStackCriticalLimiterSnapshot: jest
          .fn()
          .mockResolvedValue(createCriticalLimiterSnapshot(7)),
        getBotRateLimitSnapshot: jest.fn().mockResolvedValue({}),
      } as never,
      createConfigMock(),
    );
    mockSystemPressure(service, { enabled: false });

    await expect(service.getCriticalLimiterSnapshot()).resolves.toEqual({
      windowSec: 600,
      internalRejects: 7,
    });
    expect(getRateLimitOutcomeSnapshot).not.toHaveBeenCalled();
  });
});
