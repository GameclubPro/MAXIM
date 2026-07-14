import * as leasePlanModule from '../runtime/default-webhook-lease-plan';
import { DEFAULT_WEBHOOK_QUEUE_NAMES } from '../webhook/webhook-queues';
import {
  buildDefaultWebhookLeaseKey,
  buildDefaultWebhookWorkerHeartbeatKey,
} from '../runtime/default-webhook-dynamic-leases';
import { DefaultWebhookLeaseManagerService } from './default-webhook-lease-manager.service';

type RedisMockInstance = {
  store: Map<string, string>;
  get: jest.Mock<Promise<string | null>, [string]>;
  set: jest.Mock<Promise<'OK'>, [string, string, ...Array<string | number>]>;
  del: jest.Mock<Promise<number>, [string]>;
  eval: jest.Mock;
  quit: jest.Mock<Promise<void>, []>;
  pipeline: jest.Mock;
};

const redisInstances: RedisMockInstance[] = [];
const sharedRedisStore = new Map<string, string>();

jest.mock('ioredis', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => {
    const store = sharedRedisStore;
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
      eval: jest.fn(
        async (script: string, keyCount: number | string, ...args: Array<string | number>) => {
          const keyLength = Number(keyCount);
          const keys = args.slice(0, keyLength).map(String);
          const values = args.slice(keyLength).map(String);
          const parseClaim = (key: string | undefined) => {
            const raw = key ? store.get(key) : null;
            if (!raw) {
              return null;
            }
            try {
              return JSON.parse(raw) as {
                queueName: string;
                ownerId: string;
                fencingToken: number;
                claimedAtMs: number;
                updatedAtMs: number;
                leaseUntilMs: number;
              };
            } catch {
              return null;
            }
          };

          if (script.includes('default-webhook-lease:claim')) {
            const [leaseKey, fencingKey] = keys;
            const [ownerId, queueName, nowRaw, ttlRaw] = values;
            const nowMs = Number(nowRaw);
            const ttlMs = Number(ttlRaw);
            const current = parseClaim(leaseKey);
            const recordedFencingToken = Number(store.get(fencingKey ?? '') ?? 0);
            const currentFencingToken = current?.fencingToken ?? 0;
            if (currentFencingToken > recordedFencingToken) {
              store.set(fencingKey ?? '', String(currentFencingToken));
            }
            if (current && current.leaseUntilMs > nowMs && current.ownerId !== ownerId) {
              return [0, 0];
            }

            const fencingToken = Math.max(recordedFencingToken, currentFencingToken) + 1;
            store.set(fencingKey ?? '', String(fencingToken));
            store.set(
              leaseKey ?? '',
              JSON.stringify({
                queueName,
                ownerId,
                fencingToken,
                claimedAtMs: nowMs,
                updatedAtMs: nowMs,
                leaseUntilMs: nowMs + ttlMs,
              }),
            );
            return [1, fencingToken];
          }

          if (script.includes('default-webhook-lease:renew')) {
            const [leaseKey] = keys;
            const [ownerId, fencingTokenRaw, nowRaw, ttlRaw] = values;
            const current = parseClaim(leaseKey);
            if (
              !current ||
              current.ownerId !== ownerId ||
              current.fencingToken !== Number(fencingTokenRaw)
            ) {
              return 0;
            }

            const nowMs = Number(nowRaw);
            store.set(
              leaseKey ?? '',
              JSON.stringify({
                ...current,
                updatedAtMs: nowMs,
                leaseUntilMs: nowMs + Number(ttlRaw),
              }),
            );
            return 1;
          }

          if (script.includes('default-webhook-lease:release')) {
            const [leaseKey] = keys;
            const [ownerId, fencingTokenRaw] = values;
            const current = parseClaim(leaseKey);
            if (
              !current ||
              current.ownerId !== ownerId ||
              current.fencingToken !== Number(fencingTokenRaw)
            ) {
              return 0;
            }
            return store.delete(leaseKey ?? '') ? 1 : 0;
          }

          return null;
        },
      ),
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
        Array.from({ length: 16 }, (_, index) => [
          `moderation-default-${index}`,
          { ...emptyCounters },
        ]),
      ),
    }),
    getWebhookDefaultShardSnapshot: jest.fn().mockResolvedValue({
      webhookDefaultShards: Object.fromEntries(
        Array.from({ length: 16 }, (_, index) => [
          `moderation-default-${index}`,
          { ...emptyCounters },
        ]),
      ),
    }),
  };
}

