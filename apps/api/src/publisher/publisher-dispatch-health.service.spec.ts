import {
  PublisherDispatchHealthService,
  PublisherDispatchHealthUnavailableError,
  PublisherDispatchPausedError,
} from './publisher-dispatch-health.service';

describe('PublisherDispatchHealthService', () => {
  function createHarness() {
    const values = new Map<string, string>();
    const redis = {
      get: jest.fn(async (key: string) => values.get(key) ?? null),
      set: jest.fn(async (key: string, value: string) => {
        values.set(key, value);
        return 'OK';
      }),
      eval: jest.fn(async (script: string, _keys: number, key: string, firstArg: unknown) => {
        if (script.includes('PUBLISHER_DISPATCH_RECORD_PAUSE_V1')) {
          const nextRaw = String(firstArg);
          const currentRaw = values.get(key);
          if (currentRaw) {
            const current = JSON.parse(currentRaw) as {
              reason?: string;
              preservedPauseRaw?: string;
              [key: string]: unknown;
            };
            if (current.reason === 'operator_rollout') {
              const next = JSON.parse(nextRaw) as { observedAtMs?: number };
              const preserved = current.preservedPauseRaw
                ? (JSON.parse(current.preservedPauseRaw) as { observedAtMs?: number })
                : null;
              if (
                typeof preserved?.observedAtMs !== 'number' ||
                typeof next.observedAtMs !== 'number' ||
                preserved.observedAtMs <= next.observedAtMs
              ) {
                values.set(key, JSON.stringify({ ...current, preservedPauseRaw: nextRaw }));
              }
              return 'OK';
            }
          }
          values.set(key, nextRaw);
          return 'OK';
        }

        const raw = values.get(key);
        if (!raw) {
          return 0;
        }
        const pause = JSON.parse(raw) as {
          observedAtMs?: number;
          preservedPauseRaw?: string;
          reason?: string;
          [key: string]: unknown;
        };
        const clearableReasons = [
          'unauthorized',
          'identity_authorization_failed',
          'identity_mismatch',
        ];
        const attemptedAtMs = Number(firstArg);
        if (pause.reason === 'operator_rollout') {
          if (!pause.preservedPauseRaw) {
            return 0;
          }
          const preserved = JSON.parse(pause.preservedPauseRaw) as {
            observedAtMs?: number;
            reason?: string;
          };
          if (
            !clearableReasons.includes(preserved.reason ?? '') ||
            typeof preserved.observedAtMs !== 'number' ||
            attemptedAtMs <= preserved.observedAtMs
          ) {
            return 0;
          }
          const operatorPause = { ...pause };
          delete operatorPause.preservedPauseRaw;
          values.set(key, JSON.stringify(operatorPause));
          return 2;
        }
        if (!clearableReasons.includes(pause.reason ?? '')) {
          return 0;
        }
        if (typeof pause.observedAtMs !== 'number' || Number(attemptedAtMs) <= pause.observedAtMs) {
          return 0;
        }
        values.delete(key);
        return 1;
      }),
      disconnect: jest.fn(),
    };
    const prisma = {
      publisherEntityBinding: {
        updateMany: jest.fn(async () => ({ count: 1 })),
      },
    };
    const refreshQueue = {
      enqueue: jest.fn(async () => undefined),
    };
    const config = {
      get: jest.fn((key: string) => (key === 'MAX_PUBLISHER_BOT_ID' ? 'publik_bot' : undefined)),
      getOrThrow: jest.fn(),
    };
    const service = new PublisherDispatchHealthService(
      config as never,
      prisma as never,
      refreshQueue as never,
      redis as never,
    );
    return { service, prisma, refreshQueue, redis, values };
  }

  it('persists a global pause on 401 until an authenticated request succeeds', async () => {
    const { service, prisma, refreshQueue } = createHarness();

    await expect(service.recordSendFailure('chat-1', { response: { status: 401 } })).resolves.toBe(
      'global_paused',
    );
    await expect(service.assertDispatchAllowed()).rejects.toMatchObject({
      code: 'PUBLISHER_DISPATCH_PAUSED',
    });
    expect(prisma.publisherEntityBinding.updateMany).not.toHaveBeenCalled();
    expect(refreshQueue.enqueue).not.toHaveBeenCalled();

    await service.recordAuthenticatedSuccess(new Date(Date.now() + 1_000));
    await expect(service.assertDispatchAllowed()).resolves.toBeUndefined();
  });

  it('wraps only a Redis pause lookup failure as unavailable', async () => {
    const { service, redis } = createHarness();
    const redisFailure = new Error('redis read failed');
    redis.get.mockRejectedValueOnce(redisFailure);

    await expect(service.assertDispatchAllowed()).rejects.toMatchObject({
      name: PublisherDispatchHealthUnavailableError.name,
      code: 'PUBLISHER_DISPATCH_HEALTH_UNAVAILABLE',
      cause: redisFailure,
    });
  });

  it('waits for a connecting Redis client before the first startup read', async () => {
    const { service, redis } = createHarness();
    const listeners = new Map<string, () => void>();
    Object.assign(redis, {
      status: 'connecting',
      once: jest.fn((event: string, listener: () => void) => {
        listeners.set(event, listener);
        return redis;
      }),
      off: jest.fn((event: string, listener: () => void) => {
        if (listeners.get(event) === listener) {
          listeners.delete(event);
        }
        return redis;
      }),
    });

    const paused = service.isGloballyPaused();
    expect(redis.get).not.toHaveBeenCalled();

    Object.assign(redis, { status: 'ready' });
    listeners.get('ready')?.();

    await expect(paused).resolves.toBe(false);
    expect(redis.get).toHaveBeenCalledTimes(1);
  });

  it('fails closed with a controlled unavailable error when startup Redis ends', async () => {
    const { service, redis } = createHarness();
    const listeners = new Map<string, () => void>();
    Object.assign(redis, {
      status: 'end',
      once: jest.fn((event: string, listener: () => void) => {
        listeners.set(event, listener);
        return redis;
      }),
      off: jest.fn((event: string, listener: () => void) => {
        if (listeners.get(event) === listener) {
          listeners.delete(event);
        }
        return redis;
      }),
    });

    const paused = service.isGloballyPaused();

    await expect(paused).rejects.toMatchObject({
      name: PublisherDispatchHealthUnavailableError.name,
      code: 'PUBLISHER_DISPATCH_HEALTH_UNAVAILABLE',
    });
    expect(redis.get).not.toHaveBeenCalled();
  });

  it('keeps an unreadable stored marker paused instead of classifying it as unavailable', async () => {
    const { service, values } = createHarness();
    values.set('publisher:dispatch:pause:v1:publik_bot', '{invalid-json');

    await expect(service.assertDispatchAllowed()).rejects.toBeInstanceOf(
      PublisherDispatchPausedError,
    );
  });

  it('does not let a pre-401 in-flight success clear a newer global pause', async () => {
    const { service } = createHarness();
    const requestStartedAt = new Date('2026-08-26T12:00:00.000Z');
    const unauthorizedObservedAt = new Date('2026-08-26T12:00:01.000Z');

    await service.recordGlobalAuthorizationFailure(unauthorizedObservedAt);
    await service.recordAuthenticatedSuccess(requestStartedAt);

    await expect(service.assertDispatchAllowed()).rejects.toMatchObject({
      code: 'PUBLISHER_DISPATCH_PAUSED',
      observedAt: unauthorizedObservedAt.toISOString(),
    });
  });

  it('does not clear a pause from a send success that lacks a pre-dispatch timestamp', async () => {
    const { service } = createHarness();
    await service.recordGlobalAuthorizationFailure(new Date('2026-08-26T12:00:01.000Z'));

    await service.recordSendSuccess('chat-1');

    await expect(service.assertDispatchAllowed()).rejects.toMatchObject({
      code: 'PUBLISHER_DISPATCH_PAUSED',
    });
  });

  it('never clears an operator rollout pause after an authenticated request', async () => {
    const { service, values } = createHarness();
    values.set(
      'publisher:dispatch:pause:v1:publik_bot',
      JSON.stringify({
        version: 1,
        reason: 'operator_rollout',
        ownerToken: 'owner-1',
      }),
    );

    await service.recordAuthenticatedSuccess(new Date('2026-08-26T12:00:01.000Z'));

    await expect(service.assertDispatchAllowed()).rejects.toMatchObject({
      code: 'PUBLISHER_DISPATCH_PAUSED',
    });
  });

  it('atomically preserves only the newest auth failure under an operator rollout marker', async () => {
    const { service, values } = createHarness();
    const key = 'publisher:dispatch:pause:v1:publik_bot';
    values.set(
      key,
      JSON.stringify({
        version: 1,
        reason: 'operator_rollout',
        ownerToken: 'owner-1',
      }),
    );

    await Promise.all([
      service.recordGlobalIdentityAttestationFailure(
        'identity_mismatch',
        null,
        new Date('2026-08-26T12:00:02.000Z'),
      ),
      service.recordGlobalAuthorizationFailure(new Date('2026-08-26T12:00:01.000Z')),
    ]);

    const operatorPause = JSON.parse(values.get(key) ?? '{}') as {
      ownerToken?: string;
      preservedPauseRaw?: string;
      reason?: string;
    };
    expect(operatorPause).toMatchObject({
      reason: 'operator_rollout',
      ownerToken: 'owner-1',
    });
    expect(typeof operatorPause.preservedPauseRaw).toBe('string');
    expect(Buffer.byteLength(operatorPause.preservedPauseRaw ?? '', 'utf8')).toBeLessThanOrEqual(
      16 * 1_024,
    );
    expect(JSON.parse(operatorPause.preservedPauseRaw ?? '{}')).toMatchObject({
      version: 1,
      reason: 'identity_mismatch',
      statusCode: null,
      observedAt: '2026-08-26T12:00:02.000Z',
      observedAtMs: Date.parse('2026-08-26T12:00:02.000Z'),
    });
  });

  it('removes only stale preserved auth after success and keeps newer auth recoverable', async () => {
    const { service, values } = createHarness();
    const key = 'publisher:dispatch:pause:v1:publik_bot';
    const operator = {
      version: 1,
      reason: 'operator_rollout',
      ownerToken: 'owner-1',
    };
    values.set(key, JSON.stringify(operator));
    await service.recordGlobalAuthorizationFailure(new Date('2026-08-26T12:00:01.000Z'));

    await service.recordAuthenticatedSuccess(new Date('2026-08-26T12:00:02.000Z'));

    expect(JSON.parse(values.get(key) ?? '{}')).toEqual(operator);
    await service.recordGlobalIdentityAttestationFailure(
      'identity_mismatch',
      null,
      new Date('2026-08-26T12:00:03.000Z'),
    );
    await service.recordAuthenticatedSuccess(new Date('2026-08-26T12:00:02.500Z'));
    const guardedOperator = JSON.parse(values.get(key) ?? '{}') as {
      ownerToken?: string;
      preservedPauseRaw?: string;
      reason?: string;
    };
    expect(guardedOperator).toMatchObject({
      reason: 'operator_rollout',
      ownerToken: 'owner-1',
    });
    expect(JSON.parse(guardedOperator.preservedPauseRaw ?? '{}')).toMatchObject({
      reason: 'identity_mismatch',
      observedAtMs: Date.parse('2026-08-26T12:00:03.000Z'),
    });

    values.set(key, guardedOperator.preservedPauseRaw ?? '');
    await expect(service.assertDispatchAllowed()).rejects.toMatchObject({
      code: 'PUBLISHER_DISPATCH_PAUSED',
      observedAt: '2026-08-26T12:00:03.000Z',
    });
  });

  it.each([403, 404])('marks only the failed entity setup-required on HTTP %s', async (status) => {
    const { service, prisma, refreshQueue } = createHarness();

    await expect(service.recordSendFailure('chat-1', { response: { status } })).resolves.toBe(
      'setup_required',
    );

    expect(prisma.publisherEntityBinding.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          chatId: 'chat-1',
          publisherBotId: 'publik_bot',
          AND: expect.any(Array),
        }),
        data: expect.objectContaining({
          botAccessState: 'LOST',
          botAccessExpiresAt: null,
          botAccessLastErrorCode: `HTTP_${status}`,
        }),
      }),
    );
    expect(refreshQueue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'chat-1',
        publisherBotId: 'publik_bot',
        reason: 'send_access_lost',
      }),
    );
  });

  it('keeps 429 retryable without mutating a binding or selecting a fallback', async () => {
    const { service, prisma, refreshQueue } = createHarness();

    await expect(service.recordSendFailure('chat-1', { response: { status: 429 } })).resolves.toBe(
      'retryable',
    );
    expect(prisma.publisherEntityBinding.updateMany).not.toHaveBeenCalled();
    expect(refreshQueue.enqueue).not.toHaveBeenCalled();
  });
});
