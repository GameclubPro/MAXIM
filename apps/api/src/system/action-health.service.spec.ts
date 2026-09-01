import { ActionHealthService } from './action-health.service';

type RedisHashes = Map<string, Record<string, string>>;
type PipelineCommand = { kind: 'hincrby' | 'pexpire' | 'hmget'; args: unknown[] };

const redisInstances: Array<{
  hashes: RedisHashes;
  pipeline: jest.Mock;
  quit: jest.Mock<Promise<void>, []>;
}> = [];

function createPipeline(hashes: RedisHashes) {
  const commands: PipelineCommand[] = [];
  const pipeline = {
    commands,
    hincrby: (...args: [string, string, number]) => pipelineImpl.hincrby(...args),
    pexpire: (...args: [string, number]) => pipelineImpl.pexpire(...args),
    hmget: (...args: [string, ...string[]]) => pipelineImpl.hmget(...args),
    exec: () => pipelineImpl.exec(),
  };
  const pipelineImpl = {
    hincrby: jest.fn((...args: [string, string, number]) => {
      commands.push({ kind: 'hincrby', args });
      return pipeline;
    }),
    pexpire: jest.fn((...args: [string, number]) => {
      commands.push({ kind: 'pexpire', args });
      return pipeline;
    }),
    hmget: jest.fn((...args: [string, ...string[]]) => {
      commands.push({ kind: 'hmget', args });
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
        if (command.kind === 'hmget') {
          const [key, ...fields] = command.args as [string, ...string[]];
          const current = hashes.get(key) ?? {};
          return [null, fields.map((field) => current[field] ?? null)] as const;
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
    const instance = {
      hashes,
      pipeline: jest.fn(() => createPipeline(hashes)),
      quit: jest.fn().mockResolvedValue(undefined),
    };
    redisInstances.push(instance);
    return instance;
  }),
}));

function createConfigMock() {
  return {
    getOrThrow: jest.fn((key: string) => {
      if (key === 'REDIS_URL') {
        return 'redis://localhost:6379/0';
      }
      throw new Error(`Missing key ${key}`);
    }),
  };
}

