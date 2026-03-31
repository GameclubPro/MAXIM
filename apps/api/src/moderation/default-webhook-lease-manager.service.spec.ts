import * as leasePlanModule from '../runtime/default-webhook-lease-plan';
import { DEFAULT_WEBHOOK_QUEUE_NAMES } from '../webhook/webhook-queues';
import { buildDefaultWebhookLeaseKey, buildDefaultWebhookWorkerHeartbeatKey } from '../runtime/default-webhook-dynamic-leases';
import { DefaultWebhookLeaseManagerService } from './default-webhook-lease-manager.service';

type RedisMockInstance = {
  store: Map<string, string>;
  get: jest.Mock<Promise<string | null>, [string]>;
  set: jest.Mock<Promise<'OK'>, [string, string, ...Array<string | number>]>;
  del: jest.Mock<Promise<number>, [string]>;
  quit: jest.Mock<Promise<void>, []>;
  pipeline: jest.Mock;
};

const redisInstances: RedisMockInstance[] = [];

jest.mock('ioredis', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => {
    const store = new Map<string, string>();
    const instance: RedisMockInstance = {
      store,
      get: jest.fn(async (key: string) => store.get(key) ?? null),
      set: jest.fn(async (key: string, value: string) => {
        store.set(key, value);
        return 'OK';
      }),
      del: jest.fn(async (key: string) => {
        return store.delete(key) ? 1 : 0;
      }),
      quit: jest.fn(async () => undefined),
      pipeline: jest.fn(() => {
        const commands: Array<{ op: 'get' | 'set'; args: unknown[] }> = [];
        return {
          get(key: string) {
            commands.push({ op: 'get', args: [key] });
            return this;
          },
          set(key: string, value: string, ...rest: Array<string | number>) {
            commands.push({ op: 'set', args: [key, value, ...rest] });
            return this;
          },
          exec: jest.fn(async () => {
            return commands.map((command) => {
              if (command.op === 'get') {
                const [key] = command.args as [string];
                return [null, store.get(key) ?? null] as const;
              }

              const [key, value] = command.args as [string, string];
              store.set(key, value);
              return [null, 'OK'] as const;
            });
          }),
        };
      }),
    };
    redisInstances.push(instance);
    return instance;
  }),
}));

function createConfigMock(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    REDIS_URL: 'redis://localhost:6379/0',
    WEBHOOK_DYNAMIC_LEASES_WORKER_GROUP: 'api-moderation',
    WEBHOOK_DYNAMIC_LEASES_MODE: 'on',
    WEBHOOK_DYNAMIC_LEASES_HEARTBEAT_MS: 1_000,
    WEBHOOK_DYNAMIC_LEASES_LEASE_TTL_MS: 12_000,
    WEBHOOK_DYNAMIC_LEASES_HANDOFF_TTL_MS: 12_000,
    WEBHOOK_DYNAMIC_LEASES_REBALANCE_COOLDOWN_MS: 30_000,
    WEBHOOK_DYNAMIC_LEASES_SUMMARY_TTL_MS: 20_000,
    WEBHOOK_DYNAMIC_LEASES_CLOSE_TIMEOUT_MS: 100,
    ...overrides,
  };

  return {
    get: jest.fn((key: string, fallback?: unknown) => values[key] ?? fallback),
    getOrThrow: jest.fn((key: string) => {
      if (!(key in values)) {
        throw new Error(`Missing key ${key}`);
      }
      return values[key];
    }),
  };
}

function createQueueMetricsMock() {
  const emptyCounters = {
    waiting: 0,
    prioritized: 0,
    active: 0,
    delayed: 0,
    failed: 0,
    completed: 0,
  };

  return {
    getSnapshot: jest.fn().mockResolvedValue({
      webhookDefaultShards: Object.fromEntries(
        Array.from({ length: 16 }, (_, index) => [`moderation-default-${index}`, { ...emptyCounters }]),
      ),
    }),
  };
}

