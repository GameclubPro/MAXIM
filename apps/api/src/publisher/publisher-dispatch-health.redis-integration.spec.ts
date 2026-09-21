import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import {
  buildPublisherDispatchPauseKey,
  PublisherDispatchHealthService,
} from './publisher-dispatch-health.service';

const redisUrl = process.env.MAXIM_TEST_REDIS_URL?.trim() ?? '';
const isLocalRedis = (() => {
  try {
    const url = new URL(redisUrl);
    return url.protocol === 'redis:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
})();
const describeLocalRedis = isLocalRedis ? describe : describe.skip;

describeLocalRedis('Publisher dispatch pause ordering with Redis', () => {
  let redis: Redis;
  let service: PublisherDispatchHealthService;
  let key: string;

  beforeAll(async () => {
    redis = new Redis(redisUrl, {
      lazyConnect: true,
      connectTimeout: 1_000,
      commandTimeout: 1_000,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
    });
    await redis.connect();
  });

  beforeEach(() => {
    const botId = `publisher-test-${randomUUID()}`;
    key = buildPublisherDispatchPauseKey(botId);
    service = new PublisherDispatchHealthService(
      { get: (name: string) => (name === 'MAX_PUBLISHER_BOT_ID' ? botId : undefined) } as never,
      {} as never,
      {} as never,
      redis,
    );
  });

  afterEach(async () => {
    await redis.del(key);
    service.onModuleDestroy();
  });

  afterAll(async () => {
    await redis?.quit();
  });

  it.each([false, true])(
    'keeps the newest failure when writes arrive out of order (operator=%s)',
    async (operator) => {
      if (operator) {
        await redis.set(
          key,
          JSON.stringify({ version: 1, reason: 'operator_rollout', owner: 'test' }),
        );
      }
      await service.recordGlobalIdentityAttestationFailure(
        'identity_mismatch',
        null,
        new Date(3_000),
      );
      await service.recordGlobalAuthorizationFailure(new Date(1_000));
      await service.recordAuthenticatedSuccess(new Date(2_000));

      const raw = await redis.get(key);
      expect(raw).not.toBeNull();
      const pause = JSON.parse(raw!);
      const failure = operator ? JSON.parse(pause.preservedPauseRaw) : pause;
      expect(failure).toMatchObject({ reason: 'identity_mismatch', observedAtMs: 3_000 });
      await expect(service.assertDispatchAllowed()).rejects.toMatchObject({
        code: 'PUBLISHER_DISPATCH_PAUSED',
      });

      await service.recordAuthenticatedSuccess(new Date(4_000));
      if (operator) {
        expect(JSON.parse((await redis.get(key))!)).toEqual({
          version: 1,
          reason: 'operator_rollout',
          owner: 'test',
        });
      } else {
        await expect(service.assertDispatchAllowed()).resolves.toBeUndefined();
      }
    },
  );

  it('does not let an equal-time success clear the latest failure', async () => {
    await service.recordGlobalAuthorizationFailure(new Date(3_000));
    await service.recordGlobalAuthorizationFailure(new Date(1_000));
    await service.recordAuthenticatedSuccess(new Date(3_000));
    await expect(service.assertDispatchAllowed()).rejects.toMatchObject({
      code: 'PUBLISHER_DISPATCH_PAUSED',
    });
  });

  it('replaces an older failure with a newer one', async () => {
    await service.recordGlobalAuthorizationFailure(new Date(1_000));
    await service.recordGlobalAuthorizationFailure(new Date(3_000));
    expect(JSON.parse((await redis.get(key))!)).toMatchObject({ observedAtMs: 3_000 });
  });
});
