import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import {
  OCR_READINESS_KEY,
  OCR_READINESS_MAX_BYTES,
  OCR_READINESS_TTL_MS,
  OcrReadinessStateService,
  type OcrReadinessHeartbeat,
} from './ocr-readiness-state.service';

const redisUrl = process.env.MAXIM_TEST_REDIS_URL?.trim() ?? '';
const localRedis = (() => {
  try {
    return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(new URL(redisUrl).hostname);
  } catch {
    return false;
  }
})();
const describeRedis = localRedis ? describe : describe.skip;

describeRedis('OCR runtime readiness native Redis boundary', () => {
  let inspector: Redis;
  let service: OcrReadinessStateService;
  const heartbeat = (overrides: Partial<OcrReadinessHeartbeat> = {}): OcrReadinessHeartbeat => ({
    version: 1,
    serviceName: 'api-media-analysis',
    bootId: randomUUID(),
    observedAt: new Date().toISOString(),
    mode: 'on',
    ready: true,
    identityVerified: true,
    ...overrides,
  });

  beforeAll(async () => {
    inspector = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
    await inspector.ping();
  });
  beforeEach(async () => {
    // FLAG: Only the isolated localhost test-store key is removed; never scan or flush Redis.
    await inspector.del(OCR_READINESS_KEY);
    service = new OcrReadinessStateService(new ConfigService({ REDIS_URL: redisUrl }));
  });
  afterEach(async () => {
    service.onApplicationShutdown();
    await inspector.del(OCR_READINESS_KEY);
  });
  afterAll(async () => {
    await inspector.quit();
  });

  it('reads a fresh expiring observation and never removes a replacement process owner', async () => {
    const first = heartbeat();
    await service.publish(first);
    expect(await service.read()).toEqual(first);
    expect(await inspector.pttl(OCR_READINESS_KEY)).toBeGreaterThan(0);
    expect(await inspector.pttl(OCR_READINESS_KEY)).toBeLessThanOrEqual(OCR_READINESS_TTL_MS);

    const replacement = heartbeat();
    await service.publish(replacement);
    await service.release(first.bootId);
    expect(JSON.parse((await inspector.get(OCR_READINESS_KEY))!)).toEqual(replacement);
    await service.release(replacement.bootId);
    expect(await inspector.exists(OCR_READINESS_KEY)).toBe(0);
  });

  it.each([
    'wrong-type',
    'oversized',
    'persistent',
    'overlong-lease',
    'expired-observation',
    'malformed',
  ])('rejects %s without an unbounded read or a Redis type error', async (kind) => {
    const value = heartbeat();
    if (kind === 'wrong-type') await inspector.hset(OCR_READINESS_KEY, 'field', 'value');
    else if (kind === 'oversized')
      await inspector.set(OCR_READINESS_KEY, 'x'.repeat(OCR_READINESS_MAX_BYTES + 1), 'PX', 15_000);
    else if (kind === 'persistent') await inspector.set(OCR_READINESS_KEY, JSON.stringify(value));
    else if (kind === 'overlong-lease')
      await inspector.set(OCR_READINESS_KEY, JSON.stringify(value), 'PX', 30_000);
    else if (kind === 'expired-observation')
      await inspector.set(
        OCR_READINESS_KEY,
        JSON.stringify({ ...value, observedAt: new Date(Date.now() - 15_000).toISOString() }),
        'PX',
        15_000,
      );
    else await inspector.set(OCR_READINESS_KEY, '{', 'PX', 15_000);
    expect(await service.read()).toBeNull();
    await expect(service.release(value.bootId)).resolves.toBeUndefined();
  });

  it('expires the local positive cache when the original Redis lease ends', async () => {
    const value = heartbeat();
    await inspector.set(OCR_READINESS_KEY, JSON.stringify(value), 'PX', 100);
    expect(await service.read()).toEqual(value);
    await new Promise<void>((resolve) => setTimeout(resolve, 130));
    expect(await inspector.exists(OCR_READINESS_KEY)).toBe(0);
    expect(await service.read()).toBeNull();
  });
});
