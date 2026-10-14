import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import {
  MAX_API_EXTERNAL_COOLDOWN_SCRIPT,
  MAX_API_RATE_LIMIT_RESERVATION_SCRIPT,
} from './max-client.service';

const redisUrl = process.env.MAXIM_TEST_REDIS_URL;
const describeRedis = redisUrl ? describe : describe.skip;

describeRedis('MAX external cooldown atomic admission', () => {
  let redis: Redis;
  const key = `test:publication-cooldown:${randomUUID()}`;
  beforeAll(async () => {
    redis = new Redis(redisUrl!);
    await redis.ping();
  });
  afterAll(async () => {
    if (redis) {
      await redis.del(key, `${key}:cooldown`, `${key}:other`);
      await redis.quit();
    }
  });

  it('shares cooldown across callers, preserves longer waits and isolates another token', async () => {
    const reserve = (scope: string) =>
      redis.eval(MAX_API_RATE_LIMIT_RESERVATION_SCRIPT, 1, scope, '30', '29', '2000');
    expect(await reserve(key)).toEqual([1, 0, 0]);
    await redis.eval(MAX_API_EXTERNAL_COOLDOWN_SCRIPT, 1, `${key}:cooldown`, '60000');
    const originalTat = await redis.get(key);
    await redis.eval(MAX_API_EXTERNAL_COOLDOWN_SCRIPT, 1, `${key}:cooldown`, '1000');
    const rejected = (await reserve(key)) as number[];
    expect(rejected[0]).toBe(0);
    expect(rejected[2]).toBeGreaterThan(50_000);
    expect(await redis.get(key)).toBe(originalTat);
    expect(await reserve(`${key}:other`)).toEqual([1, 0, 0]);
    await redis.pexpire(`${key}:cooldown`, 1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await reserve(key)).toEqual([1, 0, 0]);
  });
});
