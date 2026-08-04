import {
  MODERATION_SANCTION_STATE_LOCK_TTL_MS,
  MODERATION_SANCTION_STATE_LOCK_WAIT_TIMEOUT_MS,
  ModerationSanctionStateChangedError,
  ModerationSanctionStateLockBusyError,
  ModerationSanctionStateLockLeaseLostError,
  ModerationSanctionStateLockService,
  ModerationSanctionStateLockUnavailableError,
} from './moderation-sanction-state-lock.service';

const SUBJECT = { chatId: 'chat-1', userId: 'user-1' };

function createRedisLock() {
  return {
    acquireLockBeforeDeadline: jest.fn().mockResolvedValue({ kind: 'acquired' }),
    renewLock: jest.fn().mockResolvedValue(true),
    releaseLock: jest.fn().mockResolvedValue(undefined),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('ModerationSanctionStateLockService', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('uses one hashed Redis key and releases only with the acquired token', async () => {
    const redis = createRedisLock();
    const service = new ModerationSanctionStateLockService(redis as never);

    await expect(service.runExclusive(SUBJECT, async () => 'done')).resolves.toBe('done');

    expect(redis.acquireLockBeforeDeadline).toHaveBeenCalledWith(
      expect.stringMatching(/^moderation-sanction-state:v1:[a-f0-9]{64}$/u),
      expect.any(String),
      MODERATION_SANCTION_STATE_LOCK_TTL_MS,
      expect.any(Number),
    );
    const [key, token] = redis.acquireLockBeforeDeadline.mock.calls[0]!;
    expect(key).not.toContain(SUBJECT.chatId);
    expect(key).not.toContain(SUBJECT.userId);
    expect(redis.releaseLock).toHaveBeenCalledWith(key, token);
  });

  it('exposes a typed state-changed error for exact-event preconditions', () => {
    expect(new ModerationSanctionStateChangedError()).toMatchObject({
      name: ModerationSanctionStateChangedError.name,
      code: 'moderation_sanction_state_changed',
    });
  });

  it('waits for bounded Redis contention and then acquires the same lease', async () => {
    jest.useFakeTimers();
    const redis = createRedisLock();
    redis.acquireLockBeforeDeadline
      .mockResolvedValueOnce({ kind: 'busy' })
      .mockResolvedValueOnce({ kind: 'acquired' });
    const service = new ModerationSanctionStateLockService(redis as never);

    const result = service.runExclusive(SUBJECT, async () => 'done');
    await Promise.resolve();
    expect(redis.acquireLockBeforeDeadline).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(25);
    await expect(result).resolves.toBe('done');
    expect(redis.acquireLockBeforeDeadline).toHaveBeenCalledTimes(2);
    const firstToken = redis.acquireLockBeforeDeadline.mock.calls[0]?.[1];
    expect(redis.acquireLockBeforeDeadline.mock.calls[1]?.[1]).toBe(firstToken);
  });

  it('throws a typed busy error after the bounded wait without using memory fallback', async () => {
    jest.useFakeTimers();
    const redis = createRedisLock();
    redis.acquireLockBeforeDeadline.mockResolvedValue({ kind: 'busy' });
    const service = new ModerationSanctionStateLockService(redis as never);
    const operation = jest.fn();

    const result = service.runExclusive(SUBJECT, operation);
    const rejection = expect(result).rejects.toBeInstanceOf(ModerationSanctionStateLockBusyError);
    await jest.advanceTimersByTimeAsync(MODERATION_SANCTION_STATE_LOCK_WAIT_TIMEOUT_MS);

    await rejection;
    expect(operation).not.toHaveBeenCalled();
    expect(redis.releaseLock).not.toHaveBeenCalled();
  });

  it('fails closed with a typed unavailable error when Redis acquisition fails', async () => {
    const redis = createRedisLock();
    redis.acquireLockBeforeDeadline.mockRejectedValue(new Error('redis unavailable'));
    const service = new ModerationSanctionStateLockService(redis as never);
    const operation = jest.fn();

    await expect(service.runExclusive(SUBJECT, operation)).rejects.toMatchObject({
      name: ModerationSanctionStateLockUnavailableError.name,
      code: 'moderation_sanction_state_lock_unavailable',
      cause: expect.objectContaining({ message: 'redis unavailable' }),
    });
    expect(operation).not.toHaveBeenCalled();
  });

  it('renews a live lease and stops the heartbeat before releasing it', async () => {
    jest.useFakeTimers();
    const redis = createRedisLock();
    const operation = deferred<string>();
    const service = new ModerationSanctionStateLockService(redis as never);

    const result = service.runExclusive(SUBJECT, () => operation.promise);
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(MODERATION_SANCTION_STATE_LOCK_TTL_MS / 3);

    const [key, token] = redis.acquireLockBeforeDeadline.mock.calls[0]!;
    expect(redis.renewLock).toHaveBeenCalledWith(key, token, MODERATION_SANCTION_STATE_LOCK_TTL_MS);
    operation.resolve('done');
    await expect(result).resolves.toBe('done');
    expect(redis.releaseLock).toHaveBeenCalledWith(key, token);

    await jest.advanceTimersByTimeAsync(MODERATION_SANCTION_STATE_LOCK_TTL_MS);
    expect(redis.renewLock).toHaveBeenCalledTimes(1);
  });

  it('reports a typed lease-lost error after a failed heartbeat and still token-releases', async () => {
    jest.useFakeTimers();
    const redis = createRedisLock();
    redis.renewLock.mockResolvedValue(false);
    const operation = deferred<void>();
    const service = new ModerationSanctionStateLockService(redis as never);

    const result = service.runExclusive(SUBJECT, () => operation.promise);
    const rejection = expect(result).rejects.toBeInstanceOf(
      ModerationSanctionStateLockLeaseLostError,
    );
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(MODERATION_SANCTION_STATE_LOCK_TTL_MS / 3);
    operation.resolve();

    await rejection;
    const [key, token] = redis.acquireLockBeforeDeadline.mock.calls[0]!;
    expect(redis.releaseLock).toHaveBeenCalledWith(key, token);
  });

  it('prevents a guarded side effect when token-safe ownership renewal returns false', async () => {
    const redis = createRedisLock();
    redis.renewLock.mockResolvedValue(false);
    const service = new ModerationSanctionStateLockService(redis as never);
    const sideEffect = jest.fn();

    await expect(
      service.runExclusive(SUBJECT, async (guard) => {
        await guard.assertOwned();
        sideEffect();
      }),
    ).rejects.toBeInstanceOf(ModerationSanctionStateLockLeaseLostError);

    expect(sideEffect).not.toHaveBeenCalled();
    const [key, token] = redis.acquireLockBeforeDeadline.mock.calls[0]!;
    expect(redis.renewLock).toHaveBeenCalledWith(key, token, MODERATION_SANCTION_STATE_LOCK_TTL_MS);
    expect(redis.releaseLock).toHaveBeenCalledWith(key, token);
  });

  it('fails closed when an explicit ownership renewal has a transport failure', async () => {
    const redis = createRedisLock();
    redis.renewLock.mockRejectedValue(new Error('redis unavailable'));
    const service = new ModerationSanctionStateLockService(redis as never);
    const sideEffect = jest.fn();

    await expect(
      service.runExclusive(SUBJECT, async (guard) => {
        await guard.assertOwned();
        sideEffect();
      }),
    ).rejects.toMatchObject({
      name: ModerationSanctionStateLockUnavailableError.name,
      code: 'moderation_sanction_state_lock_unavailable',
      cause: expect.objectContaining({ message: 'redis unavailable' }),
    });
    expect(sideEffect).not.toHaveBeenCalled();
  });

  it('recovers when a heartbeat transport failure is followed by a successful retry', async () => {
    jest.useFakeTimers();
    const redis = createRedisLock();
    redis.renewLock
      .mockRejectedValueOnce(new Error('transient redis failure'))
      .mockResolvedValueOnce(true);
    const operation = deferred<string>();
    const service = new ModerationSanctionStateLockService(redis as never);

    const result = service.runExclusive(SUBJECT, () => operation.promise);
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(MODERATION_SANCTION_STATE_LOCK_TTL_MS / 3);
    expect(redis.renewLock).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(1_000);
    expect(redis.renewLock).toHaveBeenCalledTimes(2);
    operation.resolve('done');

    await expect(result).resolves.toBe('done');
  });

  it('rejects the guard after heartbeat transport failures exhaust the conservative lease', async () => {
    jest.useFakeTimers();
    const redis = createRedisLock();
    redis.renewLock.mockRejectedValue(new Error('redis unavailable'));
    const continueOperation = deferred<void>();
    const sideEffect = jest.fn();
    const service = new ModerationSanctionStateLockService(redis as never);

    const result = service.runExclusive(SUBJECT, async (guard) => {
      await continueOperation.promise;
      await guard.assertOwned();
      sideEffect();
    });
    const rejection = expect(result).rejects.toBeInstanceOf(
      ModerationSanctionStateLockLeaseLostError,
    );
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(MODERATION_SANCTION_STATE_LOCK_TTL_MS);
    expect(redis.renewLock.mock.calls.length).toBeGreaterThan(1);
    continueOperation.resolve();

    await rejection;
    expect(sideEffect).not.toHaveBeenCalled();
  });

  it('does not turn a completed operation into a retry when token release fails', async () => {
    const redis = createRedisLock();
    redis.releaseLock.mockRejectedValue(new Error('release unavailable'));
    const service = new ModerationSanctionStateLockService(redis as never);
    const operation = jest.fn().mockResolvedValue('done');

    await expect(service.runExclusive(SUBJECT, operation)).resolves.toBe('done');
    expect(operation).toHaveBeenCalledTimes(1);
    expect(redis.releaseLock).toHaveBeenCalledTimes(1);
  });

  it('uses a shared process-memory lock only in tests when the Redis API is absent', async () => {
    jest.useFakeTimers();
    const firstOperation = deferred<void>();
    const firstService = new ModerationSanctionStateLockService(undefined);
    const secondService = new ModerationSanctionStateLockService({} as never);
    const secondOperation = jest.fn().mockResolvedValue('second');

    const first = firstService.runExclusive(SUBJECT, async (guard) => {
      await guard.assertOwned();
      return firstOperation.promise;
    });
    await Promise.resolve();
    const second = secondService.runExclusive(SUBJECT, secondOperation);
    await Promise.resolve();
    expect(secondOperation).not.toHaveBeenCalled();

    firstOperation.resolve();
    await first;
    await jest.advanceTimersByTimeAsync(25);
    await expect(second).resolves.toBe('second');
  });

  it('does not use the memory fallback outside the test environment', async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const service = new ModerationSanctionStateLockService(undefined);
      await expect(service.runExclusive(SUBJECT, async () => undefined)).rejects.toBeInstanceOf(
        ModerationSanctionStateLockUnavailableError,
      );
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
    }
  });
});
