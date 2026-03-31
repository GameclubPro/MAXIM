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
});
