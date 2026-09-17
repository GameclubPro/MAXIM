import Redis from 'ioredis';
import { VkParsingRateLimitService } from './vk-parsing-rate-limit.service';

jest.mock('ioredis', () => ({ __esModule: true, default: jest.fn() }));

describe('VkParsingRateLimitService bounded metrics', () => {
  function fixture() {
    const pipeline = {
      hgetall: jest.fn().mockReturnThis(),
      hincrby: jest.fn().mockReturnThis(),
      expire: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([]),
    };
    const redis = {
      on: jest.fn(),
      pipeline: jest.fn().mockReturnValue(pipeline),
      multi: jest.fn().mockReturnValue(pipeline),
      eval: jest.fn().mockResolvedValue([1, 0, 0]),
      scan: jest.fn(),
    };
    (Redis as unknown as jest.Mock).mockReturnValue(redis);
    const service = new VkParsingRateLimitService({
      getOrThrow: () => 'redis://localhost',
      get: () => undefined,
    } as never);
    return { service, redis, pipeline };
  }

  afterEach(() => jest.useRealTimers());

  it('reads only exact second buckets in one pipeline without scanning shared Redis', async () => {
    jest.useFakeTimers().setSystemTime(1_000_000);
    const { service, redis, pipeline } = fixture();
    pipeline.exec.mockResolvedValue([
      [null, { 'success:success': '8', 'error:vk_6': '2' }],
      [null, { 'error:vk_6': '1', 'error:network': '1', invalid: '100', 'error:bad': '-1' }],
    ]);
    await expect(service.getRecentVkApiMetrics(2)).resolves.toEqual({
      rps: 6,
      errorRate: 4 / 12,
      recentErrors: [
        { code: 'vk_6', count: 3 },
        { code: 'network', count: 1 },
      ],
    });
    expect(pipeline.hgetall.mock.calls).toEqual([
      ['vkapi:metrics:v2:1000'],
      ['vkapi:metrics:v2:999'],
    ]);
    expect(redis.scan).not.toHaveBeenCalled();
  });

  it.each([
    [1e9, 900],
    [NaN, 300],
    [0, 1],
  ])('bounds a requested window of %s seconds', async (requested, expected) => {
    const { service, pipeline } = fixture();
    await service.getRecentVkApiMetrics(requested);
    expect(pipeline.hgetall).toHaveBeenCalledTimes(expected);
  });

  it('stores counters with expiry and does not fail a VK request when metrics fail', async () => {
    jest.useFakeTimers().setSystemTime(1_000_000);
    const { service, pipeline } = fixture();
    pipeline.exec.mockResolvedValue([[new Error('metrics unavailable'), null]]);
    await expect(
      service.recordVkApiOutcome({ method: 'wall.get', outcome: 'error', code: 'vk_6' }),
    ).resolves.toBeUndefined();
    expect(pipeline.hincrby).toHaveBeenCalledWith('vkapi:metrics:v2:1000', 'error:vk_6', 1);
    expect(pipeline.expire).toHaveBeenCalledWith('vkapi:metrics:v2:1000', 21_600);
  });

  it('retries at the next rate window instead of sleeping for the key cleanup TTL', async () => {
    jest.useFakeTimers().setSystemTime(1_000_900);
    const { service, redis } = fixture();
    redis.eval.mockResolvedValueOnce([0, 1, 2_000]);
    const reserved = service.reserveVkApiSlot('wall.get');
    await jest.advanceTimersByTimeAsync(100);
    await reserved;
    expect(redis.eval).toHaveBeenCalledTimes(2);
  });

  it('fails fast on Redis failures rather than queueing indefinitely', () => {
    fixture();
    expect(Redis).toHaveBeenLastCalledWith(
      'redis://localhost',
      expect.objectContaining({
        commandTimeout: 1_000,
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
      }),
    );
  });
});
