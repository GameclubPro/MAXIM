import { WebhookRateLimitService } from './webhook-rate-limit.service';

const redisEvalMock = jest.fn();
const redisQuitMock = jest.fn().mockResolvedValue(undefined);

jest.mock('ioredis', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    eval: redisEvalMock,
    quit: redisQuitMock,
  })),
}));

describe('WebhookRateLimitService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('reserves burst and rolling-window capacity in one atomic Redis call', async () => {
    redisEvalMock.mockResolvedValue([1, 1, 1]);
    const service = new WebhookRateLimitService({
      getOrThrow: jest.fn(() => 'redis://localhost:6379/0'),
      get: jest.fn((_key: string, fallback?: number) => fallback),
    } as never);

    await expect(service.isAllowed('127.0.0.1')).resolves.toBe(true);

    expect(redisEvalMock).toHaveBeenCalledTimes(1);
    expect(redisEvalMock.mock.calls[0]?.[0]).toContain('MAXIM_WEBHOOK_RATE_LIMIT_V1');
    expect(redisEvalMock.mock.calls[0]?.slice(1)).toEqual([
      2,
      expect.stringMatching(/^webhook:rps:global:/u),
      expect.stringMatching(/^webhook:rps:avg:/u),
      2,
      21,
      450,
      6_000,
    ]);

    await service.onModuleDestroy();
  });

  it('falls back to in-memory counters when Redis is unavailable', async () => {
    redisEvalMock.mockRejectedValue(new Error('redis unavailable'));
    const service = new WebhookRateLimitService({
      getOrThrow: jest.fn(() => 'redis://localhost:6379/0'),
      get: jest.fn((key: string, fallback?: number) => {
        if (key === 'WEBHOOK_GLOBAL_RPS_LIMIT') {
          return 2;
        }
        if (key === 'WEBHOOK_BURST_LIMIT') {
          return 2;
        }
        return fallback;
      }),
    } as never);

    await expect(service.isAllowed('127.0.0.1')).resolves.toBe(true);
    await expect(service.isAllowed('127.0.0.1')).resolves.toBe(true);
    await expect(service.isAllowed('127.0.0.1')).resolves.toBe(false);

    await service.onModuleDestroy();
    expect(redisQuitMock).toHaveBeenCalled();
  });
});
