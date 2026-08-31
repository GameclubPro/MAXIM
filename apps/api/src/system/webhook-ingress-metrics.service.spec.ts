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
      eval: jest.fn(async (script: string, _keyCount: number, key: string, ...args: string[]) => {
        if (redisState.failWrites) {
          throw new Error('redis write unavailable');
        }
        const hash = { ...(redisState.hashes.get(key) ?? {}) };
        const increment = (field: string) => {
          hash[field] = String(Number(hash[field] ?? 0) + 1);
        };
        if (script.includes('MAXIM_WEBHOOK_ROUTE_OUTCOMES_V1')) {
          for (let index = 1; index < args.length; index += 2) {
            const field = args[index];
            const count = Number(args[index + 1] ?? 0);
            if (field && count > 0) {
              hash[field] = String(Number(hash[field] ?? 0) + count);
            }
          }
          redisState.hashes.set(key, hash);
          return 1;
        }

        const [outcome, encodedBotId, latencyBucket, rawLatencyMs, underTarget] = args;
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
        } else if (outcome === 'failed') {
          increment('failed');
          increment(`bot:${encodedBotId}:failed`);
        } else {
          increment('rejected');
          increment(`bot:${encodedBotId}:rejected`);
        }
        redisState.hashes.set(key, hash);
        return 1;
      }),
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
    await service.recordReceiptPersistence({ botId: 'bot-2', outcome: 'rejected', latencyMs: 0 });
    service.recordRouteOutcome({ botId: 'bot-1', outcome: 'accepted' });
    service.recordRouteOutcome({ botId: 'bot-2', outcome: 'invalid_payload' });
    service.recordRouteOutcome({ botId: null, outcome: 'authentication_rejected' });

    await expect(service.getSnapshot({ windowSec: 900 })).resolves.toEqual({
      available: true,
      targetMs: 2_000,
      attemptedReceipts: 6,
      persistedReceipts: 4,
      failedReceipts: 1,
      rejectedReceipts: 1,
      sampledReceipts: 4,
      p95LatencyMs: 10_000,
      p99LatencyMs: 10_000,
      underTargetRatio: 0.5,
      bots: {
        'bot-1': {
          attemptedReceipts: 3,
          persistedReceipts: 3,
          failedReceipts: 0,
          rejectedReceipts: 0,
        },
        'bot-2': {
          attemptedReceipts: 3,
          persistedReceipts: 1,
          failedReceipts: 1,
          rejectedReceipts: 1,
        },
      },
      route: {
        attemptedRequests: 3,
        outcomes: {
          accepted: 1,
          authentication_rejected: 1,
          admission_rejected: 0,
          invalid_json: 0,
          invalid_payload: 1,
          payload_too_large: 0,
          timed_out: 0,
          failed: 0,
        },
        bots: {
          'bot-1': {
            attemptedRequests: 1,
            outcomes: {
              accepted: 1,
              authentication_rejected: 0,
              admission_rejected: 0,
              invalid_json: 0,
              invalid_payload: 0,
              payload_too_large: 0,
              timed_out: 0,
              failed: 0,
            },
          },
          'bot-2': {
            attemptedRequests: 1,
            outcomes: {
              accepted: 0,
              authentication_rejected: 0,
              admission_rejected: 0,
              invalid_json: 0,
              invalid_payload: 1,
              payload_too_large: 0,
              timed_out: 0,
              failed: 0,
            },
          },
        },
      },
      membershipCache: {
        precheck: {
          hit: 0,
          miss: 0,
          failOpen: 0,
          timing: {
            sampled: 0,
            p95DurationMs: null,
            p99DurationMs: null,
            overflowSamples: 0,
          },
        },
        lua: {
          applied: 0,
          superseded: 0,
          conflict: 0,
          retry: 0,
          exhausted: 0,
          failed: 0,
          timing: {
            sampled: 0,
            p95DurationMs: null,
            p99DurationMs: null,
            overflowSamples: 0,
          },
        },
        budget: {
          completed: 0,
          timeout: 0,
          timing: {
            sampled: 0,
            p95DurationMs: null,
            p99DurationMs: null,
            overflowSamples: 0,
          },
        },
      },
      membershipTransition: {
        edgeAdvance: {
          calls: 0,
          affectedRows: 0,
          noOpCalls: 0,
          timing: {
            sampled: 0,
            p95DurationMs: null,
            p99DurationMs: null,
            overflowSamples: 0,
          },
        },
      },
    });

    const metricKey = redisInstances[0]?.eval.mock.calls[0]?.[2] as string;
    expect(metricKey).toMatch(/^system:webhook-ingress:metrics:v1:2000:\d+$/u);
    expect(metricKey).not.toContain('bot-1');
    await service.onModuleDestroy();
  });

  it('aggregates privacy-safe membership cache and transition metrics', async () => {
    const service = createService();

    service.recordMembershipCacheMutation({ phase: 'precheck', outcome: 'hit', durationMs: 1 });
    service.recordMembershipCacheMutation({ phase: 'precheck', outcome: 'miss', durationMs: 2 });
    service.recordMembershipCacheMutation({
      phase: 'precheck',
      outcome: 'fail_open',
      durationMs: 100,
    });
    service.recordMembershipCacheMutation({ phase: 'lua', outcome: 'applied', durationMs: 5 });
    service.recordMembershipCacheMutation({
      phase: 'lua',
      outcome: 'superseded',
      durationMs: 10,
    });
    service.recordMembershipCacheMutation({ phase: 'lua', outcome: 'conflict', durationMs: 20 });
    service.recordMembershipCacheMutation({ phase: 'lua', outcome: 'retry' });
    service.recordMembershipCacheMutation({ phase: 'lua', outcome: 'exhausted' });
    service.recordMembershipCacheMutation({ phase: 'lua', outcome: 'failed', durationMs: 35 });
    service.recordMembershipCacheBudget({ outcome: 'completed', durationMs: 75 });
    service.recordMembershipCacheBudget({ outcome: 'timeout', durationMs: 100 });
    service.recordMembershipAccessEdgeAdvance({ durationMs: 5, affectedRows: 3 });
    service.recordMembershipAccessEdgeAdvance({ durationMs: 150, affectedRows: 0 });

    await expect(service.getSnapshot({ windowSec: 900 })).resolves.toMatchObject({
      membershipCache: {
        precheck: {
          hit: 1,
          miss: 1,
          failOpen: 1,
          timing: { sampled: 3, p95DurationMs: 100, p99DurationMs: 100 },
        },
        lua: {
          applied: 1,
          superseded: 1,
          conflict: 1,
          retry: 1,
          exhausted: 1,
          failed: 1,
          timing: { sampled: 4, p95DurationMs: 35, p99DurationMs: 35 },
        },
        budget: {
          completed: 1,
          timeout: 1,
          timing: { sampled: 2, p95DurationMs: 100, p99DurationMs: 100 },
        },
      },
      membershipTransition: {
        edgeAdvance: {
          calls: 2,
          affectedRows: 3,
          noOpCalls: 1,
          timing: { sampled: 2, p95DurationMs: 150, p99DurationMs: 150 },
        },
      },
    });

    const bufferedMetricCall = redisInstances[0]?.eval.mock.calls.find((call) =>
      String(call[0]).includes('MAXIM_WEBHOOK_ROUTE_OUTCOMES_V1'),
    );
    expect(JSON.stringify(bufferedMetricCall)).not.toMatch(/chat-|user-|update-|payload/iu);
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
      rejectedReceipts: 0,
      p99LatencyMs: null,
      route: { attemptedRequests: 0 },
    });
    await service.onModuleDestroy();
  });

  it('bounds Redis commands and the number of metric buckets read', async () => {
    const service = createService({ SYSTEM_WEBHOOK_SLO_WINDOW_SEC: Number.MAX_SAFE_INTEGER });

    await expect(
      service.getSnapshot({ windowSec: Number.MAX_SAFE_INTEGER }),
    ).resolves.toMatchObject({ available: true });

    const redis = Redis as unknown as jest.Mock;
    expect(redis).toHaveBeenCalledWith('redis://localhost:6379/0', {
      commandTimeout: 1_000,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
    });
    const pipeline = redisInstances[0]?.pipeline.mock.results[0]?.value as {
      hgetall: jest.Mock;
    };
    expect(pipeline.hgetall).toHaveBeenCalledTimes(8_641);
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
    service.recordRouteOutcome({ botId: null, outcome: 'authentication_rejected' });
    await expect(service.getSnapshot({ windowSec: 900 })).resolves.toMatchObject({
      available: true,
      route: { attemptedRequests: 0 },
    });
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
    expect(redis).toHaveBeenCalledWith('redis://localhost:6379/0', {
      commandTimeout: 1_000,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
    });
    const key = redisInstances[0]?.eval.mock.calls[0]?.[2] as string;
    expect(key).toBe('system:webhook-ingress:metrics:v1:2000:178376400');
    expect(key).not.toContain('public-bot-id');
    await service.onModuleDestroy();
  });
});