describe('ActionHealthService', () => {
  beforeEach(() => {
    redisInstances.length = 0;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('aggregates shared counters across scopes and refreshes bot-specific snapshots', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-30T20:00:00.000Z'));
    const service = new ActionHealthService(createConfigMock() as never);
    const nowMs = Date.now();

    service.recordSuccess('bot-a', nowMs);
    service.recordSuccess('bot-a', nowMs + 10);
    service.recordFailure(true, 'bot-a', nowMs + 20);
    service.recordFailure(false, 'bot-b', nowMs + 30);

    await Promise.resolve();
    await service.refreshSnapshots(60, ['bot-a', 'bot-b']);

    expect(service.getSnapshot(60)).toEqual({
      windowSec: 60,
      total: 4,
      success: 2,
      failure: 2,
      critical: 1,
      errorRate: 0.5,
      criticalRate: 0.25,
    });
    expect(service.getSnapshot(60, 'bot-a')).toEqual({
      windowSec: 60,
      total: 3,
      success: 2,
      failure: 1,
      critical: 1,
      errorRate: 1 / 3,
      criticalRate: 1 / 3,
    });
    expect(service.getSnapshot(60, 'bot-b')).toEqual({
      windowSec: 60,
      total: 1,
      success: 0,
      failure: 1,
      critical: 0,
      errorRate: 1,
      criticalRate: 0,
    });

    await service.onModuleDestroy();
  });

  it('reuses fresh shared snapshots without another redis refresh', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-30T20:00:00.000Z'));
    const service = new ActionHealthService(createConfigMock() as never);
    const nowMs = Date.now();

    service.recordSuccess('bot-a', nowMs);

    await Promise.resolve();

    const redisInstance = redisInstances[0];
    expect(redisInstance).toBeDefined();
    const pipelineCallsBeforeRefresh = redisInstance!.pipeline.mock.calls.length;

    await service.refreshSnapshots(60, ['bot-a']);
    const pipelineCallsAfterFirstRefresh = redisInstance!.pipeline.mock.calls.length;
    expect(pipelineCallsAfterFirstRefresh).toBeGreaterThan(pipelineCallsBeforeRefresh);

    await service.refreshSnapshots(60, ['bot-a']);
    expect(redisInstance!.pipeline.mock.calls.length).toBe(pipelineCallsAfterFirstRefresh);

    await service.onModuleDestroy();
  });

  it('surfaces command-level shared counter write failures', async () => {
    const service = new ActionHealthService(createConfigMock() as never);
    const redisInstance = redisInstances[0];
    expect(redisInstance).toBeDefined();
    const failedPipeline = createPipeline(redisInstance!.hashes);
    failedPipeline.exec = jest
      .fn()
      .mockResolvedValue([[new Error('simulated command failure'), null]]);
    redisInstance!.pipeline.mockReturnValueOnce(failedPipeline);
    const warnSpy = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);

    service.recordSuccess();
    await Promise.resolve();
    await Promise.resolve();

    expect(warnSpy).toHaveBeenCalledWith(
      { err: 'simulated command failure' },
      'Failed to persist shared action health counters',
    );

    await service.onModuleDestroy();
  });

  it('does not cache partial shared snapshots after a command-level read failure', async () => {
    const service = new ActionHealthService(createConfigMock() as never);
    const redisInstance = redisInstances[0];
    expect(redisInstance).toBeDefined();
    const failedPipeline = createPipeline(redisInstance!.hashes);
    failedPipeline.exec = jest
      .fn()
      .mockResolvedValue([[new Error('simulated read failure'), null]]);
    redisInstance!.pipeline.mockReturnValueOnce(failedPipeline);
    const warnSpy = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);

    await service.refreshSnapshots(60);

    expect(warnSpy).toHaveBeenCalledWith(
      { err: 'simulated read failure' },
      'Failed to refresh shared action health snapshot',
    );
    expect((service as any).sharedSnapshotCache.size).toBe(0);

    await service.onModuleDestroy();
  });

  it('reads and writes only v2 rollout buckets after contraction', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-30T20:00:59.000Z'));
    const service = new ActionHealthService(createConfigMock() as never);
    const redisInstance = redisInstances[0];
    expect(redisInstance).toBeDefined();
    const firstSec = Math.floor(Date.now() / 1_000);
    redisInstance!.hashes.set('system:action-health:v1:global', {
      [`success:${firstSec}`]: '1',
    });

    service.recordSuccess(null, Date.now());
    service.recordFailure(false, null, Date.now() + 2_000);
    await Promise.resolve();

    const globalBucketKeys = [...redisInstance!.hashes.keys()]
      .filter((key) => key.startsWith('system:action-health:v2:global:minute:'))
      .sort();
    expect(globalBucketKeys).toHaveLength(2);
    expect(globalBucketKeys[0]).not.toBe(globalBucketKeys[1]);
    expect(
      globalBucketKeys.every(
        (key) => Object.keys(redisInstance!.hashes.get(key) ?? {}).length <= 3 * 60,
      ),
    ).toBe(true);

    const writeCommands = redisInstance!.pipeline.mock.results
      .slice(0, 2)
      .flatMap((result) => (result.value as { commands: PipelineCommand[] }).commands);
    expect(writeCommands.filter((command) => command.kind === 'pexpire')).toHaveLength(4);
    expect(
      writeCommands
        .filter((command) => command.kind === 'pexpire')
        .every((command) => command.args[1] === 180_000),
    ).toBe(true);
    const counterWriteCommands = writeCommands.filter((command) => command.kind === 'hincrby');
    expect(counterWriteCommands).toHaveLength(4);
    expect(
      counterWriteCommands.every((command) =>
        String(command.args[0]).startsWith('system:action-health:v2:'),
      ),
    ).toBe(true);

    jest.setSystemTime(new Date('2026-03-30T20:01:01.000Z'));
    await service.refreshSnapshots(60);
    const readCommands = (
      redisInstance!.pipeline.mock.results.at(-1)?.value as { commands: PipelineCommand[] }
    ).commands.filter((command) => command.kind === 'hmget');
    expect(readCommands).toHaveLength(8);
    expect(
      readCommands.every((command) =>
        String(command.args[0]).startsWith('system:action-health:v2:'),
      ),
    ).toBe(true);
    expect(service.getSnapshot(60)).toEqual({
      windowSec: 60,
      total: 2,
      success: 1,
      failure: 1,
      critical: 0,
      errorRate: 0.5,
      criticalRate: 0,
    });

    await service.onModuleDestroy();
  });
});
