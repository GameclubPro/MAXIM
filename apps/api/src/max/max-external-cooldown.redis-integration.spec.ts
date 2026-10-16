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
      await redis.del(
        key,
        `${key}:cooldown`,
        `${key}:other`,
        `${key}:window:v1`,
        `${key}:other:window:v1`,
      );
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

describeRedis('MAX token rolling-second admission', () => {
  let redis: Redis;
  let peer: Redis;
  let keys: string[];
  beforeAll(async () => {
    redis = new Redis(redisUrl!);
    peer = new Redis(redisUrl!);
    await Promise.all([redis.ping(), peer.ping()]);
  });
  beforeEach(() => {
    const prefix = `test:max-token-window:${randomUUID()}`;
    keys = [`${prefix}:token`, `${prefix}:class`, `${prefix}:other`];
  });
  afterEach(async () => {
    await redis.del(...keys.flatMap((key) => [key, `${key}:window:v1`, `${key}:cooldown`]));
  });
  afterAll(async () => {
    await Promise.all([redis?.quit(), peer?.quit()]);
  });

  // Run the production Lua against real Redis with a deterministic clock inside one
  // atomic script, so runner pauses cannot disguise a replenished-slot burst.
  function clockedScenario(body: string): Promise<unknown> {
    const clock = "local time = redis.call('TIME')";
    expect(MAX_API_RATE_LIMIT_RESERVATION_SCRIPT.split(clock)).toHaveLength(2);
    return redis.eval(
      `local function reserve(KEYS, ARGV, time)\n${MAX_API_RATE_LIMIT_RESERVATION_SCRIPT.replace(clock, '')}\nend\n${body}`,
      keys.length,
      ...keys,
    );
  }

  it('keeps the initial burst but rejects replenishment until the original second ends', async () => {
    const result = await clockedScenario(`
      local args = {'30', '29', '2000'}
      local scope = {KEYS[1]}
      local admitted = 0
      for i=1,30 do admitted = admitted + reserve(scope, args, {1700000000, 0})[1] end
      local tat = redis.call('GET', KEYS[1])
      local blocked = reserve(scope, args, {1700000000, 400000})
      local unchanged = tat == redis.call('GET', KEYS[1])
      local independent = reserve({KEYS[3]}, args, {1700000000, 400000})
      local resumed = reserve(scope, args, {1700000001, 0})
      return {admitted, blocked, unchanged and 1 or 0, independent, resumed,
        redis.call('ZCARD', KEYS[1] .. ':window:v1')}
    `);
    expect(result).toEqual([30, [0, 1, 600], 1, [1, 0, 0], [1, 0, 0], 1]);
  });

  it('does not burn the token window when another dimension refuses admission', async () => {
    const result = await clockedScenario(`
      local scope = {KEYS[1], KEYS[2]}
      local args = {'30', '1', '29', '0', '2000'}
      local first = reserve(scope, args, {1700000000, 0})
      local tat = redis.call('GET', KEYS[1])
      local blocked = reserve(scope, args, {1700000000, 100000})
      return {first, blocked, tat == redis.call('GET', KEYS[1]) and 1 or 0,
        redis.call('ZCARD', KEYS[1] .. ':window:v1')}
    `);
    expect(result).toEqual([[1, 0, 0], [0, 2, 900], 1, 1]);
  });

  it('retains the configured sustained throughput without growing the window', async () => {
    const result = await clockedScenario(`
      local admitted = 0
      local maximum = 0
      for i=0,899 do
        local ms = math.ceil(i * 1000 / 30)
        local decision = reserve({KEYS[1]}, {'30', '29', '2000'},
          {1700000000 + math.floor(ms / 1000), (ms % 1000) * 1000})
        admitted = admitted + decision[1]
        maximum = math.max(maximum, redis.call('ZCARD', KEYS[1] .. ':window:v1'))
      end
      return {admitted, maximum}
    `);
    expect(result).toEqual([900, 30]);
  });

  it('honors a lower configured token quota across adjacent clock seconds', async () => {
    const result = await clockedScenario(`
      local args = {'2', '1', '2000'}
      local scope = {KEYS[1]}
      local first = reserve(scope, args, {1700000000, 900000})
      local second = reserve(scope, args, {1700000000, 900000})
      local blocked = reserve(scope, args, {1700000001, 400000})
      local resumed = reserve(scope, args, {1700000001, 900000})
      return {first, second, blocked, resumed}
    `);
    expect(result).toEqual([
      [1, 0, 0],
      [1, 0, 0],
      [0, 1, 500],
      [1, 0, 0],
    ]);
  });

  it('shares actual-clock admission across clients and retains only bounded expiring state', async () => {
    const startedAt = Date.now();
    const results = await Promise.all(
      Array.from({ length: 90 }, (_, index) =>
        (index % 2 ? peer : redis).eval(
          MAX_API_RATE_LIMIT_RESERVATION_SCRIPT,
          1,
          keys[0]!,
          '30',
          '29',
          '2000',
        ),
      ),
    );
    // This is a bounded concurrent burst; a slow/unrepresentative run must not pass.
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(results.filter((result) => (result as number[])[0] === 1)).toHaveLength(30);
    expect(await redis.zcard(`${keys[0]}:window:v1`)).toBe(30);
    expect(await redis.pttl(`${keys[0]}:window:v1`)).toBeGreaterThan(0);
    expect(await redis.pttl(`${keys[0]}:window:v1`)).toBeLessThanOrEqual(1_000);
    expect(
      await peer.eval(MAX_API_RATE_LIMIT_RESERVATION_SCRIPT, 1, keys[2]!, '30', '29', '2000'),
    ).toEqual([1, 0, 0]);
  });
});
