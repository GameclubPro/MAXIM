import { ConfigService } from '@nestjs/config';
import Redis, { type RedisOptions } from 'ioredis';
import {
  OCR_READINESS_CACHE_MS,
  OCR_READINESS_KEY,
  OCR_READINESS_MAX_BYTES,
  OCR_READINESS_TTL_MS,
  OcrReadinessStateService,
  parseOcrReadinessHeartbeat,
  type OcrReadinessHeartbeat,
} from './ocr-readiness-state.service';

jest.mock('ioredis', () => ({ __esModule: true, default: jest.fn() }));
const mockRedis = jest.mocked<new (url: string, options: RedisOptions) => Redis>(Redis);

const now = Date.parse('2026-10-29T10:00:00.000Z');
const heartbeat = (overrides: Partial<OcrReadinessHeartbeat> = {}): OcrReadinessHeartbeat => ({
  version: 1,
  serviceName: 'api-media-analysis',
  bootId: '00000000-0000-4000-8000-000000000001',
  observedAt: new Date(now).toISOString(),
  mode: 'on',
  ready: true,
  identityVerified: true,
  ...overrides,
});

describe('OCR readiness heartbeat boundary', () => {
  it.each(['off', 'shadow', 'on'] as const)('accepts the explicit %s rollout ceiling', (mode) => {
    expect(parseOcrReadinessHeartbeat(JSON.stringify(heartbeat({ mode })), now, 15_000)).toEqual({
      value: heartbeat({ mode }),
      expiresAtMs: now + 15_000,
    });
  });

  it.each([
    ['old observation', { observedAt: new Date(now - 15_000).toISOString() }],
    ['future observation', { observedAt: new Date(now + 5_001).toISOString() }],
    ['unknown version', { version: 2 }],
    ['wrong role', { serviceName: 'api-admin' }],
    ['unknown mode', { mode: 'maybe' }],
    ['unknown fields', { diagnostics: {} }],
    ['unverified ready state', { identityVerified: false }],
    ['missing owner identity', { bootId: '' }],
  ])('rejects %s', (_name, overrides) => {
    expect(
      parseOcrReadinessHeartbeat(JSON.stringify({ ...heartbeat(), ...overrides }), now, 15_000),
    ).toBeNull();
  });

  it.each([0, -1, 15_001, 1.5, Number.NaN])('rejects invalid Redis lease %s', (ttl) => {
    expect(parseOcrReadinessHeartbeat(JSON.stringify(heartbeat()), now, ttl)).toBeNull();
  });

  it('bounds bytes, malformed JSON and expiry by both the observation and Redis lease', () => {
    expect(parseOcrReadinessHeartbeat('{', now, 15_000)).toBeNull();
    expect(
      parseOcrReadinessHeartbeat('x'.repeat(OCR_READINESS_MAX_BYTES + 1), now, 15_000),
    ).toBeNull();
    expect(parseOcrReadinessHeartbeat(JSON.stringify(heartbeat()), Number.NaN, 15_000)).toBeNull();
    expect(
      parseOcrReadinessHeartbeat(
        JSON.stringify(heartbeat({ observedAt: new Date(now - 14_000).toISOString() })),
        now,
        15_000,
      )?.expiresAtMs,
    ).toBe(now + 1_000);
    expect(parseOcrReadinessHeartbeat(JSON.stringify(heartbeat()), now, 100)?.expiresAtMs).toBe(
      now + 100,
    );
  });
});

