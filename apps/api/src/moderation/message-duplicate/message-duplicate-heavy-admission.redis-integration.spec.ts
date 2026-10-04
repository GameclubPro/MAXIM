import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { setTimeout as delay } from 'node:timers/promises';
import { RedisCounterService } from '../redis-counter.service';
import { MESSAGE_DUPLICATE_HEAVY_ADMISSION_KEY } from './message-duplicate-heavy-admission';

const redisUrl = process.env.MAXIM_TEST_REDIS_URL ?? '';
const localRedis = /^redis:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(redisUrl);

(localRedis ? describe : describe.skip)('shared duplicate heavy admission with real Redis', () => {
  let inspector: Redis;
  let workers: RedisCounterService[];

  beforeEach(async () => {
    inspector = new Redis(redisUrl);
    workers = Array.from(
      { length: 2 },
      () => new RedisCounterService(new ConfigService({ REDIS_URL: redisUrl })),
    );
    await inspector.del(MESSAGE_DUPLICATE_HEAVY_ADMISSION_KEY);
  });

  afterEach(async () => {
    await inspector.del(MESSAGE_DUPLICATE_HEAVY_ADMISSION_KEY);
    await Promise.all(workers.map((worker) => worker.onModuleDestroy()));
    await inspector.quit();
  });

  const input = () => ({
    eligibleAtMs: Date.now() - 10_000,
    intervalMs: 1000,
    deadlineAtMs: Date.now() + 15_000,
  });

  it('grants exactly one simultaneous contender when a shared slot becomes ready', async () => {
    const cold = await workers[0]!.admitDuplicateHeavyStart(input());
    if (cold.kind !== 'deferred') throw new Error('Expected cold interval');
    await delay(Math.max(1, cold.retryAtMs - Date.now() + 10));
    const contenders = await Promise.all(
      Array.from({ length: 24 }, (_, index) =>
        workers[index % 2]!.admitDuplicateHeavyStart(input()),
      ),
    );
    expect(contenders.filter((result) => result.kind === 'granted')).toHaveLength(1);
    expect(contenders.filter((result) => result.kind === 'deferred')).toHaveLength(23);
  });

  it('paces sustained hot/calm competition across workers without a burst or reused permit', async () => {
    const baseline = await workers[0]!.admitDuplicateHeavyStart(input());
    expect(baseline.kind).toBe('deferred');
    if (baseline.kind !== 'deferred') throw new Error('Expected cold interval');
    let dueAt = baseline.retryAtMs;
    const launches: Array<{ kind: 'hot' | 'calm'; at: number }> = [];
    for (let cycle = 0; cycle < 4; cycle += 1) {
      await delay(Math.max(1, dueAt - Date.now() + 10));
      const firstKind = cycle % 2 ? 'calm' : 'hot';
      const first = await workers[cycle % 2]!.admitDuplicateHeavyStart(input());
      expect(first.kind).toBe('granted');
      if (first.kind !== 'granted') throw new Error('Expected one start');
      launches.push({ kind: firstKind, at: first.startedAtMs });
      // A hot burst and calm contender use the same slot. Successful-response replay
      // also consumes a fresh interval rather than reusing a historical grant.
      const followers = await Promise.all(
        Array.from({ length: 21 }, (_, index) =>
          workers[index % 2]!.admitDuplicateHeavyStart(input()),
        ),
      );
      expect(followers.every((result) => result.kind === 'deferred')).toBe(true);
      const next = followers[0]!;
      if (next.kind !== 'deferred') throw new Error('Expected paced followers');
      dueAt = next.retryAtMs;
    }
    expect(launches.filter((launch) => launch.kind === 'calm')).toHaveLength(2);
    expect(
      launches.slice(1).every((launch, index) => launch.at - launches[index]!.at >= 1000),
    ).toBe(true);
  }, 15_000);

  it('uses fresh larger slow intervals and keeps deferred reads from extending state TTL', async () => {
    const admission = await workers[0]!.admitDuplicateHeavyStart(input());
    if (admission.kind !== 'deferred') throw new Error('Expected cold interval');
    const before = await inspector.pttl(MESSAGE_DUPLICATE_HEAVY_ADMISSION_KEY);
    await delay(30);
    const slower = await workers[1]!.admitDuplicateHeavyStart({ ...input(), intervalMs: 1500 });
    expect(slower.kind).toBe('deferred');
    if (slower.kind !== 'deferred') throw new Error('Expected longer fresh pressure');
    expect(slower.retryAtMs).toBe(admission.retryAtMs + 500);
    expect(await inspector.pttl(MESSAGE_DUPLICATE_HEAVY_ADMISSION_KEY)).toBeLessThan(before);
  });

  it('rebuilds a full slow interval after eviction and never writes after the server deadline', async () => {
    const params = input();
    await workers[0]!.admitDuplicateHeavyStart(params);
    await inspector.del(MESSAGE_DUPLICATE_HEAVY_ADMISSION_KEY);
    const coldAt = Date.now();
    const cold = await workers[1]!.admitDuplicateHeavyStart(params);
    expect(cold.kind).toBe('deferred');
    if (cold.kind !== 'deferred') throw new Error('Expected restart pacing');
    expect(cold.retryAtMs).toBeGreaterThanOrEqual(coldAt + 1000);
    const state = await inspector.get(MESSAGE_DUPLICATE_HEAVY_ADMISSION_KEY);
    expect(
      await workers[0]!.admitDuplicateHeavyStart({ ...params, deadlineAtMs: Date.now() - 1 }),
    ).toEqual({ kind: 'expired' });
    expect(await inspector.get(MESSAGE_DUPLICATE_HEAVY_ADMISSION_KEY)).toBe(state);
  });

  it('fails closed on corrupt or wrong-type budget and rejects invalid client bounds', async () => {
    await inspector.set(MESSAGE_DUPLICATE_HEAVY_ADMISSION_KEY, 'corrupt');
    await expect(workers[0]!.admitDuplicateHeavyStart(input())).rejects.toThrow(
      'Invalid duplicate heavy admission state',
    );
    await inspector.del(MESSAGE_DUPLICATE_HEAVY_ADMISSION_KEY);
    await inspector.lpush(MESSAGE_DUPLICATE_HEAVY_ADMISSION_KEY, 'wrong-type');
    await expect(workers[0]!.admitDuplicateHeavyStart(input())).rejects.toThrow('WRONGTYPE');
    await expect(
      workers[0]!.admitDuplicateHeavyStart({ ...input(), intervalMs: 999 }),
    ).rejects.toThrow('Invalid duplicate heavy admission bounds');
  });
});
