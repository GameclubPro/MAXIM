import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import {
  StatisticsAccessDemandService,
  STATISTICS_ACCESS_DEMAND_KEYS as keys,
  STATISTICS_ACCESS_DEMAND_SCRIPT as script,
  type StatisticsAccessDemand,
} from './statistics-access-demand.service';

const url = process.env.MAXIM_TEST_REDIS_URL ?? '';
const integration = url ? describe : describe.skip;
integration('statistics access mailbox on isolated Redis', () => {
  let first: Redis, second: Redis;
  let service: StatisticsAccessDemandService;
  const request = (n: number): StatisticsAccessDemand => ({
    grantId: '4cbfa456-978b-47cb-b356-672f820faafd',
    revision: 1,
    entityId: `-${n + 1}`,
    kind: 'CHAT',
  });
  beforeEach(async () => {
    if (!['localhost', '127.0.0.1'].includes(new URL(url).hostname))
      throw new Error('Isolated Redis required');
    first = new Redis(url);
    second = new Redis(url);
    await first.del(...keys);
    service = new StatisticsAccessDemandService(
      new ConfigService({
        REDIS_URL: url,
        STATISTICS_CENTRAL_ENABLED: true,
        STATISTICS_CENTRAL_MODE: 'CENTRAL',
      }),
    );
    await service.onModuleInit();
  });
  afterEach(async () => {
    await service.onModuleDestroy();
    await first.del(...keys);
    first.disconnect();
    second.disconnect();
  });
  it('atomically caps distinct outstanding requests across producers at128', async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, page) =>
        (page % 2 ? first : second).eval(
          script,
          2,
          ...keys,
          'offer',
          ...Array.from({ length: 100 }, (_, n) => JSON.stringify(request(page * 100 + n))),
        ),
      ),
    );
    expect(await first.zcard(keys[0])).toBe(128);
    expect(await first.zcard(keys[1])).toBe(128);
    expect(await first.pttl(keys[0])).toBeLessThanOrEqual(360000);
  });
  it('coalesces reads without extending their deadline and expires old demand', async () => {
    const value = request(0),
      member = JSON.stringify(value);
    await service.offer([value, value]);
    const expires = await first.zscore(keys[1], member);
    await service.offer([value]);
    expect(await first.zscore(keys[1], member)).toBe(expires);
    expect(await first.zcard(keys[0])).toBe(1);
    await first.zadd(keys[1], Date.now() - 1, member);
    expect(await service.claim()).toBeNull();
    expect(await first.zcard(keys[0])).toBe(0);
  });
  it('leases once across workers, keeps retry backoff, and fences stale completion', async () => {
    await service.offer([request(0)]);
    const claims = await Promise.all(
      [first, second].map((client) => client.eval(script, 2, ...keys, 'claim')),
    );
    expect(claims.filter((claim) => Array.isArray(claim) && claim.length === 2)).toHaveLength(1);
    const claim = claims.find((value) => Array.isArray(value) && value.length === 2) as string[];
    await service.offer([request(0)]);
    expect(await service.claim()).toBeNull();
    await first.zadd(keys[0], Number(claim[1]) + 1, claim[0]!);
    await first.eval(script, 2, ...keys, 'finish', ...claim);
    expect(await first.zcard(keys[0])).toBe(1);
    await first.eval(script, 2, ...keys, 'finish', claim[0]!, String(Number(claim[1]) + 1));
    expect(await first.zcard(keys[0])).toBe(0);
  });
  it('round trips exact grant revision and never waits for MAX or closed Redis', async () => {
    const value = { ...request(0), grantId: randomUUID(), revision: 9 };
    await service.offer([value]);
    const claim = await service.claim();
    expect(claim?.request).toEqual(value);
    await service.finish(claim!);
    expect(await service.claim()).toBeNull();
    await service.onModuleDestroy();
    const start = Date.now();
    await service.offer([value]);
    expect(await service.claim()).toBeNull();
    expect(Date.now() - start).toBeLessThan(100);
  });
});