describe('OCR readiness state transport', () => {
  function fixture() {
    const redis = {
      status: 'wait' as Redis['status'],
      connect: jest.fn(async () => {
        redis.status = 'ready';
      }),
      on: jest.fn(),
      disconnect: jest.fn(),
      eval: jest.fn().mockResolvedValue(['value', JSON.stringify(heartbeat()), 15_000]),
      set: jest.fn().mockResolvedValue('OK'),
    } satisfies Pick<Redis, 'status' | 'connect' | 'on' | 'disconnect' | 'eval' | 'set'>;
    mockRedis.mockImplementation(() => redis as unknown as Redis);
    const service = new OcrReadinessStateService(
      new ConfigService({ REDIS_URL: 'redis://localhost:1' }),
    );
    return { redis, service };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers({ now });
  });
  afterEach(() => jest.useRealTimers());

  it('coalesces reads and retains a bounded cache without rechecking Redis', async () => {
    const { redis, service } = fixture();
    expect(await Promise.all([service.read(), service.read(), service.read()])).toEqual([
      heartbeat(),
      heartbeat(),
      heartbeat(),
    ]);
    expect(redis.connect).toHaveBeenCalledTimes(1);
    expect(redis.eval).toHaveBeenCalledTimes(1);
    jest.setSystemTime(now + OCR_READINESS_CACHE_MS - 1);
    expect(await service.read()).toEqual(heartbeat());
    expect(redis.eval).toHaveBeenCalledTimes(1);
    jest.setSystemTime(now + OCR_READINESS_CACHE_MS);
    expect(await service.read()).toEqual(heartbeat());
    expect(redis.eval).toHaveBeenCalledTimes(2);
    const options = mockRedis.mock.calls[0]![1];
    expect(options).toMatchObject({
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 1_000,
      commandTimeout: 1_000,
    });
    expect(options.retryStrategy?.(1)).toBeNull();
    service.onApplicationShutdown();
  });

  it.each([
    ['Redis lease', heartbeat(), 100, 100],
    ['observation', heartbeat({ observedAt: new Date(now - 14_000).toISOString() }), 15_000, 1_000],
  ] as const)('does not renew the cached %s', async (_name, value, ttl, elapsed) => {
    const { redis, service } = fixture();
    redis.eval
      .mockResolvedValueOnce(['value', JSON.stringify(value), ttl])
      .mockResolvedValue(['missing']);
    expect(await service.read()).toEqual(value);
    jest.setSystemTime(now + elapsed - 1);
    expect(await service.read()).toEqual(value);
    expect(redis.eval).toHaveBeenCalledTimes(1);
    jest.setSystemTime(now + elapsed);
    expect(await service.read()).toBeNull();
    expect(redis.eval).toHaveBeenCalledTimes(2);
    service.onApplicationShutdown();
  });

  it('counts transport time against the lease and stops in-flight readers during shutdown', async () => {
    const { redis, service } = fixture();
    let release!: (value: unknown) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    redis.eval.mockImplementationOnce(() => {
      markStarted();
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    const reading = service.read();
    await started;
    jest.setSystemTime(now + 101);
    release(['value', JSON.stringify(heartbeat()), 100]);
    expect(await reading).toBeNull();

    jest.setSystemTime(now + 3_000);
    const nextRead = service.read();
    service.onApplicationShutdown();
    expect(await nextRead).toBeNull();
    expect(await service.read()).toBeNull();
    expect(redis.disconnect).toHaveBeenCalledWith(false);
  });

  it('returns only unavailable on credential-bearing errors and retries after a failed connection', async () => {
    const { redis, service } = fixture();
    redis.connect.mockRejectedValueOnce(new Error('redis://user:secret@private.example'));
    expect(await service.read()).toBeNull();
    jest.setSystemTime(now + OCR_READINESS_CACHE_MS);
    expect(await service.read()).toEqual(heartbeat());
    expect(redis.connect).toHaveBeenCalledTimes(2);
    redis.eval.mockRejectedValueOnce(new Error('redis://user:secret@private.example'));
    jest.setSystemTime(now + 2 * OCR_READINESS_CACHE_MS);
    expect(await service.read()).toBeNull();
    service.onApplicationShutdown();
  });

  it('publishes one expiring value and releases only the bounded owner identity', async () => {
    const { redis, service } = fixture();
    await service.publish(heartbeat());
    expect(redis.set).toHaveBeenCalledWith(
      OCR_READINESS_KEY,
      JSON.stringify(heartbeat()),
      'PX',
      OCR_READINESS_TTL_MS,
    );
    await service.release(heartbeat().bootId);
    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining('current.bootId ~= ARGV[1]'),
      1,
      OCR_READINESS_KEY,
      heartbeat().bootId,
      OCR_READINESS_MAX_BYTES,
    );
    service.onApplicationShutdown();
    await expect(service.publish(heartbeat())).rejects.toThrow('stopping');
    await expect(service.release(heartbeat().bootId)).resolves.toBeUndefined();
  });
});
