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
    expect(queueMetricsService.getSnapshot).toHaveBeenCalledWith({ maxAgeMs: 5000 });
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
          total: 12,
          success: 12,
          failure: 0,
          critical: 0,
          errorRate: 0,
          criticalRate: 0,
        },
      }),
    );

    await service.onModuleDestroy();
  });
});