describe('DefaultWebhookLeaseManagerService', () => {
  const originalRole = process.env.APP_ROLE;

  beforeEach(() => {
    process.env.APP_ROLE = 'moderation';
    redisInstances.length = 0;
  });

  afterEach(async () => {
    process.env.APP_ROLE = originalRole;
    jest.useRealTimers();
  });

  it('publishes heartbeat and renews claims for locally running workers', async () => {
    const queueMetricsService = createQueueMetricsMock();
    const service = new DefaultWebhookLeaseManagerService(
      createConfigMock() as never,
      { processWebhookEvent: jest.fn() } as never,
      queueMetricsService as never,
    );

    const redis = redisInstances[0]!;
    const queueName = 'moderation-default-0';
    const previousLeaseUntilMs = Date.now() + 1_000;
    redis.store.set(
      buildDefaultWebhookLeaseKey(queueName),
      JSON.stringify({
        queueName,
        ownerId: 'api-moderation',
        fencingToken: 4,
        claimedAtMs: Date.now() - 5_000,
        updatedAtMs: Date.now() - 5_000,
        leaseUntilMs: previousLeaseUntilMs,
      }),
    );

    (service as any).workers.set(queueName, {
      close: jest.fn().mockResolvedValue(undefined),
    });

    await (service as any).publishKeepalive();

    const heartbeat = redis.store.get(buildDefaultWebhookWorkerHeartbeatKey('api-moderation'));
    expect(heartbeat).toBeTruthy();

    const renewedClaim = JSON.parse(redis.store.get(buildDefaultWebhookLeaseKey(queueName)) ?? '{}');
    expect(renewedClaim.ownerId).toBe('api-moderation');
    expect(renewedClaim.fencingToken).toBe(4);
    expect(renewedClaim.leaseUntilMs).toBeGreaterThan(previousLeaseUntilMs);

    await service.onModuleDestroy();
  });

  it('recycles a stale non-running worker when prioritized backlog remains on an allowed shard', async () => {
    const service = new DefaultWebhookLeaseManagerService(
      createConfigMock() as never,
      { processWebhookEvent: jest.fn() } as never,
      createQueueMetricsMock() as never,
    );

    const queueName = 'moderation-default-0';
    const staleWorker = {
      close: jest.fn().mockResolvedValue(undefined),
      isRunning: jest.fn().mockReturnValue(false),
    };
    (service as any).workers.set(queueName, staleWorker);

    await (service as any).ensureWorkerRunning(queueName, {
      waiting: 0,
      prioritized: 5,
      active: 0,
      delayed: 0,
      failed: 0,
      completed: 0,
    });

    expect(staleWorker.close).toHaveBeenCalledWith(true);
    expect((service as any).workers.get(queueName)).not.toBe(staleWorker);

    await service.onModuleDestroy();
  });

  it('force-recycles a worker after a timed-out close cooldown expires if backlog is still pinned', async () => {
    const service = new DefaultWebhookLeaseManagerService(
      createConfigMock() as never,
      { processWebhookEvent: jest.fn() } as never,
      createQueueMetricsMock() as never,
    );

    const queueName = 'moderation-default-12';
    const stuckWorker = {
      close: jest.fn().mockResolvedValue(undefined),
      isRunning: jest.fn().mockReturnValue(true),
    };
    (service as any).workers.set(queueName, stuckWorker);
    (service as any).closeRetryNotBeforeMs.set(queueName, Date.now() - 1);

    await (service as any).ensureWorkerRunning(queueName, {
      waiting: 0,
      prioritized: 6,
      active: 0,
      delayed: 0,
      failed: 0,
      completed: 0,
    });

    expect(stuckWorker.close).toHaveBeenCalledWith(true);
    expect((service as any).workers.get(queueName)).not.toBe(stuckWorker);

    await service.onModuleDestroy();
  });

  it('keeps the worker mapped until close resolves so keepalive can continue renewing its claim', async () => {
    const service = new DefaultWebhookLeaseManagerService(
      createConfigMock() as never,
      { processWebhookEvent: jest.fn() } as never,
      createQueueMetricsMock() as never,
    );

    const queueName = 'moderation-default-0';
    let resolveClose!: () => void;
    const close = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveClose = resolve;
        }),
    );

    (service as any).workers.set(queueName, { close });

    const closePromise = (service as any).closeWorker(queueName);

    expect((service as any).workers.has(queueName)).toBe(true);
    expect((service as any).closingWorkers.has(queueName)).toBe(true);

    resolveClose();
    await closePromise;

    expect((service as any).workers.has(queueName)).toBe(false);
    expect((service as any).closingWorkers.has(queueName)).toBe(false);

    await service.onModuleDestroy();
  });

  it('does not renew claims for workers that are already closing', async () => {
    const queueMetricsService = createQueueMetricsMock();
    const service = new DefaultWebhookLeaseManagerService(
      createConfigMock() as never,
      { processWebhookEvent: jest.fn() } as never,
      queueMetricsService as never,
    );

    const redis = redisInstances[0]!;
    const queueName = 'moderation-default-0';
    const originalClaim = {
      queueName,
      ownerId: 'api-moderation',
      fencingToken: 7,
      claimedAtMs: Date.now() - 10_000,
      updatedAtMs: Date.now() - 10_000,
      leaseUntilMs: Date.now() + 500,
    };
    redis.store.set(buildDefaultWebhookLeaseKey(queueName), JSON.stringify(originalClaim));

    (service as any).workers.set(queueName, {
      close: jest.fn().mockResolvedValue(undefined),
    });
    (service as any).closingWorkers.add(queueName);

    await (service as any).publishKeepalive();

    const renewedClaim = JSON.parse(redis.store.get(buildDefaultWebhookLeaseKey(queueName)) ?? '{}');
    expect(renewedClaim).toEqual(originalClaim);

    await service.onModuleDestroy();
  });

  it('keeps the local worker pinned and applies cooldown when close hangs past the configured timeout', async () => {
    jest.useFakeTimers();
    const service = new DefaultWebhookLeaseManagerService(
      createConfigMock({
        WEBHOOK_DYNAMIC_LEASES_CLOSE_TIMEOUT_MS: 10,
        WEBHOOK_DYNAMIC_LEASES_REBALANCE_COOLDOWN_MS: 50,
      }) as never,
      { processWebhookEvent: jest.fn() } as never,
      createQueueMetricsMock() as never,
    );

    const queueName = 'moderation-default-0';
    let resolveClose!: () => void;
    const close = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveClose = resolve;
        }),
    );
    (service as any).workers.set(queueName, { close });

    const closePromise = (service as any).closeWorker(queueName);
    await jest.advanceTimersByTimeAsync(11);
    await expect(closePromise).resolves.toBe('timed_out');

    expect(close).toHaveBeenCalledTimes(1);
    expect((service as any).workers.has(queueName)).toBe(true);
    expect((service as any).closingWorkers.has(queueName)).toBe(false);
    expect((service as any).isCloseRetryCoolingDown(queueName)).toBe(true);

    resolveClose();
    await Promise.resolve();
    expect((service as any).workers.has(queueName)).toBe(false);

    await service.onModuleDestroy();
  });

  it('does not hand off a shard when worker close times out', async () => {
    const service = new DefaultWebhookLeaseManagerService(
      createConfigMock() as never,
      { processWebhookEvent: jest.fn() } as never,
      createQueueMetricsMock() as never,
    );

    const queueName = 'moderation-default-0';
    const claimKey = buildDefaultWebhookLeaseKey(queueName);
    const redis = redisInstances[0]!;
    redis.store.set(
      claimKey,
      JSON.stringify({
        queueName,
        ownerId: 'api-moderation',
        fencingToken: 1,
        claimedAtMs: Date.now() - 5_000,
        updatedAtMs: Date.now() - 5_000,
        leaseUntilMs: Date.now() + 60_000,
      }),
    );

    const planQueues = Object.fromEntries(
      DEFAULT_WEBHOOK_QUEUE_NAMES.map((name) => [
        name,
        {
          queueName: name,
          homeOwner: 'api-moderation',
          currentOwner: 'api-moderation',
          desiredOwner: 'api-moderation',
          eligibleForDynamicLeases: true,
          activeJobs: 0,
          pressure: 0,
          reason: 'keep-current-owner',
          handoffPending: false,
        },
      ]),
    ) as Record<string, Record<string, unknown>>;
    planQueues[queueName] = {
      queueName,
      homeOwner: 'api-moderation',
      currentOwner: 'api-moderation',
      desiredOwner: 'api-moderation-realtime-b',
      eligibleForDynamicLeases: true,
      activeJobs: 0,
      pressure: 10,
      reason: 'rebalance-least-loaded',
      handoffPending: false,
    };

    jest
      .spyOn(leasePlanModule, 'buildDefaultWebhookLeasePlan')
      .mockReturnValue({
        workerLoads: {
          'api-moderation': 10,
          'api-moderation-realtime-b': 0,
          'api-moderation-realtime-c': 0,
          'api-moderation-realtime-d': 0,
        },
        queues: planQueues as ReturnType<typeof leasePlanModule.buildDefaultWebhookLeasePlan>['queues'],
      });

    (service as any).loadClaims = jest.fn().mockResolvedValue({
      [queueName]: JSON.parse(redis.store.get(claimKey) ?? '{}'),
    });
    (service as any).loadHandoffs = jest.fn().mockResolvedValue({});
    (service as any).loadAliveWorkerGroups = jest.fn().mockResolvedValue(
      new Set(['api-moderation', 'api-moderation-realtime-b', 'api-moderation-realtime-c', 'api-moderation-realtime-d']),
    );
    (service as any).closeWorker = jest.fn().mockResolvedValue('timed_out');
    (service as any).closeWorkersExcept = jest.fn().mockResolvedValue(undefined);
    (service as any).ensureWorkerRunning = jest.fn().mockResolvedValue(undefined);
    (service as any).issueHandoff = jest.fn().mockResolvedValue(undefined);
    (service as any).releaseClaim = jest.fn().mockResolvedValue(undefined);

    await (service as any).applyDynamicPlan();

    expect((service as any).closeWorker).toHaveBeenCalledWith(queueName);
    expect((service as any).issueHandoff).not.toHaveBeenCalled();
    expect((service as any).releaseClaim).not.toHaveBeenCalled();
    expect((service as any).closeWorkersExcept).toHaveBeenCalledTimes(1);
    const allowedWorkers = ((service as any).closeWorkersExcept as jest.Mock).mock.calls[0]?.[0];
    expect(allowedWorkers).toBeInstanceOf(Set);
    expect(allowedWorkers.has(queueName)).toBe(true);

    jest.restoreAllMocks();
    await service.onModuleDestroy();
  });
});
