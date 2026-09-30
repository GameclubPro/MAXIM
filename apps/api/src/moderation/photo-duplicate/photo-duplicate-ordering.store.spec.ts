import {
  PhotoDuplicateOrderingLeaseLostError,
  PhotoDuplicateOrderingStore,
  PhotoDuplicateOrderingUnavailableError,
} from './photo-duplicate-ordering.store';

const identity = {
  jobId: `photo-duplicate__${'a'.repeat(64)}`,
  chatId: 'chat-secret-id',
  sourceCreatedAt: '2026-08-05T12:00:00.000Z',
};

function registered(eligible: boolean) {
  const admittedAtMs = Date.now();
  return [1, 'pending-member', eligible ? '1' : '0', admittedAtMs, admittedAtMs + 600_000];
}

function createStore(evalResults: unknown[]) {
  const redis = { eval: jest.fn(), quit: jest.fn().mockResolvedValue(undefined) };
  for (const result of evalResults) redis.eval.mockResolvedValueOnce(result);
  const store = Object.create(PhotoDuplicateOrderingStore.prototype) as PhotoDuplicateOrderingStore;
  Object.defineProperties(store, {
    redis: { value: redis },
    logger: { value: { warn: jest.fn() } },
  });
  return { redis, store };
}

describe('PhotoDuplicateOrderingStore', () => {
  it('separates job authority from the chat-scoped ordering membership', async () => {
    const { redis, store } = createStore([registered(true)]);
    await expect(store.announce(identity, true)).resolves.toMatchObject({
      kind: 'registered',
      actionEligible: true,
    });
    const call = redis.eval.mock.calls[0] as unknown[];
    expect(call[1]).toBe(7);
    expect(call[7]).toEqual(
      expect.stringMatching(/^photo-duplicate:ordering:v2:[a-f0-9]{32}:permit:[a-f0-9]{64}$/u),
    );
    expect(call.slice(2, 9).join('|')).not.toContain(identity.chatId);
    expect(call.slice(2, 9).join('|')).not.toContain(identity.jobId);
    expect(call[14]).toBe('initial');
  });

  it.each([undefined, 'true', 1, null])(
    'fails closed for a malformed incoming permission (%p)',
    async (eligible) => {
      const { redis, store } = createStore([registered(false)]);
      await expect(store.announce(identity, eligible)).resolves.toMatchObject({
        kind: 'registered',
        actionEligible: false,
      });
      expect(redis.eval.mock.calls[0]![13]).toBe('0');
    },
  );

  it('registers processing as a retry and completes before returning its result', async () => {
    const { redis, store } = createStore([registered(true), [1, '1'], 1]);
    const operation = jest.fn().mockResolvedValue('value');
    await expect(store.runInOrder(identity, true, operation)).resolves.toEqual({
      kind: 'completed',
      value: 'value',
    });
    expect(redis.eval.mock.calls[0]![14]).toBe('retry');
    expect(operation).toHaveBeenCalledWith(
      expect.objectContaining({
        assertOwned: expect.any(Function),
        resolveActionEligibility: expect.any(Function),
      }),
      true,
    );
    const claim = redis.eval.mock.calls[1]!;
    const completion = redis.eval.mock.calls[2]!;
    expect(claim[1]).toBe(6);
    expect(completion[1]).toBe(7);
    expect(completion[10]).toBe(claim[9]);
  });

  it('observes a late downgrade under the live lease', async () => {
    const { store } = createStore([registered(true), [1, '1'], [1, '0'], 1]);
    await store.runInOrder(identity, true, async (lease, eligible) => {
      expect(eligible).toBe(true);
      expect(await lease.resolveActionEligibility()).toBe(false);
    });
  });

  it('reads final authority without requiring an ordering lease', async () => {
    const { store } = createStore([1, 0]);
    expect(await store.readActionEligibility(identity)).toBe(true);
    expect(await store.readActionEligibility(identity)).toBe(false);
  });

  it('throws an unavailable error when final authority cannot be read', async () => {
    const { redis, store } = createStore([]);
    redis.eval.mockRejectedValueOnce(new Error('unavailable'));
    await expect(store.readActionEligibility(identity)).rejects.toBeInstanceOf(
      PhotoDuplicateOrderingUnavailableError,
    );
  });

  it.each([0, 'invalid'])('releases a lost or invalid lease fence (%p)', async (status) => {
    const { redis, store } = createStore([registered(true), [1, '1'], [status, '0'], 1]);
    await expect(
      store.runInOrder(identity, true, async (lease) => lease.resolveActionEligibility()),
    ).rejects.toBeInstanceOf(
      status === 0 ? PhotoDuplicateOrderingLeaseLostError : PhotoDuplicateOrderingUnavailableError,
    );
    expect(redis.eval).toHaveBeenCalledTimes(4);
  });

  it.each([
    [0, 'not_head'],
    [2, 'busy'],
    [5, 'scheduled'],
  ] as const)('returns the scheduling deadline for claim status %s', async (status, reason) => {
    const nextEligibleAtMs = Date.now() + 180_000;
    const { store } = createStore([registered(true), [status, '0', nextEligibleAtMs]]);
    const operation = jest.fn();
    await expect(store.runInOrder(identity, true, operation)).resolves.toEqual({
      kind: 'defer',
      reason,
      nextEligibleAtMs,
    });
    expect(operation).not.toHaveBeenCalled();
  });

  it('preserves failed operations for bounded retry', async () => {
    const { redis, store } = createStore([registered(false), [1, '0'], 1]);
    const failure = new Error('operation failed');
    await expect(
      store.runInOrder(identity, true, jest.fn().mockRejectedValue(failure)),
    ).rejects.toBe(failure);
    expect(redis.eval).toHaveBeenCalledTimes(3);
  });

  it('abandon and postpone address the same independent authority', async () => {
    const { redis, store } = createStore([1, 1]);
    await store.postpone(identity, Date.now() + 180_000);
    await store.abandon(identity);
    expect(redis.eval.mock.calls[0]![4]).toBe(redis.eval.mock.calls[1]![5]);
  });
});