function createSystemModeMock() {
  const snapshot = {
    mode: 'normal',
    source: 'auto',
    reason: 'system healthy',
    updatedAt: new Date().toISOString(),
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
  };

  return {
    getEffectiveSnapshot: jest.fn().mockResolvedValue(snapshot),
    peekCachedSnapshot: jest.fn().mockReturnValue(snapshot),
  };
}

describe('DefaultWebhookLeaseManagerService', () => {
  const originalRole = process.env.APP_ROLE;

  beforeEach(() => {
    process.env.APP_ROLE = 'moderation';
    redisInstances.length = 0;
    sharedRedisStore.clear();
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
      createSystemModeMock() as never,
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
    (service as any).localClaimFencingTokens.set(queueName, 4);

    await (service as any).publishKeepalive();

    const heartbeat = redis.store.get(buildDefaultWebhookWorkerHeartbeatKey('api-moderation'));
    expect(heartbeat).toBeTruthy();

    const renewedClaim = JSON.parse(
      redis.store.get(buildDefaultWebhookLeaseKey(queueName)) ?? '{}',
    );
    expect(renewedClaim.ownerId).toBe('api-moderation');
    expect(renewedClaim.fencingToken).toBe(4);
    expect(renewedClaim.leaseUntilMs).toBeGreaterThan(previousLeaseUntilMs);

    await service.onModuleDestroy();
  });

  it('atomically grants a contested shard claim to only one worker group', async () => {
    const primaryService = new DefaultWebhookLeaseManagerService(
      createConfigMock() as never,
      { processWebhookEvent: jest.fn() } as never,
      createQueueMetricsMock() as never,
      createSystemModeMock() as never,
    );
    const secondaryService = new DefaultWebhookLeaseManagerService(
      createConfigMock({
        WEBHOOK_DYNAMIC_LEASES_WORKER_GROUP: 'api-moderation-realtime-b',
      }) as never,
      { processWebhookEvent: jest.fn() } as never,
      createQueueMetricsMock() as never,
      createSystemModeMock() as never,
    );

    const queueName = 'moderation-default-0';
    const [primaryClaimed, secondaryClaimed] = await Promise.all([
      (primaryService as any).claimQueue(queueName),
      (secondaryService as any).claimQueue(queueName),
    ]);

    expect([primaryClaimed, secondaryClaimed].filter(Boolean)).toHaveLength(1);

    const claim = JSON.parse(
      redisInstances[0]!.store.get(buildDefaultWebhookLeaseKey(queueName)) ?? '{}',
    );
    const winningService = primaryClaimed ? primaryService : secondaryService;
    const losingService = primaryClaimed ? secondaryService : primaryService;
    expect(claim.ownerId).toBe(primaryClaimed ? 'api-moderation' : 'api-moderation-realtime-b');
    expect((winningService as any).localClaimFencingTokens.get(queueName)).toBe(claim.fencingToken);
    expect((losingService as any).localClaimFencingTokens.has(queueName)).toBe(false);

    await Promise.all([primaryService.onModuleDestroy(), secondaryService.onModuleDestroy()]);
  });

  it('preserves an observed fencing epoch when an existing claim initially blocks acquisition', async () => {
    const service = new DefaultWebhookLeaseManagerService(
      createConfigMock({
        WEBHOOK_DYNAMIC_LEASES_WORKER_GROUP: 'api-moderation-realtime-b',
      }) as never,
      { processWebhookEvent: jest.fn() } as never,
      createQueueMetricsMock() as never,
      createSystemModeMock() as never,
    );

    const queueName = 'moderation-default-0';
    const claimKey = buildDefaultWebhookLeaseKey(queueName);
    const legacyClaim = {
      queueName,
      ownerId: 'api-moderation',
      fencingToken: 41,
      claimedAtMs: Date.now() - 10_000,
      updatedAtMs: Date.now() - 1_000,
      leaseUntilMs: Date.now() + 10_000,
    };
    redisInstances[0]!.store.set(claimKey, JSON.stringify(legacyClaim));

    expect(await (service as any).claimQueue(queueName)).toBe(false);

    redisInstances[0]!.store.delete(claimKey);
    expect(await (service as any).claimQueue(queueName)).toBe(true);

    const claim = JSON.parse(redisInstances[0]!.store.get(claimKey) ?? '{}');
    expect(claim.ownerId).toBe('api-moderation-realtime-b');
    expect(claim.fencingToken).toBe(42);

    await service.onModuleDestroy();
  });

  it('does not renew a lease after its local fencing token is superseded', async () => {
    const staleService = new DefaultWebhookLeaseManagerService(
      createConfigMock() as never,
      { processWebhookEvent: jest.fn() } as never,
      createQueueMetricsMock() as never,
      createSystemModeMock() as never,
    );
    const replacementService = new DefaultWebhookLeaseManagerService(
      createConfigMock() as never,
      { processWebhookEvent: jest.fn() } as never,
      createQueueMetricsMock() as never,
      createSystemModeMock() as never,
    );

    const queueName = 'moderation-default-0';
    expect(await (staleService as any).claimQueue(queueName)).toBe(true);
    const staleFencingToken = (staleService as any).localClaimFencingTokens.get(queueName);
    expect(await (replacementService as any).claimQueue(queueName)).toBe(true);
    const replacementFencingToken = (replacementService as any).localClaimFencingTokens.get(
      queueName,
    );
    expect(replacementFencingToken).toBeGreaterThan(staleFencingToken);

    (staleService as any).workers.set(queueName, {
      close: jest.fn().mockResolvedValue(undefined),
    });
    await (staleService as any).publishKeepalive();

    const claim = JSON.parse(
      redisInstances[0]!.store.get(buildDefaultWebhookLeaseKey(queueName)) ?? '{}',
    );
    expect(claim.fencingToken).toBe(replacementFencingToken);
    expect((staleService as any).localClaimFencingTokens.has(queueName)).toBe(false);

    await Promise.all([staleService.onModuleDestroy(), replacementService.onModuleDestroy()]);
  });

  it('does not let a stale release remove a replacement claim from the same worker group', async () => {
    const staleService = new DefaultWebhookLeaseManagerService(
      createConfigMock() as never,
      { processWebhookEvent: jest.fn() } as never,
      createQueueMetricsMock() as never,
      createSystemModeMock() as never,
    );
    const replacementService = new DefaultWebhookLeaseManagerService(
      createConfigMock() as never,
      { processWebhookEvent: jest.fn() } as never,
      createQueueMetricsMock() as never,
      createSystemModeMock() as never,
    );

    const queueName = 'moderation-default-0';
    expect(await (staleService as any).claimQueue(queueName)).toBe(true);
    const staleFencingToken = (staleService as any).localClaimFencingTokens.get(queueName);
    expect(await (replacementService as any).claimQueue(queueName)).toBe(true);
    const replacementFencingToken = (replacementService as any).localClaimFencingTokens.get(
      queueName,
    );

    await expect((staleService as any).releaseClaim(queueName)).resolves.toBe(false);

    const claim = JSON.parse(
      redisInstances[0]!.store.get(buildDefaultWebhookLeaseKey(queueName)) ?? '{}',
    );
    expect(replacementFencingToken).toBeGreaterThan(staleFencingToken);
    expect(claim.ownerId).toBe('api-moderation');
    expect(claim.fencingToken).toBe(replacementFencingToken);
    expect((staleService as any).localClaimFencingTokens.has(queueName)).toBe(false);

    await Promise.all([staleService.onModuleDestroy(), replacementService.onModuleDestroy()]);
  });

  it('releases locally fenced claims when dynamic leases are disabled', async () => {
    const service = new DefaultWebhookLeaseManagerService(
      createConfigMock({ WEBHOOK_DYNAMIC_LEASES_MODE: 'shadow' }) as never,
      { processWebhookEvent: jest.fn() } as never,
      createQueueMetricsMock() as never,
      createSystemModeMock() as never,
    );

    const queueName = 'moderation-default-0';
    redisInstances[0]!.store.set(
      buildDefaultWebhookLeaseKey(queueName),
      JSON.stringify({
        queueName,
        ownerId: 'api-moderation',
        fencingToken: 9,
        claimedAtMs: Date.now() - 1_000,
        updatedAtMs: Date.now() - 1_000,
        leaseUntilMs: Date.now() + 10_000,
      }),
    );
    (service as any).localClaimFencingTokens.set(queueName, 9);

    await (service as any).releaseLocalDynamicClaims();

    expect(redisInstances[0]!.store.has(buildDefaultWebhookLeaseKey(queueName))).toBe(false);
    expect((service as any).localClaimFencingTokens.has(queueName)).toBe(false);

    await service.onModuleDestroy();
  });

  it('recycles a stale non-running worker when prioritized backlog remains on an allowed shard', async () => {
    const service = new DefaultWebhookLeaseManagerService(
      createConfigMock() as never,
      { processWebhookEvent: jest.fn() } as never,
      createQueueMetricsMock() as never,
      createSystemModeMock() as never,
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
      createSystemModeMock() as never,
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
      createSystemModeMock() as never,
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
      createSystemModeMock() as never,
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
    (service as any).localClaimFencingTokens.set(queueName, 7);
    (service as any).closingWorkers.add(queueName);

    await (service as any).publishKeepalive();

    const renewedClaim = JSON.parse(
      redis.store.get(buildDefaultWebhookLeaseKey(queueName)) ?? '{}',
    );
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
      createSystemModeMock() as never,
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
      createSystemModeMock() as never,
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

    jest.spyOn(leasePlanModule, 'buildDefaultWebhookLeasePlan').mockReturnValue({
      workerLoads: {
        'api-moderation': 10,
        'api-moderation-realtime-b': 0,
        'api-moderation-realtime-c': 0,
        'api-moderation-realtime-d': 0,
      },
      queues: planQueues as ReturnType<
        typeof leasePlanModule.buildDefaultWebhookLeasePlan
      >['queues'],
    });

    (service as any).loadClaims = jest.fn().mockResolvedValue({
      [queueName]: JSON.parse(redis.store.get(claimKey) ?? '{}'),
    });
    (service as any).loadHandoffs = jest.fn().mockResolvedValue({});
    (service as any).loadAliveWorkerGroups = jest
      .fn()
      .mockResolvedValue(
        new Set([
          'api-moderation',
          'api-moderation-realtime-b',
          'api-moderation-realtime-c',
          'api-moderation-realtime-d',
        ]),
      );
    (service as any).closeWorker = jest.fn().mockResolvedValue('timed_out');
    (service as any).closeWorkersExcept = jest.fn().mockResolvedValue(undefined);
    (service as any).ensureWorkerRunning = jest.fn().mockResolvedValue(undefined);
    (service as any).issueHandoff = jest.fn().mockResolvedValue(undefined);
    (service as any).releaseClaim = jest.fn().mockResolvedValue(undefined);
    (service as any).localClaimFencingTokens.set(queueName, 1);

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
