import { WebhookRateLimitService } from './webhook-rate-limit.service';

const redisExecMock = jest.fn();
const redisQuitMock = jest.fn().mockResolvedValue(undefined);

jest.mock('ioredis', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    multi: jest.fn().mockImplementation(() => {
      const pipeline = {} as {
        incr: jest.Mock;
        expire: jest.Mock;
        exec: jest.Mock;
      };
      pipeline.incr = jest.fn().mockReturnValue(pipeline);
      pipeline.expire = jest.fn().mockReturnValue(pipeline);
      pipeline.exec = redisExecMock;
      return pipeline;
    }),
    quit: redisQuitMock,
  })),
}));

describe('WebhookRateLimitService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('falls back to in-memory counters when Redis is unavailable', async () => {
    redisExecMock.mockRejectedValue(new Error('redis unavailable'));
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
