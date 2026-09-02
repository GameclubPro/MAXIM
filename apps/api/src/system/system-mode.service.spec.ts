import { SystemModeService } from './system-mode.service';

const redisInstances: Array<{
  get: jest.Mock<Promise<string | null>, [string]>;
  set: jest.Mock<Promise<'OK'>, [string, string]>;
  eval: jest.Mock<Promise<unknown>, [string, number, ...string[]]>;
  quit: jest.Mock<Promise<void>, []>;
}> = [];

jest.mock('ioredis', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => {
    const instance = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
      eval: jest
        .fn()
        .mockImplementation(async (_script: string, _keyCount: number, ...args: string[]) => {
          return args.at(-1) ?? null;
        }),
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
      getLagSnapshot: jest.fn().mockResolvedValue({ effectiveLagSec: 0 }),
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

  it('does not overwrite the shared snapshot when a non-ingress role starts', async () => {
    process.env.APP_ROLE = 'admin';

    const actionHealthService = {
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
    };
    const service = new SystemModeService(
      createConfigMock() as never,
      { getLagSnapshot: jest.fn() } as never,
      actionHealthService as never,
    );

    await service.onModuleInit();

    const redis = redisInstances[0];
    expect(redis.get).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
    expect(redis.eval).not.toHaveBeenCalled();
    expect(actionHealthService.refreshSnapshots).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('preserves an admin manual override that races with ingress auto evaluation', async () => {
    const actionSnapshot = {
      windowSec: 60,
      total: 10,
      success: 10,
      failure: 0,
      critical: 0,
      errorRate: 0,
      criticalRate: 0,
    };
    let sharedRaw = JSON.stringify({
      mode: 'normal',
      source: 'auto',
      reason: 'system healthy',
      updatedAt: '2026-07-20T00:00:00.000Z',
      manualMode: null,
      queueLagSec: 0,
      action: actionSnapshot,
    });
    let releaseQueueSnapshot: ((value: { effectiveLagSec: number }) => void) | undefined;
    const queueSnapshotPromise = new Promise<{ effectiveLagSec: number }>((resolve) => {
      releaseQueueSnapshot = resolve;
    });
    const connectToSharedSnapshot = (redis: (typeof redisInstances)[number]) => {
      redis.get.mockImplementation(async () => sharedRaw);
      redis.set.mockImplementation(async (_key, value) => {
        sharedRaw = value;
        return 'OK';
      });
      redis.eval.mockImplementation(async (_script, _keyCount, _key, candidateRaw) => {
        const current = JSON.parse(sharedRaw) as { manualMode?: unknown };
        if (current.manualMode === 'normal' || current.manualMode === 'degrade') {
          return sharedRaw;
        }
        sharedRaw = candidateRaw;
        return candidateRaw;
      });
    };

    process.env.APP_ROLE = 'ingress';
    const ingressQueueMetricsService = {
      getLagSnapshot: jest.fn().mockReturnValue(queueSnapshotPromise),
    };
    const ingress = new SystemModeService(
      createConfigMock() as never,
      ingressQueueMetricsService as never,
      {
        refreshSnapshots: jest.fn().mockResolvedValue(undefined),
        getSnapshot: jest.fn().mockReturnValue(actionSnapshot),
      } as never,
    );
    connectToSharedSnapshot(redisInstances[0]);

    process.env.APP_ROLE = 'admin';
    const admin = new SystemModeService(
      createConfigMock() as never,
      { getLagSnapshot: jest.fn() } as never,
      {
        refreshSnapshots: jest.fn().mockResolvedValue(undefined),
        getSnapshot: jest.fn().mockReturnValue(actionSnapshot),
      } as never,
    );
    connectToSharedSnapshot(redisInstances[1]);

    const autoEvaluation = ingress.evaluateAutoMode();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(ingressQueueMetricsService.getLagSnapshot).toHaveBeenCalled();

    await admin.setManualMode('degrade');
    releaseQueueSnapshot?.({ effectiveLagSec: 0 });
    await autoEvaluation;

    expect(JSON.parse(sharedRaw)).toEqual(
      expect.objectContaining({
        mode: 'degrade',
        source: 'manual',
        manualMode: 'degrade',
      }),
    );
    expect(ingress.getSnapshot()).toEqual(
      expect.objectContaining({
        mode: 'degrade',
        source: 'manual',
        condition: 'manual',
        manualMode: 'degrade',
      }),
    );
    await expect(ingress.getEffectiveSnapshot()).resolves.toEqual(
      expect.objectContaining({
        mode: 'degrade',
        source: 'manual',
        condition: 'manual',
        manualMode: 'degrade',
      }),
    );
    expect(redisInstances[0].eval).toHaveBeenCalledWith(
      expect.stringContaining("current.manualMode == 'degrade'"),
      1,
      'system:mode:snapshot:v1',
      expect.any(String),
    );

    await Promise.all([ingress.onModuleDestroy(), admin.onModuleDestroy()]);
  });

  it('coalesces overlapping evaluations and contains one lightweight lag failure', async () => {
    process.env.APP_ROLE = 'ingress';

    let rejectLagSnapshot: ((error: Error) => void) | null = null;
    const lagSnapshotPromise = new Promise<{ effectiveLagSec: number }>((_resolve, reject) => {
      rejectLagSnapshot = reject;
    });
    const queueMetricsService = {
      getLagSnapshot: jest.fn().mockReturnValue(lagSnapshotPromise),
      getSnapshot: jest.fn(),
    };
    const actionHealthService = {
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
    };
    const service = new SystemModeService(
      createConfigMock() as never,
      queueMetricsService as never,
      actionHealthService as never,
    );
    const warnSpy = jest
      .spyOn(
        (
          service as unknown as {
            logger: { warn: (payload: unknown, message: string) => void };
          }
        ).logger,
        'warn',
      )
      .mockImplementation(() => undefined);

    const firstEvaluation = service.evaluateAutoMode();
    const overlappingEvaluation = service.evaluateAutoMode();

    expect(overlappingEvaluation).toBe(firstEvaluation);
    await Promise.resolve();
    await Promise.resolve();
    expect(queueMetricsService.getLagSnapshot).toHaveBeenCalledTimes(1);
    expect(queueMetricsService.getSnapshot).not.toHaveBeenCalled();

    const failLagSnapshot = rejectLagSnapshot as ((error: Error) => void) | null;
    if (!failLagSnapshot) {
      throw new Error('Expected lightweight lag snapshot rejector');
    }
    failLagSnapshot(new Error('lightweight lag unavailable'));
    await Promise.all([firstEvaluation, overlappingEvaluation]);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      { err: 'lightweight lag unavailable' },
      'Failed to evaluate auto system mode',
    );
    expect(actionHealthService.refreshSnapshots).not.toHaveBeenCalled();

    queueMetricsService.getLagSnapshot.mockResolvedValue({ effectiveLagSec: 0 });
    await service.evaluateAutoMode();
    expect(queueMetricsService.getLagSnapshot).toHaveBeenCalledTimes(2);

    await service.onModuleDestroy();
  });

  it('waits for an active evaluation before closing Redis and rejects new work after destroy', async () => {
    process.env.APP_ROLE = 'ingress';

    let resolveLagSnapshot: ((snapshot: { effectiveLagSec: number }) => void) | null = null;
    const queueMetricsService = {
      getLagSnapshot: jest.fn().mockReturnValue(
        new Promise<{ effectiveLagSec: number }>((resolve) => {
          resolveLagSnapshot = resolve;
        }),
      ),
      getSnapshot: jest.fn(),
    };
    const actionHealthService = {
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
    };
    const service = new SystemModeService(
      createConfigMock() as never,
      queueMetricsService as never,
      actionHealthService as never,
    );
    const redis = redisInstances[0];

    const evaluation = service.evaluateAutoMode();
    await Promise.resolve();
    await Promise.resolve();
    expect(queueMetricsService.getLagSnapshot).toHaveBeenCalledTimes(1);

    const destroyPromise = service.onModuleDestroy();
    await Promise.resolve();
    expect(redis.quit).not.toHaveBeenCalled();

    const finishLagSnapshot = resolveLagSnapshot as
      | ((snapshot: { effectiveLagSec: number }) => void)
      | null;
    if (!finishLagSnapshot) {
      throw new Error('Expected lightweight lag snapshot resolver');
    }
    finishLagSnapshot({ effectiveLagSec: 0 });
    await Promise.all([evaluation, destroyPromise]);

    expect(redis.quit).toHaveBeenCalledTimes(1);
    await service.evaluateAutoMode();
    expect(queueMetricsService.getLagSnapshot).toHaveBeenCalledTimes(1);
    expect(queueMetricsService.getSnapshot).not.toHaveBeenCalled();
  });

  it('bounds shutdown when an active evaluation never settles', async () => {
    jest.useFakeTimers();
    process.env.APP_ROLE = 'ingress';

    const queueMetricsService = {
      getLagSnapshot: jest.fn().mockReturnValue(new Promise(() => undefined)),
      getSnapshot: jest.fn(),
    };
    const actionHealthService = {
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
    };
    const service = new SystemModeService(
      createConfigMock() as never,
      queueMetricsService as never,
      actionHealthService as never,
    );
    const redis = redisInstances[0];
    const warnSpy = jest
      .spyOn(
        (
          service as unknown as {
            logger: { warn: (payload: unknown, message: string) => void };
          }
        ).logger,
        'warn',
      )
      .mockImplementation(() => undefined);

    void service.evaluateAutoMode();
    await Promise.resolve();
    await Promise.resolve();
    expect(queueMetricsService.getLagSnapshot).toHaveBeenCalledTimes(1);

    const destroyPromise = service.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(4_999);
    expect(redis.quit).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    await destroyPromise;

    expect(redis.quit).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      { timeoutMs: 5_000 },
      'Timed out waiting for system mode evaluation during shutdown',
    );
  });

  it('keeps a cached manual override when Redis cannot be read', async () => {
    process.env.APP_ROLE = 'ingress';

    const queueMetricsService = {
      getLagSnapshot: jest.fn().mockResolvedValue({ effectiveLagSec: 0 }),
    };
    const actionSnapshot = {
      windowSec: 60,
      total: 10,
      success: 10,
      failure: 0,
      critical: 0,
      errorRate: 0,
      criticalRate: 0,
    };
    const service = new SystemModeService(
      createConfigMock() as never,
      queueMetricsService as never,
      {
        refreshSnapshots: jest.fn().mockResolvedValue(undefined),
        getSnapshot: jest.fn().mockReturnValue(actionSnapshot),
      } as never,
    );
    const redis = redisInstances[0];
    redis.get
      .mockResolvedValueOnce(
        JSON.stringify({
          mode: 'degrade',
          source: 'manual',
          reason: 'manual override',
          updatedAt: '2026-07-20T00:00:00.000Z',
          manualMode: 'degrade',
          queueLagSec: 0,
          action: actionSnapshot,
        }),
      )
      .mockRejectedValueOnce(new Error('Redis unavailable'));

    await service.evaluateAutoMode();
    await service.evaluateAutoMode();

    expect(queueMetricsService.getLagSnapshot).not.toHaveBeenCalled();
    expect(service.getSnapshot()).toEqual(
      expect.objectContaining({
        mode: 'degrade',
        source: 'manual',
        condition: 'manual',
        manualMode: 'degrade',
      }),
    );

    await service.onModuleDestroy();
  });

  it('reuses a fresh ingress snapshot without forcing another action refresh', async () => {
    process.env.APP_ROLE = 'ingress';

    const queueMetricsService = {
      getLagSnapshot: jest.fn().mockResolvedValue({ effectiveLagSec: 0 }),
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
      { getLagSnapshot: jest.fn() } as never,
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
        condition: 'mixed',
        reason: 'queue lag 18.0s',
        queueLagSec: 18,
      }),
    );

    await service.onModuleDestroy();
  });

  it('loads the shared snapshot for admin role without acting as the ingress leader', async () => {
    process.env.APP_ROLE = 'admin';

    const queueMetricsService = {
      getLagSnapshot: jest.fn().mockResolvedValue({ effectiveLagSec: 0 }),
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
        condition: 'queue_backlog',
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
      getLagSnapshot: jest.fn().mockResolvedValue({ effectiveLagSec: 0 }),
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

    expect(queueMetricsService.getLagSnapshot).toHaveBeenCalledWith({ maxAgeMs: 15000 });
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
      getLagSnapshot: jest.fn().mockResolvedValue({ effectiveLagSec: 0 }),
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
        condition: 'max_api',
        reason: expect.stringContaining('action error rate'),
      }),
    );

    await service.onModuleDestroy();
  });

  it('does not degrade for critical rate below the minimum sample and failure floors', async () => {
    process.env.APP_ROLE = 'ingress';

    const queueMetricsService = {
      getLagSnapshot: jest.fn().mockResolvedValue({ effectiveLagSec: 0 }),
    };
    const actionHealthService = {
      refreshSnapshots: jest.fn().mockResolvedValue(undefined),
      getSnapshot: jest.fn().mockReturnValue({
        windowSec: 60,
        total: 58,
        success: 52,
        failure: 6,
        critical: 6,
        errorRate: 6 / 58,
        criticalRate: 6 / 58,
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
        mode: 'normal',
        reason: 'system healthy',
      }),
    );

    await service.onModuleDestroy();
  });

  it('does not degrade for critical rate below the minimum critical-failure count', async () => {
    process.env.APP_ROLE = 'ingress';

    const queueMetricsService = {
      getLagSnapshot: jest.fn().mockResolvedValue({ effectiveLagSec: 0 }),
    };
    const actionHealthService = {
      refreshSnapshots: jest.fn().mockResolvedValue(undefined),
      getSnapshot: jest.fn().mockReturnValue({
        windowSec: 60,
        total: 150,
        success: 146,
        failure: 4,
        critical: 4,
        errorRate: 4 / 150,
        criticalRate: 4 / 150,
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
        mode: 'normal',
        reason: 'system healthy',
      }),
    );

    await service.onModuleDestroy();
  });

  it('reports critical rate only after the minimum sample and failure floors are reached', async () => {
    process.env.APP_ROLE = 'ingress';

    const queueMetricsService = {
      getLagSnapshot: jest.fn().mockResolvedValue({ effectiveLagSec: 0 }),
    };
    const actionHealthService = {
      refreshSnapshots: jest.fn().mockResolvedValue(undefined),
      getSnapshot: jest.fn().mockReturnValue({
        windowSec: 60,
        total: 150,
        success: 145,
        failure: 5,
        critical: 5,
        errorRate: 5 / 150,
        criticalRate: 5 / 150,
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
        condition: 'max_api',
        reason: expect.stringContaining('critical MAX API rate'),
      }),
    );

    await service.onModuleDestroy();
  });

  it('marks the recovery window explicitly while waiting for stabilization', async () => {
    process.env.APP_ROLE = 'ingress';
    jest.useFakeTimers().setSystemTime(new Date('2026-03-29T11:00:00.000Z'));

    const queueMetricsService = {
      getLagSnapshot: jest
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
        condition: 'queue_backlog',
        reason: 'queue lag 18.0s',
      }),
    );

    jest.advanceTimersByTime(5_000);
    await service.evaluateAutoMode();

    expect(service.getSnapshot()).toEqual(
      expect.objectContaining({
        mode: 'degrade',
        condition: 'stabilizing',
        reason: 'recovery window in progress',
        queueLagSec: 0,
      }),
    );

    await service.onModuleDestroy();
  });
});
