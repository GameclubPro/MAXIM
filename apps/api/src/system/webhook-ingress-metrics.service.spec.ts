import Redis from 'ioredis';
import { WebhookIngressMetricsService } from './webhook-ingress-metrics.service';

type RedisMockState = {
  hashes: Map<string, Record<string, string>>;
  failReads: boolean;
  failWrites: boolean;
};

const redisState: RedisMockState = {
  hashes: new Map(),
  failReads: false,
  failWrites: false,
};

const redisInstances: Array<{
  eval: jest.Mock;
  pipeline: jest.Mock;
  quit: jest.Mock;
}> = [];

jest.mock('ioredis', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => {
    const instance = {
      eval: jest.fn(
        async (
          _script: string,
          _keyCount: number,
          key: string,
          outcome: 'persisted' | 'failed',
          encodedBotId: string,
          latencyBucket: string,
          rawLatencyMs: string,
          underTarget: string,
        ) => {
          if (redisState.failWrites) {
            throw new Error('redis write unavailable');
          }
          const hash = { ...(redisState.hashes.get(key) ?? {}) };
          const increment = (field: string) => {
            hash[field] = String(Number(hash[field] ?? 0) + 1);
          };
          increment('attempted');
          increment(`bot:${encodedBotId}:attempted`);
          if (outcome === 'persisted') {
            increment('persisted');
            increment(`latency:${latencyBucket}`);
            increment(`bot:${encodedBotId}:persisted`);
            if (underTarget === '1') {
              increment('under_target');
            }
            hash.max_latency_ms = String(
              Math.max(Number(hash.max_latency_ms ?? 0), Number(rawLatencyMs)),
            );
          } else {
            increment('failed');
            increment(`bot:${encodedBotId}:failed`);
          }
          redisState.hashes.set(key, hash);
          return 1;
        },
      ),
      pipeline: jest.fn(() => {
        const keys: string[] = [];
        return {
          hgetall: jest.fn((key: string) => {
            keys.push(key);
          }),
          exec: jest.fn(async () => {
            if (redisState.failReads) {
              throw new Error('redis read unavailable');
            }
            return keys.map((key) => [null, { ...(redisState.hashes.get(key) ?? {}) }]);
          }),
        };
      }),
      quit: jest.fn().mockResolvedValue(undefined),
    };
    redisInstances.push(instance);
    return instance;
  }),
}));

function createService(overrides: Record<string, unknown> = {}) {
  return new WebhookIngressMetricsService({
    getOrThrow: jest.fn().mockReturnValue('redis://localhost:6379/0'),
    get: jest.fn((key: string) => overrides[key]),
  } as never);
}

describe('WebhookIngressMetricsService', () => {
  beforeEach(() => {
    redisState.hashes.clear();
    redisState.failReads = false;
    redisState.failWrites = false;
    redisInstances.length = 0;
    jest.spyOn(Date, 'now').mockReturnValue(new Date('2026-07-11T10:00:05.000Z').getTime());
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('aggregates bounded persistence histograms and per-bot receipt counts', async () => {
    const service = createService({
      SYSTEM_WEBHOOK_INGRESS_SLO_TARGET_MS: 2_000,
      SYSTEM_WEBHOOK_SLO_WINDOW_SEC: 900,
    });

    await service.recordReceiptPersistence({
      botId: 'bot-1',
      outcome: 'persisted',
      latencyMs: 100,
    });
    await service.recordReceiptPersistence({
      botId: 'bot-1',
      outcome: 'persisted',
      latencyMs: 1_900,
    });
    await service.recordReceiptPersistence({
      botId: 'bot-1',
      outcome: 'persisted',
      latencyMs: 2_100,
    });
    await service.recordReceiptPersistence({
      botId: 'bot-2',
      outcome: 'persisted',
      latencyMs: 9_000,
    });
    await service.recordReceiptPersistence({ botId: 'bot-2', outcome: 'failed', latencyMs: 300 });

    await expect(service.getSnapshot({ windowSec: 900 })).resolves.toEqual({
      available: true,
      targetMs: 2_000,
      attemptedReceipts: 5,
      persistedReceipts: 4,
      failedReceipts: 1,
      sampledReceipts: 4,
      p95LatencyMs: 10_000,
      p99LatencyMs: 10_000,
      underTargetRatio: 0.5,
      bots: {
        'bot-1': {
          attemptedReceipts: 3,
          persistedReceipts: 3,
          failedReceipts: 0,
        },
        'bot-2': {
          attemptedReceipts: 2,
          persistedReceipts: 1,
          failedReceipts: 1,
        },
      },
    });

    const metricKey = redisInstances[0]?.eval.mock.calls[0]?.[2] as string;
    expect(metricKey).toMatch(/^system:webhook-ingress:metrics:v1:2000:\d+$/u);
    expect(metricKey).not.toContain('bot-1');
    await service.onModuleDestroy();
  });

  it('reports Redis read failure without throwing into the dashboard path', async () => {
    const service = createService();
    redisState.failReads = true;

    await expect(service.getSnapshot({ windowSec: 900 })).resolves.toMatchObject({
      available: false,
      targetMs: 2_000,
      attemptedReceipts: 0,
      failedReceipts: 0,
      p99LatencyMs: null,
    });
    await service.onModuleDestroy();
  });

  it('swallows Redis write failures so metric recording cannot affect webhook ACK', async () => {
    const service = createService();
    redisState.failWrites = true;

    await expect(
      service.recordReceiptPersistence({
        botId: 'bot-1',
        outcome: 'persisted',
        latencyMs: 120,
      }),
    ).resolves.toBeUndefined();
    expect(redisState.hashes.size).toBe(0);
    await service.onModuleDestroy();
  });

  it('creates Redis keys without bot ids, tokens, or webhook secrets', async () => {
    const service = createService();
    await service.recordReceiptPersistence({
      botId: 'public-bot-id',
      outcome: 'persisted',
      latencyMs: 25,
    });

    const redis = Redis as unknown as jest.Mock;
    expect(redis).toHaveBeenCalledWith('redis://localhost:6379/0');
    const key = redisInstances[0]?.eval.mock.calls[0]?.[2] as string;
    expect(key).toBe('system:webhook-ingress:metrics:v1:2000:178376400');
    expect(key).not.toContain('public-bot-id');
    await service.onModuleDestroy();
  });
});
