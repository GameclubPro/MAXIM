import {
  PhotoDuplicateOrderingLeaseLostError,
  PhotoDuplicateOrderingStore,
  PhotoDuplicateOrderingUnavailableError,
} from './photo-duplicate-ordering.store';

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
  it('registers a pending job and its latch under chat-scoped opaque Redis keys', async () => {
    const { redis, store } = createStore([[1, 'pending-member', '1']]);

    await expect(store.announce(identity, true)).resolves.toEqual({
      kind: 'registered',
      actionEligible: true,
    });

    expect(redis.eval).toHaveBeenCalledTimes(1);
    const call = redis.eval.mock.calls[0] as unknown[];
    expect(call[1]).toBe(6);
    const keys = call.slice(2, 8).map(String);
    expect(keys).toHaveLength(6);
    expect(keys).toEqual([
      expect.stringMatching(/^photo-duplicate:ordering:v2:[a-f0-9]{32}:pending$/u),
      expect.stringMatching(/^photo-duplicate:ordering:v2:[a-f0-9]{32}:expiry$/u),
      expect.stringMatching(/^photo-duplicate:ordering:v2:[a-f0-9]{32}:members$/u),
      expect.stringMatching(/^photo-duplicate:ordering:v2:[a-f0-9]{32}:sequence$/u),
      expect.stringMatching(/^photo-duplicate:ordering:v2:[a-f0-9]{32}:completed$/u),
      expect.stringMatching(/^photo-duplicate:ordering:v2:[a-f0-9]{32}:action-eligibility$/u),
    ]);
    expect(keys.join('|')).not.toContain(identity.chatId);
    expect(keys.join('|')).not.toContain(identity.jobId);
    expect(call[8]).toBe(identity.jobId);
    expect(call[12]).toBe('1');
    expect(String(call[0])).toContain("redis.call('HDEL', KEYS[6], job_id)");
  });

  it('keeps a true-false-true replay sequence observation-only once downgraded', async () => {
    const { redis, store } = createStore([
      [1, 'pending-member', '1'],
      [1, 'pending-member', '0'],
      [1, 'pending-member', '0'],
    ]);

    await expect(store.announce(identity, true)).resolves.toEqual({
      kind: 'registered',
      actionEligible: true,
    });
    await expect(store.announce(identity, false)).resolves.toEqual({
      kind: 'registered',
      actionEligible: false,
    });
    await expect(store.announce(identity, true)).resolves.toEqual({
      kind: 'registered',
      actionEligible: false,
    });

    expect(redis.eval.mock.calls.map((call) => call[12])).toEqual(['1', '0', '1']);
    const script = String(redis.eval.mock.calls[0]![0]);
    expect(script).toContain(
      "stored_action_eligible == '1' and incoming_action_eligible == '1'",
    );
  });

  it('keeps a false-true replay sequence observation-only', async () => {
    const { store } = createStore([
      [1, 'pending-member', '0'],
      [1, 'pending-member', '0'],
    ]);

    await expect(store.announce(identity, false)).resolves.toEqual({
      kind: 'registered',
      actionEligible: false,
    });
    await expect(store.announce(identity, true)).resolves.toEqual({
      kind: 'registered',
      actionEligible: false,
    });
  });

  it.each([undefined, 'true', 1, null])(
    'normalizes a missing or malformed latch (%p) to observation-only',
    async (actionEligible) => {
      const { redis, store } = createStore([[1, 'pending-member', '0']]);

      await expect(store.announce(identity, actionEligible)).resolves.toEqual({
        kind: 'registered',
        actionEligible: false,
      });

      expect(redis.eval.mock.calls[0]![12]).toBe('0');
    },
  );

  it('commits a claimed operation before returning its value', async () => {
    const { redis, store } = createStore([[1, 'pending-member', '1'], [1, '1'], 1]);
    const operation = jest.fn().mockResolvedValue('completed-value');

    await expect(store.runInOrder(identity, true, operation)).resolves.toEqual({
      kind: 'completed',
      value: 'completed-value',
    });

    expect(operation).toHaveBeenCalledTimes(1);
    expect(operation).toHaveBeenCalledWith(
      expect.objectContaining({
        assertOwned: expect.any(Function),
        resolveActionEligibility: expect.any(Function),
      }),
      true,
    );
    expect(redis.eval).toHaveBeenCalledTimes(3);
    const claimCall = redis.eval.mock.calls[1] as unknown[];
    const completionCall = redis.eval.mock.calls[2] as unknown[];
    expect(claimCall[1]).toBe(5);
    expect(completionCall[1]).toBe(7);
    expect(completionCall[9]).toBe(identity.jobId);
    expect(completionCall[10]).toBe(claimCall[8]);
    expect(String(completionCall[0])).toContain("redis.call('ZADD', KEYS[5]");
    expect(String(completionCall[0])).toContain("redis.call('HDEL', KEYS[7], ARGV[1])");
  });

  it('observes a late downgrade atomically under the token claimed as actionable', async () => {
    const { redis, store } = createStore([
      [1, 'pending-member', '1'],
      [1, '1'],
      [1, '0'],
      1,
    ]);
    const confirmations: boolean[] = [];

    await expect(
      store.runInOrder(identity, true, async (lease, claimedActionEligible) => {
        expect(claimedActionEligible).toBe(true);
        confirmations.push(await lease.resolveActionEligibility());
      }),
    ).resolves.toEqual({ kind: 'completed', value: undefined });

    expect(confirmations).toEqual([false]);
    const claimCall = redis.eval.mock.calls[1] as unknown[];
    const confirmationCall = redis.eval.mock.calls[2] as unknown[];
    expect(confirmationCall[1]).toBe(2);
    expect(String(confirmationCall[2])).toMatch(/:lock$/u);
    expect(String(confirmationCall[3])).toMatch(/:action-eligibility$/u);
    expect(confirmationCall[4]).toBe(claimCall[8]);
    expect(confirmationCall[5]).toBe(identity.jobId);
    expect(String(confirmationCall[0])).toContain("redis.call('GET', KEYS[1]) ~= ARGV[1]");
    expect(String(confirmationCall[0])).toContain(
      "redis.call('HGET', KEYS[2], ARGV[2]) == '1'",
    );
  });

  it('releases without completion when atomic eligibility resolution is unavailable', async () => {
    const { redis, store } = createStore([
      [1, 'pending-member', '1'],
      [1, '1'],
    ]);
    redis.eval
      .mockRejectedValueOnce(new Error('redis unavailable'))
      .mockResolvedValueOnce(1);

    await expect(
      store.runInOrder(identity, true, async (lease) => {
        await lease.resolveActionEligibility();
      }),
    ).rejects.toBeInstanceOf(PhotoDuplicateOrderingUnavailableError);

    expect(redis.eval).toHaveBeenCalledTimes(4);
    expect(String(redis.eval.mock.calls[3]![0])).toContain("redis.call('DEL', KEYS[1])");
    expect(String(redis.eval.mock.calls[3]![0])).not.toContain("redis.call('ZADD', KEYS[5]");
  });

  it('releases without completion when the atomic token fence is lost', async () => {
    const { redis, store } = createStore([
      [1, 'pending-member', '1'],
      [1, '1'],
      [0, '0'],
      1,
    ]);

    await expect(
      store.runInOrder(identity, true, async (lease) => {
        await lease.resolveActionEligibility();
      }),
    ).rejects.toBeInstanceOf(PhotoDuplicateOrderingLeaseLostError);

    expect(redis.eval).toHaveBeenCalledTimes(4);
    expect(String(redis.eval.mock.calls[3]![0])).toContain("redis.call('DEL', KEYS[1])");
  });

  it('returns a deadline defer from the tuple-shaped claim response', async () => {
    const { redis, store } = createStore([[1, 'pending-member', '1'], [4, '0']]);
    const operation = jest.fn();

    await expect(store.runInOrder(identity, true, operation)).resolves.toEqual({
      kind: 'defer',
      reason: 'deadline',
    });

    expect(operation).not.toHaveBeenCalled();
    const claimScript = String(redis.eval.mock.calls[1]![0]);
    expect(claimScript).toContain("return {4, '0'}");
    expect(claimScript).toContain("return {3, '0'}");
    expect(claimScript).toContain("return {0, '0'}");
    expect(claimScript).toContain('return {1, action_eligible}');
    expect(claimScript).toContain("return {2, '0'}");
    expect(claimScript).toContain("redis.call('HDEL', KEYS[5], job_id)");
  });

  it('releases its ordering lease without clearing the latch when the operation fails', async () => {
    const { redis, store } = createStore([[1, 'pending-member', '0'], [1, '0'], 1]);
    const operationError = new Error('moderation operation failed');

    await expect(
      store.runInOrder(identity, true, jest.fn().mockRejectedValue(operationError)),
    ).rejects.toBe(operationError);

    expect(redis.eval).toHaveBeenCalledTimes(3);
    const claimCall = redis.eval.mock.calls[1] as unknown[];
    const releaseCall = redis.eval.mock.calls[2] as unknown[];
    expect(releaseCall[1]).toBe(1);
    expect(releaseCall[3]).toBe(claimCall[8]);
    expect(String(releaseCall[0])).toContain("redis.call('DEL', KEYS[1])");
    expect(String(releaseCall[0])).not.toContain('HDEL');
  });

  it('clears the latch when a pending job is explicitly abandoned', async () => {
    const { redis, store } = createStore([1]);

    await expect(store.abandon(identity)).resolves.toBeUndefined();

    const abandonCall = redis.eval.mock.calls[0] as unknown[];
    expect(abandonCall[1]).toBe(4);
    expect(abandonCall[6]).toBe(identity.jobId);
    expect(String(abandonCall[0])).toContain("redis.call('HDEL', KEYS[4], ARGV[1])");
  });
});
