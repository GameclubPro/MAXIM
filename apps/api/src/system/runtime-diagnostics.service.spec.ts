import { RuntimeDiagnosticsService } from './runtime-diagnostics.service';

type RedisHashes = Map<string, Record<string, string>>;

const redisInstances: Array<{
  hashes: RedisHashes;
  strings: Map<string, string>;
  pipeline: jest.Mock;
  quit: jest.Mock<Promise<void>, []>;
}> = [];

function createPipeline(hashes: RedisHashes) {
  const commands: Array<{
    kind: 'hincrby' | 'hset' | 'hgetall' | 'expire';
    args: unknown[];
  }> = [];
  const pipeline = {
    hincrby: (...args: [string, string, number]) => pipelineImpl.hincrby(...args),
    hset: (...args: [string, string, string]) => pipelineImpl.hset(...args),
    hgetall: (...args: [string]) => pipelineImpl.hgetall(...args),
    expire: (...args: [string, number]) => pipelineImpl.expire(...args),
    exec: () => pipelineImpl.exec(),
  };
  const pipelineImpl = {
    hincrby: jest.fn((...args: [string, string, number]) => {
      commands.push({ kind: 'hincrby', args });
      return pipeline;
    }),
    hset: jest.fn((...args: [string, string, string]) => {
      commands.push({ kind: 'hset', args });
      return pipeline;
    }),
    hgetall: jest.fn((...args: [string]) => {
      commands.push({ kind: 'hgetall', args });
      return pipeline;
    }),
    expire: jest.fn((...args: [string, number]) => {
      commands.push({ kind: 'expire', args });
      return pipeline;
    }),
    exec: jest.fn(async () =>
      commands.map((command) => {
        if (command.kind === 'hincrby') {
          const [key, field, increment] = command.args as [string, string, number];
          const current = { ...(hashes.get(key) ?? {}) };
          const nextValue = Number(current[field] ?? '0') + increment;
          current[field] = String(nextValue);
          hashes.set(key, current);
          return [null, nextValue] as const;
        }
        if (command.kind === 'hset') {
          const [key, field, value] = command.args as [string, string, string];
          const current = { ...(hashes.get(key) ?? {}) };
          current[field] = value;
          hashes.set(key, current);
          return [null, 1] as const;
        }
        if (command.kind === 'hgetall') {
          const [key] = command.args as [string];
          return [null, { ...(hashes.get(key) ?? {}) }] as const;
        }
        return [null, 1] as const;
      }),
    ),
  };

  return pipeline;
}

jest.mock('ioredis', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => {
    const hashes: RedisHashes = new Map();
    const strings = new Map<string, string>();
    const instance = {
      hashes,
      strings,
      get: jest.fn(async (key: string) => strings.get(key) ?? null),
      set: jest.fn(async (key: string, value: string) => {
        strings.set(key, value);
        return 'OK';
      }),
      hget: jest.fn(async (key: string, field: string) => hashes.get(key)?.[field] ?? null),
      mget: jest.fn(async (...keys: string[]) => keys.map((key) => strings.get(key) ?? null)),
      scan: jest.fn(async () => ['0', []]),
      pipeline: jest.fn(() => createPipeline(hashes)),
      quit: jest.fn().mockResolvedValue(undefined),
    };
    redisInstances.push(instance);
    return instance;
  }),
}));

function createConfigMock(values: Record<string, string | number | undefined> = {}) {
  return {
    get: jest.fn((key: string) => values[key]),
    getOrThrow: jest.fn((key: string) => {
      if (key === 'REDIS_URL') {
        return 'redis://localhost:6379/0';
      }
      throw new Error(`Missing key ${key}`);
    }),
  };
}

describe('RuntimeDiagnosticsService', () => {
  beforeEach(() => {
    redisInstances.length = 0;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('aggregates spammer read-model rollout health counters', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-06-21T12:00:00.000Z'));
    const service = new RuntimeDiagnosticsService(
      createConfigMock({
        SYSTEM_RUNTIME_DIAGNOSTICS_SPAMMER_READ_MODEL_WINDOW_SEC: 900,
      }) as never,
    );

    await service.recordSpammerReadModelEvent({ event: 'profile_read_hit' });
    await service.recordSpammerReadModelEvent({ event: 'profile_read_hit' });
    await service.recordSpammerReadModelEvent({ event: 'profile_read_miss' });
    await service.recordSpammerReadModelEvent({ event: 'profile_read_stale' });
    await service.recordSpammerReadModelEvent({ event: 'fallback_after_profile_miss' });
    await service.recordSpammerReadModelEvent({ event: 'shadow_compared' });
    await service.recordSpammerReadModelEvent({ event: 'shadow_matched' });
    await service.recordSpammerReadModelEvent({ event: 'shadow_compared' });
    await service.recordSpammerReadModelEvent({ event: 'shadow_mismatched' });
    await service.recordSpammerReadModelEvent({ event: 'profile_write_success' });
    await service.recordSpammerReadModelEvent({ event: 'profile_write_failure' });
    await service.recordSpammerReadModelEvent({
      event: 'denorm_job_enqueued',
    });
    await service.recordSpammerReadModelEvent({
      event: 'denorm_job_enqueue_failed',
    });
    await service.recordSpammerReadModelEvent({
      event: 'denorm_fast_path_enqueued',
    });
    await service.recordSpammerReadModelEvent({
      event: 'denorm_fast_path_fallback',
    });
    await service.recordSpammerReadModelEvent({
      event: 'denorm_fast_path_replayed',
    });
    await service.recordSpammerReadModelEvent({
      event: 'denorm_fast_path_replay_missing',
    });
    await service.recordSpammerReadModelEvent({
      event: 'denorm_job_processed',
      jobAgeMs: 1_000,
    });
    await service.recordSpammerReadModelEvent({
      event: 'denorm_job_failed',
      jobAgeMs: 3_000,
    });

    const snapshot = await service.getDashboardSnapshot();

    expect(snapshot.spammerReadModel).toEqual({
      windowSec: 900,
      profileReads: {
        hits: 2,
        misses: 1,
        stale: 1,
        fallbacks: 1,
        hitRate: 0.5,
      },
      shadow: {
        compared: 2,
        matched: 1,
        mismatched: 1,
        mismatchRate: 0.5,
      },
      profileWrites: {
        success: 1,
        failure: 1,
      },
      denormJobs: {
        enqueued: 1,
        enqueueFailed: 1,
        fastPathEnqueued: 1,
        fastPathFallbacks: 1,
        fastPathReplayed: 1,
        fastPathReplayMissing: 1,
        processed: 1,
        failed: 1,
        avgAgeMs: 2_000,
        maxAgeMs: 3_000,
        lastSuccessAt: '2026-06-21T12:00:00.000Z',
        lastFailureAt: '2026-06-21T12:00:00.000Z',
      },
    });

    await service.onModuleDestroy();
  });
});
