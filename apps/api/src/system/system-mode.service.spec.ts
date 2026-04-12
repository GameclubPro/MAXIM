import { SystemModeService } from './system-mode.service';

const redisInstances: Array<{
  get: jest.Mock<Promise<string | null>, [string]>;
  set: jest.Mock<Promise<'OK'>, [string, string]>;
  quit: jest.Mock<Promise<void>, []>;
}> = [];

jest.mock('ioredis', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => {
    const instance = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
      quit: jest.fn().mockResolvedValue(undefined),
    };
    redisInstances.push(instance);
    return instance;
  }),
}));

function createConfigMock() {
  return {
    get: jest.fn((key: string, fallback?: number) => {
      if (key === 'QUEUE_LAG_DEGRADE_SEC') {
        return 10;
      }
      if (key === 'DEGRADE_STABILIZE_SEC') {
        return 300;
      }
      return fallback;
    }),
    getOrThrow: jest.fn((key: string) => {
      if (key === 'REDIS_URL') {
        return 'redis://localhost:6379/0';
      }
      throw new Error(`Missing key ${key}`);
    }),
  };
}

describe('SystemModeService', () => {
  const originalRole = process.env.APP_ROLE;

  beforeEach(() => {
    redisInstances.length = 0;
  });

  afterEach(() => {
    process.env.APP_ROLE = originalRole;
    jest.useRealTimers();
  });

  it('persists manual mode changes into the shared Redis snapshot', async () => {
    process.env.APP_ROLE = 'ingress';

    const queueMetricsService = {
      getSnapshot: jest.fn().mockResolvedValue({ effectiveLagSec: 0 }),
    };
    const actionHealthService = {
      refreshSnapshots: jest.fn().mockResolvedValue(undefined),
      getSnapshot: jest.fn().mockReturnValue({
        windowSec: 60,
        total: 10,
        success: 10,
        failure: 0,
        critical: 0,
        errorRate: 0,
        criticalRate: 0,
      }),
    };

    const service = new SystemModeService(
      createConfigMock() as never,
      queueMetricsService as never,
      actionHealthService as never,
    );

    await service.setManualMode('degrade');

    const redis = redisInstances[0];
    expect(redis.set).toHaveBeenCalledWith(
      'system:mode:snapshot:v1',
      expect.stringContaining('"mode":"degrade"'),
    );
    expect(redis.set).toHaveBeenCalledWith(
      'system:mode:snapshot:v1',
      expect.stringContaining('"source":"manual"'),
    );

    await service.onModuleDestroy();
  });

  it('reuses a fresh ingress snapshot without forcing another action refresh', async () => {
    process.env.APP_ROLE = 'ingress';

    const queueMetricsService = {
      getSnapshot: jest.fn().mockResolvedValue({ effectiveLagSec: 0 }),
    };
    const actionHealthService = {
      refreshSnapshots: jest.fn().mockResolvedValue(undefined),
      getSnapshot: jest.fn().mockReturnValue({
        windowSec: 60,
        total: 10,
        success: 10,
        failure: 0,
        critical: 0,
        errorRate: 0,
        criticalRate: 0,
      }),
    };

    const service = new SystemModeService(
      createConfigMock() as never,
      queueMetricsService as never,
      actionHealthService as never,
    );

    await service.setManualMode('degrade');
    actionHealthService.refreshSnapshots.mockClear();

    const snapshot = await service.getEffectiveSnapshot();

    expect(snapshot).toEqual(
      expect.objectContaining({
        mode: 'degrade',
        source: 'manual',
      }),
    );
    expect(actionHealthService.refreshSnapshots).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('loads the shared snapshot for non-http roles', async () => {
    process.env.APP_ROLE = 'moderation';

    const service = new SystemModeService(
      createConfigMock() as never,
      { getSnapshot: jest.fn() } as never,
      {
        refreshSnapshots: jest.fn().mockResolvedValue(undefined),
        getSnapshot: jest.fn().mockReturnValue({
          windowSec: 60,
          total: 0,
          success: 0,
          failure: 0,
          critical: 0,
          errorRate: 0,
          criticalRate: 0,
        }),
      } as never,
    );

    const redis = redisInstances[0];
    redis.get.mockResolvedValue(
      JSON.stringify({
        mode: 'degrade',
        source: 'auto',
        reason: 'queue lag 18.0s',
        updatedAt: '2026-03-24T01:00:00.000Z',
        manualMode: null,
        queueLagSec: 18,
        action: {
          windowSec: 60,
          total: 200,
          success: 192,
          failure: 8,
          critical: 0,
          errorRate: 0.04,
          criticalRate: 0,
        },
      }),
    );

    const snapshot = await service.getEffectiveSnapshot();

    expect(snapshot).toEqual(
      expect.objectContaining({
        mode: 'degrade',
        source: 'auto',
        reason: 'queue lag 18.0s',
        queueLagSec: 18,
      }),
    );

    await service.onModuleDestroy();
  });

  it('loads the shared snapshot for admin role without acting as the ingress leader', async () => {
    process.env.APP_ROLE = 'admin';

    const queueMetricsService = {
      getSnapshot: jest.fn().mockResolvedValue({ effectiveLagSec: 0 }),
    };
    const actionHealthService = {
      refreshSnapshots: jest.fn().mockResolvedValue(undefined),
      getSnapshot: jest.fn().mockReturnValue({
        windowSec: 60,
        total: 12,
        success: 12,
        failure: 0,
        critical: 0,
        errorRate: 0,
        criticalRate: 0,
      }),
    };

    const service = new SystemModeService(
      createConfigMock() as never,
      queueMetricsService as never,
      actionHealthService as never,
    );

    const redis = redisInstances[0];
    redis.get.mockResolvedValue(
      JSON.stringify({
        mode: 'degrade',
        source: 'auto',
        reason: 'queue lag 12.0s',
        updatedAt: '2026-03-29T18:40:24.000Z',
        manualMode: null,
        queueLagSec: 12,
        action: {
          windowSec: 60,
          total: 80,
          success: 78,
          failure: 2,
          critical: 0,
          errorRate: 0.025,
          criticalRate: 0,
        },
      }),
    );

    const snapshot = await service.getEffectiveSnapshot();

    expect(snapshot).toEqual(
      expect.objectContaining({
        mode: 'degrade',
        source: 'auto',
        reason: 'queue lag 12.0s',
      }),
    );

    await service.evaluateAutoMode();

    expect(redis.set).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('does not degrade for action error rate below the minimum sample size', async () => {
    process.env.APP_ROLE = 'ingress';

    const queueMetricsService = {
      getSnapshot: jest.fn().mockResolvedValue({ effectiveLagSec: 0 }),
    };
    const actionHealthService = {
      refreshSnapshots: jest.fn().mockResolvedValue(undefined),
      getSnapshot: jest.fn().mockReturnValue({
        windowSec: 60,
        total: 58,
        success: 52,
        failure: 6,
        critical: 0,
        errorRate: 6 / 58,
        criticalRate: 0,
      }),
    };

    const service = new SystemModeService(
      createConfigMock() as never,
      queueMetricsService as never,
      actionHealthService as never,
    );

    await service.evaluateAutoMode();

    expect(queueMetricsService.getSnapshot).toHaveBeenCalledWith({ maxAgeMs: 15000 });
    expect(service.getSnapshot()).toEqual(
      expect.objectContaining({
        mode: 'normal',
        reason: 'system healthy',
      }),
    );

    await service.onModuleDestroy();
  });

  it('degrades for action error rate once the minimum sample size is reached', async () => {
    process.env.APP_ROLE = 'ingress';

    const queueMetricsService = {
      getSnapshot: jest.fn().mockResolvedValue({ effectiveLagSec: 0 }),
    };
    const actionHealthService = {
      refreshSnapshots: jest.fn().mockResolvedValue(undefined),
      getSnapshot: jest.fn().mockReturnValue({
        windowSec: 60,
        total: 150,
        success: 143,
        failure: 7,
        critical: 0,
        errorRate: 7 / 150,
        criticalRate: 0,
      }),
    };

    const service = new SystemModeService(
      createConfigMock() as never,
      queueMetricsService as never,
      actionHealthService as never,
    );

    await service.evaluateAutoMode();

    expect(service.getSnapshot()).toEqual(
      expect.objectContaining({
        mode: 'degrade',
        reason: expect.stringContaining('action error rate'),
      }),
    );

    await service.onModuleDestroy();
  });

  it('marks the recovery window explicitly while waiting for stabilization', async () => {
    process.env.APP_ROLE = 'ingress';
    jest.useFakeTimers().setSystemTime(new Date('2026-03-29T11:00:00.000Z'));

    const queueMetricsService = {
      getSnapshot: jest
        .fn()
        .mockResolvedValueOnce({ effectiveLagSec: 18 })
        .mockResolvedValue({ effectiveLagSec: 0 }),
    };
    const actionHealthService = {
      refreshSnapshots: jest.fn().mockResolvedValue(undefined),
      getSnapshot: jest.fn().mockReturnValue({
        windowSec: 60,
        total: 10,
        success: 10,
        failure: 0,
        critical: 0,
        errorRate: 0,
        criticalRate: 0,
      }),
    };

    const service = new SystemModeService(
      createConfigMock() as never,
      queueMetricsService as never,
      actionHealthService as never,
    );

    await service.evaluateAutoMode();
    expect(service.getSnapshot()).toEqual(
      expect.objectContaining({
        mode: 'degrade',
        reason: 'user-facing queue lag 18.0s',
      }),
    );

    jest.advanceTimersByTime(5_000);
    await service.evaluateAutoMode();

    expect(service.getSnapshot()).toEqual(
      expect.objectContaining({
        mode: 'degrade',
        reason: 'recovery window in progress',
        queueLagSec: 0,
      }),
    );

    await service.onModuleDestroy();
  });
});
