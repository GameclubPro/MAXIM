import { VkApiClientService } from './vk-api-client.service';
import { VkApiRequestError } from './vk-parsing-errors';

describe('VkApiClientService transport', () => {
  const originalFetch = global.fetch;
  const metrics = {
    reserveVkApiSlot: jest.fn().mockResolvedValue(undefined),
    recordVkApiOutcome: jest.fn().mockResolvedValue(undefined),
  };

  function createService(config: Record<string, unknown> = {}) {
    return new VkApiClientService(
      {
        get: (key: string) =>
          ({ VK_SERVICE_TOKEN: 'test-token', VK_API_MAX_ATTEMPTS: 1, ...config })[key],
      } as never,
      metrics as never,
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });
  afterEach(() => {
    global.fetch = originalFetch;
    jest.useRealTimers();
  });

  it('preserves a safe machine-readable error code across HTTP', () => {
    const error = new VkApiRequestError('VK requires captcha', 'vk_14', false);
    expect(error.getResponse()).toEqual({
      statusCode: 503,
      message: 'VK requires captcha',
      code: 'VK_API_VK_14',
      retryable: false,
    });
    expect(error.code).toBe('vk_14');
  });

  it('keeps the abort deadline active while reading the response body', async () => {
    global.fetch = jest.fn(
      async (_url, options) =>
        ({
          ok: true,
          json: () =>
            new Promise((_resolve, reject) => {
              options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
                once: true,
              });
            }),
        }) as Response,
    );
    const result = expect(
      createService({ VK_API_TIMEOUT_MS: 100 }).request('wall.get', {}),
    ).rejects.toMatchObject({ code: 'timeout', retryable: true });
    await jest.advanceTimersByTimeAsync(100);
    await result;
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each([401, 403, 404, 429, 500, 503])(
    'classifies HTTP %i before parsing an HTML error body',
    async (status) => {
      const response = new Response('<html>error</html>', { status });
      global.fetch = jest.fn().mockResolvedValue(response);
      await expect(createService().request('wall.get', {})).rejects.toMatchObject({
        code: `http_${status}`,
        retryable: status === 429 || status >= 500,
      });
      expect(response.body?.locked).toBe(false);
    },
  );

  it.each([{}, null, { response: null }, { unexpected: [] }])(
    'rejects missing response envelopes: %j',
    async (payload) => {
      global.fetch = jest.fn().mockResolvedValue(Response.json(payload));
      await expect(createService().request('wall.get', {})).rejects.toMatchObject({
        code: 'invalid_response',
      });
      expect(metrics.recordVkApiOutcome).not.toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'success' }),
      );
    },
  );

  it('keeps the token in the authorization header and accepts an empty successful list', async () => {
    global.fetch = jest.fn().mockResolvedValue(Response.json({ response: [] }));
    await expect(createService().request('wall.getById', { posts: '-1_2' })).resolves.toEqual([]);
    const [url, options] = (global.fetch as jest.Mock).mock.calls[0]!;
    expect(url).not.toContain('test-token');
    expect(options.headers.Authorization).toBe('Bearer test-token');
    expect(jest.getTimerCount()).toBe(0);
  });

  it('bounds all attempts by one request deadline', async () => {
    global.fetch = jest.fn(
      async (_url, options) =>
        new Promise<Response>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        }),
    );
    const result = expect(
      createService({ VK_API_MAX_ATTEMPTS: 5 }).request('wall.get', {}),
    ).rejects.toMatchObject({ code: 'timeout' });
    await jest.advanceTimersByTimeAsync(20_000);
    await result;
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(0);
  });
});
