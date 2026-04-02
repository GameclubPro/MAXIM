import { HealthService } from './health.service';

const redisInstances: Array<{
  ping: jest.Mock<Promise<string>, []>;
  quit: jest.Mock<Promise<void>, []>;
}> = [];

jest.mock('ioredis', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => {
    const instance = {
      ping: jest.fn().mockResolvedValue('PONG'),
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
      if (key === 'READY_QUEUE_LAG_SUSTAIN_SEC') {
        return 20;
      }
      if (key === 'READY_QUEUE_LAG_SEVERE_SEC') {
        return 30;
      }
      if (key === 'READINESS_QUEUE_SNAPSHOT_MAX_AGE_MS') {
        return 2000;
      }
      if (key === 'READINESS_BUILD_TIMEOUT_MS') {
        return 50;
      }
      if (key === 'READINESS_DEPENDENCY_TIMEOUT_MS') {
        return 25;
      }
      if (key === 'READINESS_STALE_FALLBACK_MAX_AGE_MS') {
        return 30000;
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

describe('HealthService', () => {
  beforeEach(() => {
    redisInstances.length = 0;
  });

  it('returns a cached readiness snapshot and keeps queue-derived fields consistent', async () => {
    const prisma = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
    };
    const queueMetricsService = {
      getSnapshot: jest.fn().mockResolvedValue({
        moderation: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
        webhookCritical: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
        webhookDefault: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
        webhookBackground: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
        webhookLegacy: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
        actions: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
        webhookEvents: {
          received: {
            count: 0,
            oldestEventId: null,
            oldestCreatedAt: null,
            oldestLagSec: 0,
          },
          queued: {
            count: 0,
            oldestEventId: null,
            oldestCreatedAt: null,
            oldestLagSec: 0,
          },
          failed: {
            count: 0,
            oldestEventId: null,
            oldestCreatedAt: null,
            oldestLagSec: 0,
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
        oldestQueuedEventId: 'queued-1',
        oldestQueuedCreatedAt: '2026-03-29T10:00:00.000Z',
        oldestQueuedLagSec: 1.5,
        oldestReceivedEventId: 'received-1',
        oldestReceivedCreatedAt: '2026-03-29T10:00:01.000Z',
        oldestReceivedLagSec: 0.9,
        effectiveLagSec: 1.5,
        generatedAt: '2026-03-29T10:00:02.000Z',
      }),
    };
    const systemModeService = {
      getEffectiveSnapshot: jest.fn().mockResolvedValue({
        mode: 'degrade',
        source: 'auto',
        reason: 'queue lag 18.0s',
        updatedAt: '2026-03-29T09:59:59.000Z',
        manualMode: null,
        queueLagSec: 18,
        action: {
          windowSec: 60,
          total: 200,
          success: 192,
          failure: 8,
          critical: 2,
          errorRate: 0.04,
          criticalRate: 0.01,
        },
      }),
    };

    const service = new HealthService(
      prisma as never,
      queueMetricsService as never,
      systemModeService as never,
      createConfigMock() as never,
    );

    const first = await service.ready();
    const second = await service.ready();

    expect(first).toBe(second);
    expect(queueMetricsService.getSnapshot).toHaveBeenCalledTimes(1);
    expect(queueMetricsService.getSnapshot).toHaveBeenCalledWith({ maxAgeMs: 2000 });
    expect(systemModeService.getEffectiveSnapshot).toHaveBeenCalledTimes(1);
    expect(prisma.$queryRawUnsafe).toHaveBeenCalledTimes(1);
    expect(redisInstances[0]?.ping).toHaveBeenCalledTimes(1);
    expect(first.systemMode).toEqual(
      expect.objectContaining({
        mode: 'degrade',
        queueLagSec: 1.5,
        degraded: true,
        action: {
          windowSec: 60,
          total: 200,
          success: 192,
          failure: 8,
          critical: 2,
          errorRate: 0.04,
          criticalRate: 0.01,
        },
      }),
    );
    expect(first.checks.queueLag).toEqual(
      expect.objectContaining({
        ok: true,
        rawOk: true,
        softWarning: false,
        softWarningCode: null,
        softWarningDetail: null,
        thresholdSec: 10,
        sustainSec: 20,
        severeThresholdSec: 30,
        sampleGeneratedAt: '2026-03-29T10:00:02.000Z',
        breachStartedAt: null,
        breachDurationSec: 0,
      }),
    );

    await service.onModuleDestroy();
  });

  it('serves a stale readiness snapshot when the live build exceeds the timeout budget', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-03-31T09:00:00.000Z'));

    const queueMetricsSnapshot = {
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
        total: 4,
        success: 4,
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
      generatedAt: '2026-03-31T09:00:00.000Z',
      bots: {},
      userFacingWebhookEvents: {
        received: { count: 0, oldestEventId: null, oldestCreatedAt: null, oldestLagSec: 0 },
        queued: { count: 0, oldestEventId: null, oldestCreatedAt: null, oldestLagSec: 0 },
        failed: { count: 0, oldestEventId: null, oldestCreatedAt: null, oldestLagSec: 0 },
      },
      userFacingOldestQueuedEventId: null,
      userFacingOldestQueuedCreatedAt: null,
      userFacingOldestQueuedLagSec: 0,
      userFacingOldestReceivedEventId: null,
      userFacingOldestReceivedCreatedAt: null,
      userFacingOldestReceivedLagSec: 0,
      userFacingEffectiveLagSec: 0,
    };
    const systemModeSnapshot = {
      mode: 'normal',
      source: 'auto',
      reason: 'system healthy',
      updatedAt: '2026-03-31T09:00:00.000Z',
      manualMode: null,
      queueLagSec: 0,
      action: {
        windowSec: 60,
        total: 4,
        success: 4,
        failure: 0,
        critical: 0,
        errorRate: 0,
        criticalRate: 0,
      },
    };
    const prisma = {
      $queryRawUnsafe: jest
        .fn()
        .mockResolvedValueOnce([{ '?column?': 1 }])
        .mockResolvedValueOnce([{ '?column?': 1 }]),
    };
    const queueMetricsService = {
      getSnapshot: jest
        .fn()
        .mockResolvedValueOnce(queueMetricsSnapshot)
        .mockImplementationOnce(() => new Promise(() => undefined)),
    };
    const systemModeService = {
      getEffectiveSnapshot: jest
        .fn()
        .mockResolvedValueOnce(systemModeSnapshot)
        .mockImplementationOnce(() => new Promise(() => undefined)),
      peekCachedSnapshot: jest.fn().mockReturnValue(systemModeSnapshot),
    };

    const service = new HealthService(
      prisma as never,
      queueMetricsService as never,
      systemModeService as never,
      createConfigMock() as never,
    );

    const first = await service.ready();
    expect(first.ok).toBe(true);

    jest.advanceTimersByTime(2_001);

    const secondPromise = service.ready();
    jest.advanceTimersByTime(60);
    const second = await secondPromise;

    expect(second.ok).toBe(true);
    expect(second.checks.queueLag).toEqual(
      expect.objectContaining({
        softWarning: true,
        softWarningCode: 'stale-ready-fallback',
      }),
    );
    expect(second.checks.queueLag.softWarningDetail).toContain(
      'live readiness evaluation did not finish in 50ms',
    );

    await service.onModuleDestroy();
  });

  it('keeps readiness green when queue metrics detail times out but system mode stays available', async () => {
    jest.useFakeTimers();
    const prisma = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
    };
    const queueMetricsService = {
      getSnapshot: jest.fn().mockImplementation(() => new Promise(() => undefined)),
    };
    const systemModeSnapshot = {
      mode: 'normal',
      source: 'auto',
      reason: 'system healthy',
      updatedAt: '2026-03-31T09:10:00.000Z',
      manualMode: null,
      queueLagSec: 0,
      action: {
        windowSec: 60,
        total: 4,
        success: 4,
        failure: 0,
        critical: 0,
        errorRate: 0,
        criticalRate: 0,
      },
    };
    const systemModeService = {
      getEffectiveSnapshot: jest.fn().mockResolvedValue(systemModeSnapshot),
      peekCachedSnapshot: jest.fn().mockReturnValue(systemModeSnapshot),
    };

    const service = new HealthService(
      prisma as never,
      queueMetricsService as never,
      systemModeService as never,
      createConfigMock() as never,
    );

    const snapshotPromise = service.ready();
    await jest.advanceTimersByTimeAsync(30);
    const snapshot = await snapshotPromise;

    expect(snapshot.ok).toBe(true);
    expect(snapshot.checks.database).toBe(true);
    expect(snapshot.checks.redis).toBe(true);
    expect(snapshot.checks.queueLag).toEqual(
      expect.objectContaining({
        ok: true,
        rawOk: true,
        softWarning: true,
        softWarningCode: 'stale-ready-fallback',
        sampleGeneratedAt: '2026-03-31T09:10:00.000Z',
      }),
    );
    expect(snapshot.checks.queueLag.softWarningDetail).toContain(
      'Queue metrics detail is temporarily stale',
    );
    expect(snapshot.bots).toEqual({});

    await service.onModuleDestroy();
  });

  it('preserves per-bot readiness detail from cached queue metrics during stale fallback', async () => {
    jest.useFakeTimers();
    const prisma = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
    };
    const cachedQueueSnapshot = {
      bots: {
        id613002203036_bot: {
          webhookEvents: {
            received: { count: 10, oldestEventId: null, oldestCreatedAt: null, oldestLagSec: 0 },
            queued: { count: 1, oldestEventId: null, oldestCreatedAt: null, oldestLagSec: 0 },
            failed: { count: 0, oldestEventId: null, oldestCreatedAt: null, oldestLagSec: 0 },
          },
          userFacingWebhookEvents: {
            received: { count: 5, oldestEventId: null, oldestCreatedAt: null, oldestLagSec: 0 },
            queued: { count: 0, oldestEventId: null, oldestCreatedAt: null, oldestLagSec: 0 },
            failed: { count: 0, oldestEventId: null, oldestCreatedAt: null, oldestLagSec: 0 },
          },
          queuedByQueue: {
            'moderation-default-0': 1,
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
          effectiveLagSec: 1,
          userFacingOldestQueuedEventId: null,
          userFacingOldestQueuedCreatedAt: null,
          userFacingOldestQueuedLagSec: 0,
          userFacingOldestReceivedEventId: null,
          userFacingOldestReceivedCreatedAt: null,
          userFacingOldestReceivedLagSec: 0,
          userFacingEffectiveLagSec: 0,
        },
      },
    };
    const queueMetricsService = {
      getSnapshot: jest.fn().mockImplementation(() => new Promise(() => undefined)),
      peekCachedSnapshot: jest.fn().mockReturnValue(cachedQueueSnapshot),
    };
    const systemModeSnapshot = {
      mode: 'normal',
      source: 'auto',
      reason: 'system healthy',
      updatedAt: '2026-03-31T09:11:00.000Z',
      manualMode: null,
      queueLagSec: 1,
      action: {
        windowSec: 60,
        total: 12,
        success: 12,
        failure: 0,
        critical: 0,
        errorRate: 0,
        criticalRate: 0,
      },
    };
    const systemModeService = {
      getEffectiveSnapshot: jest.fn().mockResolvedValue(systemModeSnapshot),
      peekCachedSnapshot: jest.fn().mockReturnValue(systemModeSnapshot),
    };

    const service = new HealthService(
      prisma as never,
      queueMetricsService as never,
      systemModeService as never,
      createConfigMock() as never,
    );

    const snapshotPromise = service.ready();
    await jest.advanceTimersByTimeAsync(30);
    const snapshot = await snapshotPromise;

    expect(snapshot.ok).toBe(true);
    expect(snapshot.bots).toEqual({
      id613002203036_bot: {
        queueLagSec: 0,
        rawOk: true,
        queuedEvents: 0,
        receivedEvents: 5,
        failedEvents: 0,
        action: {
          windowSec: 60,
          total: 12,
          success: 12,
          failure: 0,
          critical: 0,
          errorRate: 0,
          criticalRate: 0,
        },
      },
    });

    await service.onModuleDestroy();
  });

  it('serves a recent stale queue snapshot immediately and refreshes metrics in the background', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-03-31T09:12:10.000Z'));

    const prisma = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
    };
    const staleQueueSnapshot = {
      moderation: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
      webhookCritical: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
      webhookDefault: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
      webhookBackground: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
      webhookLegacy: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
      actions: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
      webhookEvents: {
        received: { count: 2, oldestEventId: null, oldestCreatedAt: null, oldestLagSec: 0 },
        queued: { count: 1, oldestEventId: null, oldestCreatedAt: null, oldestLagSec: 0 },
        failed: { count: 0, oldestEventId: null, oldestCreatedAt: null, oldestLagSec: 0 },
      },
      userFacingWebhookEvents: {
        received: { count: 1, oldestEventId: null, oldestCreatedAt: null, oldestLagSec: 0 },
        queued: { count: 1, oldestEventId: null, oldestCreatedAt: null, oldestLagSec: 0 },
        failed: { count: 0, oldestEventId: null, oldestCreatedAt: null, oldestLagSec: 0 },
      },
      actionHealth: {
        windowSec: 60,
        total: 5,
        success: 5,
        failure: 0,
        critical: 0,
        errorRate: 0,
        criticalRate: 0,
      },
      oldestQueuedEventId: 'queued-1',
      oldestQueuedCreatedAt: '2026-03-31T09:12:03.000Z',
      oldestQueuedLagSec: 2,
      oldestReceivedEventId: 'received-1',
      oldestReceivedCreatedAt: '2026-03-31T09:12:04.000Z',
      oldestReceivedLagSec: 1,
      effectiveLagSec: 2,
      userFacingOldestQueuedEventId: 'queued-1',
      userFacingOldestQueuedCreatedAt: '2026-03-31T09:12:03.000Z',
      userFacingOldestQueuedLagSec: 2,
      userFacingOldestReceivedEventId: 'received-1',
      userFacingOldestReceivedCreatedAt: '2026-03-31T09:12:04.000Z',
      userFacingOldestReceivedLagSec: 1,
      userFacingEffectiveLagSec: 2,
      generatedAt: '2026-03-31T09:12:05.000Z',
      bots: {
        id613002203036_bot: {
          webhookEvents: {
            received: { count: 2, oldestEventId: null, oldestCreatedAt: null, oldestLagSec: 0 },
            queued: { count: 1, oldestEventId: null, oldestCreatedAt: null, oldestLagSec: 0 },
            failed: { count: 0, oldestEventId: null, oldestCreatedAt: null, oldestLagSec: 0 },
          },
          userFacingWebhookEvents: {
            received: { count: 1, oldestEventId: null, oldestCreatedAt: null, oldestLagSec: 0 },
            queued: { count: 1, oldestEventId: null, oldestCreatedAt: null, oldestLagSec: 0 },
            failed: { count: 0, oldestEventId: null, oldestCreatedAt: null, oldestLagSec: 0 },
          },
          queuedByQueue: {},
          actionHealth: {
            windowSec: 60,
            total: 5,
            success: 5,
            failure: 0,
            critical: 0,
            errorRate: 0,
            criticalRate: 0,
          },
          oldestQueuedEventId: 'queued-1',
          oldestQueuedCreatedAt: '2026-03-31T09:12:03.000Z',
          oldestQueuedLagSec: 2,
          oldestReceivedEventId: 'received-1',
          oldestReceivedCreatedAt: '2026-03-31T09:12:04.000Z',
          oldestReceivedLagSec: 1,
          effectiveLagSec: 2,
          userFacingOldestQueuedEventId: 'queued-1',
          userFacingOldestQueuedCreatedAt: '2026-03-31T09:12:03.000Z',
          userFacingOldestQueuedLagSec: 2,
          userFacingOldestReceivedEventId: 'received-1',
          userFacingOldestReceivedCreatedAt: '2026-03-31T09:12:04.000Z',
          userFacingOldestReceivedLagSec: 1,
          userFacingEffectiveLagSec: 2,
        },
      },
    };
    const queueMetricsService = {
      getSnapshot: jest.fn().mockResolvedValue(staleQueueSnapshot),
      peekCachedSnapshot: jest.fn().mockReturnValue(staleQueueSnapshot),
    };
    const systemModeSnapshot = {
      mode: 'normal',
      source: 'auto',
      reason: 'system healthy',
      updatedAt: '2026-03-31T09:12:10.000Z',
      manualMode: null,
      queueLagSec: 0,
      action: {
        windowSec: 60,
        total: 5,
        success: 5,
        failure: 0,
        critical: 0,
        errorRate: 0,
        criticalRate: 0,
      },
    };
    const systemModeService = {
      getEffectiveSnapshot: jest.fn().mockResolvedValue(systemModeSnapshot),
      peekCachedSnapshot: jest.fn().mockReturnValue(systemModeSnapshot),
    };

    const service = new HealthService(
      prisma as never,
      queueMetricsService as never,
      systemModeService as never,
      createConfigMock() as never,
    );

    const snapshot = await service.ready();

    expect(snapshot.ok).toBe(true);
    expect(snapshot.checks.queueLag).toEqual(
      expect.objectContaining({
        ok: true,
        rawOk: true,
        softWarning: true,
        softWarningCode: 'stale-ready-fallback',
        sampleGeneratedAt: '2026-03-31T09:12:05.000Z',
      }),
    );
    expect(snapshot.checks.queueLag.softWarningDetail).toContain(
      'served a recent cached snapshot while refreshing metrics in the background',
    );
    expect(snapshot.bots).toEqual({
      id613002203036_bot: {
        queueLagSec: 2,
        rawOk: true,
        queuedEvents: 1,
        receivedEvents: 1,
        failedEvents: 0,
        action: {
          windowSec: 60,
          total: 5,
          success: 5,
          failure: 0,
          critical: 0,
          errorRate: 0,
          criticalRate: 0,
        },
      },
    });
    expect(queueMetricsService.getSnapshot).toHaveBeenCalledTimes(1);
    expect(queueMetricsService.getSnapshot).toHaveBeenCalledWith({ maxAgeMs: 0 });

    await service.onModuleDestroy();
  });

  it('uses cached system mode and fresh dependency probes on cold-start readiness timeout', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-03-31T09:07:00.000Z'));

    const prisma = {
      $queryRawUnsafe: jest
        .fn()
        .mockResolvedValue([{ '?column?': 1 }]),
    };
    const queueMetricsService = {
      getSnapshot: jest.fn().mockImplementation(() => new Promise(() => undefined)),
    };
    const systemModeSnapshot = {
      mode: 'degrade',
      source: 'auto',
      reason: 'recovery window in progress',
      updatedAt: '2026-03-31T09:06:55.000Z',
      manualMode: null,
      queueLagSec: 0,
      action: {
        windowSec: 60,
        total: 8,
        success: 8,
        failure: 0,
        critical: 0,
        errorRate: 0,
        criticalRate: 0,
      },
    };
    const systemModeService = {
      getEffectiveSnapshot: jest.fn().mockImplementation(() => new Promise(() => undefined)),
      peekCachedSnapshot: jest.fn().mockReturnValue(systemModeSnapshot),
    };

    const service = new HealthService(
      prisma as never,
      queueMetricsService as never,
      systemModeService as never,
      createConfigMock() as never,
    );

    const snapshotPromise = service.ready();
    jest.advanceTimersByTime(60);
    const snapshot = await snapshotPromise;

    expect(snapshot).toEqual(
      expect.objectContaining({
        ok: true,
        bots: {},
        systemMode: expect.objectContaining({
          mode: 'degrade',
          reason: 'recovery window in progress',
          degraded: true,
        }),
        checks: expect.objectContaining({
          database: true,
          redis: true,
          queueLag: expect.objectContaining({
            ok: true,
            rawOk: true,
            softWarning: true,
            softWarningCode: 'stale-ready-fallback',
            sampleGeneratedAt: '2026-03-31T09:06:55.000Z',
          }),
        }),
      }),
    );
    expect(snapshot.checks.queueLag.softWarningDetail).toContain(
      'readiness build exceeded 50ms',
    );

    await service.onModuleDestroy();
  });

  it('reuses recent dependency health during best-effort fallback when fresh probes stall', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-03-31T09:08:00.000Z'));

    const queueMetricsSnapshot = {
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
        total: 4,
        success: 4,
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
      generatedAt: '2026-03-31T09:08:00.000Z',
      bots: {},
      userFacingWebhookEvents: {
        received: { count: 0, oldestEventId: null, oldestCreatedAt: null, oldestLagSec: 0 },
        queued: { count: 0, oldestEventId: null, oldestCreatedAt: null, oldestLagSec: 0 },
        failed: { count: 0, oldestEventId: null, oldestCreatedAt: null, oldestLagSec: 0 },
      },
      userFacingOldestQueuedEventId: null,
      userFacingOldestQueuedCreatedAt: null,
      userFacingOldestQueuedLagSec: 0,
      userFacingOldestReceivedEventId: null,
      userFacingOldestReceivedCreatedAt: null,
      userFacingOldestReceivedLagSec: 0,
      userFacingEffectiveLagSec: 0,
    };
    const systemModeSnapshot = {
      mode: 'normal',
      source: 'auto',
      reason: 'system healthy',
      updatedAt: '2026-03-31T09:08:00.000Z',
      manualMode: null,
      queueLagSec: 0,
      action: {
        windowSec: 60,
        total: 4,
        success: 4,
        failure: 0,
        critical: 0,
        errorRate: 0,
        criticalRate: 0,
      },
    };
    const prisma = {
      $queryRawUnsafe: jest
        .fn()
        .mockResolvedValueOnce([{ '?column?': 1 }])
        .mockImplementationOnce(() => new Promise(() => undefined))
        .mockImplementationOnce(() => new Promise(() => undefined)),
    };
    const queueMetricsService = {
      getSnapshot: jest
        .fn()
        .mockResolvedValueOnce(queueMetricsSnapshot)
        .mockImplementationOnce(() => new Promise(() => undefined)),
    };
    const systemModeService = {
      getEffectiveSnapshot: jest
        .fn()
        .mockResolvedValueOnce(systemModeSnapshot)
        .mockImplementationOnce(() => new Promise(() => undefined)),
      peekCachedSnapshot: jest.fn().mockReturnValue(systemModeSnapshot),
    };

    const service = new HealthService(
      prisma as never,
      queueMetricsService as never,
      systemModeService as never,
      createConfigMock() as never,
    );

    const first = await service.ready();
    expect(first.ok).toBe(true);

    await jest.advanceTimersByTimeAsync(30_001);

    const secondPromise = service.ready();
    await jest.advanceTimersByTimeAsync(120);
    const second = await secondPromise;

    expect(second.ok).toBe(true);
    expect(second.checks.database).toBe(true);
    expect(second.checks.redis).toBe(true);
    expect(second.checks.queueLag).toEqual(
      expect.objectContaining({
        ok: true,
        rawOk: true,
        softWarning: true,
        softWarningCode: 'stale-ready-fallback',
        sampleGeneratedAt: '2026-03-31T09:08:00.000Z',
      }),
    );
    expect(second.checks.queueLag.softWarningDetail).toContain(
      'live readiness evaluation did not finish in 50ms',
    );

    await service.onModuleDestroy();
  });

  it('returns a degraded fallback snapshot when readiness data is unavailable on cold start', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-03-31T09:05:00.000Z'));

    const prisma = {
      $queryRawUnsafe: jest.fn().mockImplementation(() => new Promise(() => undefined)),
    };
    const queueMetricsService = {
      getSnapshot: jest.fn().mockImplementation(() => new Promise(() => undefined)),
    };
    const systemModeService = {
      getEffectiveSnapshot: jest.fn().mockImplementation(() => new Promise(() => undefined)),
      peekCachedSnapshot: jest.fn().mockReturnValue(null),
    };

    const service = new HealthService(
      prisma as never,
      queueMetricsService as never,
      systemModeService as never,
      createConfigMock() as never,
    );

    const snapshotPromise = service.ready();
    jest.advanceTimersByTime(60);
    const snapshot = await snapshotPromise;

    expect(snapshot).toEqual(
      expect.objectContaining({
        ok: false,
        systemMode: expect.objectContaining({
          mode: 'degrade',
          reason: 'readiness snapshot unavailable',
          degraded: true,
        }),
        checks: expect.objectContaining({
          database: false,
          redis: false,
          queueLag: expect.objectContaining({
            ok: false,
            softWarning: true,
            softWarningCode: 'stale-ready-fallback',
          }),
        }),
      }),
    );

    await service.onModuleDestroy();
  });

  it('keeps readiness green during short queue bursts but flips after sustained lag', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-03-29T10:00:00.000Z'));

    const prisma = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
    };
    const queueMetricsService = {
      getSnapshot: jest.fn().mockResolvedValue({
        moderation: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
        webhookCritical: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
        webhookDefault: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
        webhookBackground: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
        webhookLegacy: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
        actions: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
        webhookEvents: {
          received: {
            count: 1,
            oldestEventId: 'received-1',
            oldestCreatedAt: '2026-03-29T09:59:49.000Z',
            oldestLagSec: 11,
          },
          queued: {
            count: 1,
            oldestEventId: 'queued-1',
            oldestCreatedAt: '2026-03-29T09:59:48.000Z',
            oldestLagSec: 12,
          },
          failed: {
            count: 0,
            oldestEventId: null,
            oldestCreatedAt: null,
            oldestLagSec: 0,
          },
        },
        actionHealth: {
          windowSec: 60,
          total: 24,
          success: 24,
          failure: 0,
          critical: 0,
          errorRate: 0,
          criticalRate: 0,
        },
        oldestQueuedEventId: 'queued-1',
        oldestQueuedCreatedAt: '2026-03-29T09:59:48.000Z',
        oldestQueuedLagSec: 12,
        oldestReceivedEventId: 'received-1',
        oldestReceivedCreatedAt: '2026-03-29T09:59:49.000Z',
        oldestReceivedLagSec: 11,
        effectiveLagSec: 12,
        generatedAt: '2026-03-29T10:00:00.000Z',
      }),
    };
    const systemModeService = {
      getEffectiveSnapshot: jest.fn().mockResolvedValue({
        mode: 'degrade',
        source: 'auto',
        reason: 'queue lag 12.0s',
        updatedAt: '2026-03-29T10:00:00.000Z',
        manualMode: null,
        queueLagSec: 12,
        action: {
          windowSec: 60,
          total: 24,
          success: 24,
          failure: 0,
          critical: 0,
          errorRate: 0,
          criticalRate: 0,
        },
      }),
    };

    const service = new HealthService(
      prisma as never,
      queueMetricsService as never,
      systemModeService as never,
      createConfigMock() as never,
    );

    const first = await service.ready();
    expect(first.ok).toBe(true);
    expect(first.checks.queueLag).toEqual(
      expect.objectContaining({
        ok: true,
        rawOk: false,
        softWarning: true,
        softWarningCode: 'queue-lag-hysteresis',
        breachStartedAt: '2026-03-29T10:00:00.000Z',
        breachDurationSec: 0,
      }),
    );
    expect(first.checks.queueLag.softWarningDetail).toContain('Raw user-facing queue lag 12.0s');

    jest.setSystemTime(new Date('2026-03-29T10:00:21.000Z'));

    const second = await service.ready();
    expect(second.ok).toBe(false);
    expect(second.checks.queueLag).toEqual(
      expect.objectContaining({
        ok: false,
        rawOk: false,
        softWarning: false,
        softWarningCode: null,
        breachStartedAt: '2026-03-29T10:00:00.000Z',
      }),
    );
    expect(second.checks.queueLag.breachDurationSec).toBeGreaterThanOrEqual(20);

    await service.onModuleDestroy();
  });
});
