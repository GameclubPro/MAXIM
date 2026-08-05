import { PhotoDuplicateOrderingStore } from './photo-duplicate-ordering.store';

type RedisMock = {
  eval: jest.Mock;
  quit: jest.Mock;
};

const identity = {
  jobId: `photo-duplicate__${'a'.repeat(64)}`,
  chatId: 'chat-secret-id',
  sourceCreatedAt: '2026-08-05T12:00:00.000Z',
};

function createStore(evalResults: unknown[]) {
  const redis: RedisMock = {
    eval: jest.fn(),
    quit: jest.fn().mockResolvedValue(undefined),
  };
  for (const result of evalResults) {
    redis.eval.mockResolvedValueOnce(result);
  }

  const store = Object.create(PhotoDuplicateOrderingStore.prototype) as PhotoDuplicateOrderingStore;
  Object.defineProperties(store, {
    redis: { value: redis },
    logger: { value: { warn: jest.fn() } },
  });
  return { redis, store };
}

describe('PhotoDuplicateOrderingStore', () => {
  it('registers a pending job under chat-scoped opaque Redis keys', async () => {
    const { redis, store } = createStore([[1, 'pending-member']]);

    await expect(store.announce(identity)).resolves.toBe('registered');

    expect(redis.eval).toHaveBeenCalledTimes(1);
    const call = redis.eval.mock.calls[0] as unknown[];
    expect(call[1]).toBe(5);
    const keys = call.slice(2, 7).map(String);
    expect(keys).toHaveLength(5);
    expect(keys).toEqual([
      expect.stringMatching(/^photo-duplicate:ordering:v1:[a-f0-9]{32}:pending$/u),
      expect.stringMatching(/^photo-duplicate:ordering:v1:[a-f0-9]{32}:expiry$/u),
      expect.stringMatching(/^photo-duplicate:ordering:v1:[a-f0-9]{32}:members$/u),
      expect.stringMatching(/^photo-duplicate:ordering:v1:[a-f0-9]{32}:sequence$/u),
      expect.stringMatching(/^photo-duplicate:ordering:v1:[a-f0-9]{32}:completed$/u),
    ]);
    expect(keys.join('|')).not.toContain(identity.chatId);
    expect(keys.join('|')).not.toContain(identity.jobId);
    expect(call[7]).toBe(identity.jobId);
  });

  it('commits a claimed operation before returning its value', async () => {
    const { redis, store } = createStore([[1, 'pending-member'], 1, 1]);
    const operation = jest.fn().mockResolvedValue('completed-value');

    await expect(store.runInOrder(identity, operation)).resolves.toEqual({
      kind: 'completed',
      value: 'completed-value',
    });

    expect(operation).toHaveBeenCalledTimes(1);
    expect(operation).toHaveBeenCalledWith({ assertOwned: expect.any(Function) });
    expect(redis.eval).toHaveBeenCalledTimes(3);
    const claimCall = redis.eval.mock.calls[1] as unknown[];
    const completionCall = redis.eval.mock.calls[2] as unknown[];
    expect(claimCall[1]).toBe(4);
    expect(completionCall[1]).toBe(6);
    expect(completionCall[8]).toBe(identity.jobId);
    expect(completionCall[9]).toBe(claimCall[7]);
    expect(String(completionCall[0])).toContain("redis.call('ZADD', KEYS[5]");
  });

  it('releases its ordering lease when the claimed operation fails', async () => {
    const { redis, store } = createStore([[1, 'pending-member'], 1, 1]);
    const operationError = new Error('moderation operation failed');

    await expect(
      store.runInOrder(identity, jest.fn().mockRejectedValue(operationError)),
    ).rejects.toBe(operationError);

    expect(redis.eval).toHaveBeenCalledTimes(3);
    const claimCall = redis.eval.mock.calls[1] as unknown[];
    const releaseCall = redis.eval.mock.calls[2] as unknown[];
    expect(releaseCall[1]).toBe(1);
    expect(releaseCall[3]).toBe(claimCall[7]);
    expect(String(releaseCall[0])).toContain("redis.call('DEL', KEYS[1])");
  });
});
