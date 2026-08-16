import type { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import {
  MINIAPP_SESSION_CREATE_RATE_LIMIT,
  MINIAPP_SESSION_MAX_PER_PRINCIPAL,
} from './miniapp-session.constants';
import {
  MiniappSessionRateLimitedException,
  MiniappSessionUnavailableException,
} from './miniapp-session.error';
import { MiniappSessionService } from './miniapp-session.service';

type MockRedisInstance = {
  status: string;
  strings: Map<string, string>;
  sortedSets: Map<string, Map<string, number>>;
  ttlSeconds: Map<string, number>;
  on: jest.Mock;
  connect: jest.Mock;
  set: jest.Mock;
  get: jest.Mock;
  del: jest.Mock;
  eval: jest.Mock;
  disconnect: jest.Mock;
};

const mockRedisInstances: MockRedisInstance[] = [];
let mockSetError: Error | null = null;
let mockConnectDeferred = false;
const mockConnectResolvers: Array<() => void> = [];

jest.mock('ioredis', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => {
    const strings = new Map<string, string>();
    const sortedSets = new Map<string, Map<string, number>>();
    const ttlSeconds = new Map<string, number>();
    const instance: MockRedisInstance = {
      status: 'wait',
      strings,
      sortedSets,
      ttlSeconds,
      on: jest.fn(),
      connect: jest.fn(async () => {
        instance.status = 'connecting';
        if (mockConnectDeferred) {
          await new Promise<void>((resolve) => {
            mockConnectResolvers.push(resolve);
          });
        }
        instance.status = 'ready';
      }),
      set: jest.fn(async (key: string, value: string, ...options: Array<string | number>) => {
        if (mockSetError) {
          throw mockSetError;
        }
        if (options.includes('NX') && strings.has(key)) {
          return null;
        }
        if (options.includes('XX') && !strings.has(key)) {
          return null;
        }
        strings.set(key, value);
        const expiryIndex = options.indexOf('EX');
        const ttlSec = expiryIndex >= 0 ? Number(options[expiryIndex + 1]) : null;
        if (ttlSec !== null && Number.isFinite(ttlSec)) {
          ttlSeconds.set(key, ttlSec);
        }
        return 'OK';
      }),
      get: jest.fn(async (key: string) => strings.get(key) ?? null),
      del: jest.fn(async (key: string) => {
        ttlSeconds.delete(key);
        return strings.delete(key) ? 1 : 0;
      }),
      eval: jest.fn(async (_script: string, keyCount: number, ...args: string[]) => {
        if (mockSetError) {
          throw mockSetError;
        }

        if (keyCount === 2) {
          const [sessionKey, principalIndexKey, keyHash] = args;
          const removed = strings.delete(sessionKey!) ? 1 : 0;
          ttlSeconds.delete(sessionKey!);
          sortedSets.get(principalIndexKey!)?.delete(keyHash!);
          return removed;
        }

        expect(keyCount).toBe(3);
        const [sessionKey, principalIndexKey, rateKey] = args.slice(0, keyCount);
        const [record, ttlRaw, createdAtRaw, rateLimitRaw, rateWindowRaw, maxRaw, prefix, keyHash] =
          args.slice(keyCount);
        const ttlSec = Number(ttlRaw);
        const createdAt = Number(createdAtRaw);
        const rateLimit = Number(rateLimitRaw);
        const rateWindowSec = Number(rateWindowRaw);
        const maxSessions = Number(maxRaw);
        const createCount = Number(strings.get(rateKey!) ?? 0) + 1;
        strings.set(rateKey!, String(createCount));
        ttlSeconds.set(rateKey!, rateWindowSec);
        if (createCount > rateLimit) {
          return -1;
        }
        if (strings.has(sessionKey!)) {
          return 0;
        }

        strings.set(sessionKey!, record!);
        ttlSeconds.set(sessionKey!, ttlSec);
        const index = sortedSets.get(principalIndexKey!) ?? new Map<string, number>();
        sortedSets.set(principalIndexKey!, index);
        const cutoff = createdAt - ttlSec * 1_000;
        for (const [member, score] of index) {
          if (score <= cutoff) {
            index.delete(member);
          }
        }
        while (index.size >= maxSessions) {
          const oldest = [...index.entries()].sort(
            ([leftMember, leftScore], [rightMember, rightScore]) =>
              leftScore - rightScore || leftMember.localeCompare(rightMember),
          )[0];
          if (!oldest) {
            break;
          }
          index.delete(oldest[0]);
          strings.delete(`${prefix}${oldest[0]}`);
          ttlSeconds.delete(`${prefix}${oldest[0]}`);
        }
        index.set(keyHash!, createdAt);
        ttlSeconds.set(principalIndexKey!, ttlSec);
        return 1;
      }),
      disconnect: jest.fn(() => {
        instance.status = 'end';
      }),
    };
    mockRedisInstances.push(instance);
    return instance;
  }),
}));

const TEST_NOW = new Date('2026-08-16T12:00:00.000Z');
const TEST_USER: AuthUser = {
  userId: 'user-42',
  launchBotId: 'bot-main',
  username: 'moderator',
  displayName: 'Test Moderator',
};

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function createConfigMock(ttlSec = 600): ConfigService {
  return {
    getOrThrow: jest.fn((key: string) => {
      if (key === 'REDIS_URL') {
        return 'redis://session.test:6379/0';
      }
      throw new Error(`Missing config key ${key}`);
    }),
    get: jest.fn((key: string, fallback?: number) => {
      if (key === 'MINIAPP_SESSION_TTL_SEC') {
        return ttlSec;
      }
      if (key === 'MINIAPP_SESSION_REDIS_TIMEOUT_MS') {
        return 250;
      }
      return fallback;
    }),
  } as unknown as ConfigService;
}

describe('MiniappSessionService', () => {
  beforeEach(() => {
    mockRedisInstances.length = 0;
    mockSetError = null;
    mockConnectDeferred = false;
    mockConnectResolvers.length = 0;
    jest.useFakeTimers().setSystemTime(TEST_NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('stores only the SHA-256 session key with the configured TTL and bounded record', async () => {
    const ttlSec = 900;
    const service = new MiniappSessionService(createConfigMock(ttlSec));

    const created = await service.create(TEST_USER);
    const redis = mockRedisInstances[0];
    const expectedKey = `miniapp:session:v1:${sha256(created.sessionToken)}`;
    const expectedExpiresAt = TEST_NOW.getTime() + ttlSec * 1_000;

    expect(redis.eval).toHaveBeenCalledTimes(1);
    expect(redis.eval.mock.calls[0]?.[2]).toBe(expectedKey);
    expect(JSON.stringify(redis.eval.mock.calls[0]?.slice(2, 5))).not.toContain(TEST_USER.userId);
    expect(expectedKey).not.toContain(created.sessionToken);
    expect(redis.ttlSeconds.get(expectedKey)).toBe(ttlSec);

    const serialized = redis.strings.get(expectedKey);
    expect(serialized).toBeDefined();
    expect(serialized).not.toContain(created.sessionToken);
    expect(JSON.parse(serialized as string)).toEqual({
      version: 1,
      createdAt: TEST_NOW.getTime(),
      expiresAt: expectedExpiresAt,
      csrfToken: created.csrfToken,
      user: TEST_USER,
    });
    expect(created.expiresAt).toBe(expectedExpiresAt);
  });

  it('resolves a valid session and rejects malformed tokens without touching Redis', async () => {
    const service = new MiniappSessionService(createConfigMock());
    const created = await service.create(TEST_USER);
    const redis = mockRedisInstances[0];

    await expect(service.resolve(created.sessionToken)).resolves.toEqual({
      keyHash: sha256(created.sessionToken),
      record: {
        version: 1,
        createdAt: TEST_NOW.getTime(),
        expiresAt: created.expiresAt,
        csrfToken: created.csrfToken,
        user: TEST_USER,
      },
    });

    redis.get.mockClear();
    await expect(service.resolve('not-a-session-token')).resolves.toBeNull();
    expect(redis.get).not.toHaveBeenCalled();
  });

  it('shares a deferred Redis connection across concurrent create and resolve calls', async () => {
    mockConnectDeferred = true;
    const service = new MiniappSessionService(createConfigMock());
    const createPromise = service.create(TEST_USER);
    const redis = mockRedisInstances[0];
    const existingToken = 's'.repeat(43);
    const existingKey = `miniapp:session:v1:${sha256(existingToken)}`;
    const existingRecord = {
      version: 1,
      createdAt: TEST_NOW.getTime(),
      expiresAt: TEST_NOW.getTime() + 600_000,
      csrfToken: 'c'.repeat(43),
      user: TEST_USER,
    };
    redis.strings.set(existingKey, JSON.stringify(existingRecord));

    const resolvePromise = service.resolve(existingToken);

    expect(redis.connect).toHaveBeenCalledTimes(1);
    expect(redis.eval).not.toHaveBeenCalled();
    expect(redis.get).not.toHaveBeenCalled();
    for (const resolveConnect of mockConnectResolvers.splice(0)) {
      resolveConnect();
    }

    const [created, resolved] = await Promise.all([createPromise, resolvePromise]);
    expect(created.sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(resolved).toEqual({
      keyHash: sha256(existingToken),
      record: existingRecord,
    });
  });

  it('deletes malformed and expired records instead of authenticating them', async () => {
    const service = new MiniappSessionService(createConfigMock(5));
    const malformed = await service.create(TEST_USER);
    const redis = mockRedisInstances[0];
    const malformedKey = `miniapp:session:v1:${sha256(malformed.sessionToken)}`;
    redis.strings.set(malformedKey, '{broken-json');

    await expect(service.resolve(malformed.sessionToken)).resolves.toBeNull();
    expect(redis.del).toHaveBeenCalledWith(malformedKey);

    const expired = await service.create(TEST_USER);
    const expiredKey = `miniapp:session:v1:${sha256(expired.sessionToken)}`;
    jest.setSystemTime(TEST_NOW.getTime() + 5_001);

    await expect(service.resolve(expired.sessionToken)).resolves.toBeNull();
    expect(redis.del).toHaveBeenCalledWith(expiredKey);
  });

  it('keeps one valid CSRF token across recoveries without extending the absolute TTL', async () => {
    const service = new MiniappSessionService(createConfigMock(600));
    const created = await service.create(TEST_USER);
    const redis = mockRedisInstances[0];
    const sessionKey = `miniapp:session:v1:${sha256(created.sessionToken)}`;
    const originalTtl = redis.ttlSeconds.get(sessionKey);

    const [firstRecovery, secondRecovery] = await Promise.all([
      service.resolve(created.sessionToken),
      service.resolve(created.sessionToken),
    ]);

    expect(firstRecovery?.record.csrfToken).toBe(created.csrfToken);
    expect(secondRecovery?.record.csrfToken).toBe(created.csrfToken);
    expect(service.verifyCsrf(firstRecovery!, created.csrfToken)).toBe(true);
    expect(service.verifyCsrf(secondRecovery!, created.csrfToken)).toBe(true);
    expect(service.verifyCsrf(firstRecovery!, 'x'.repeat(43))).toBe(false);
    expect(service.verifyCsrf(firstRecovery!, undefined)).toBe(false);
    expect(redis.set).not.toHaveBeenCalled();
    expect(redis.eval).toHaveBeenCalledTimes(1);
    expect(redis.ttlSeconds.get(sessionKey)).toBe(originalTtl);
    expect(JSON.parse(redis.strings.get(sessionKey) as string)).toMatchObject({
      csrfToken: created.csrfToken,
      expiresAt: created.expiresAt,
    });
  });

  it('refreshes the user snapshot without changing the session identity or TTL', async () => {
    const service = new MiniappSessionService(createConfigMock(600));
    const created = await service.create(TEST_USER);
    const resolved = await service.resolve(created.sessionToken);
    const redis = mockRedisInstances[0];
    const sessionKey = `miniapp:session:v1:${sha256(created.sessionToken)}`;
    const originalTtl = redis.ttlSeconds.get(sessionKey);
    const updatedUser = {
      ...TEST_USER,
      displayName: 'Updated Moderator',
      chatId: 'chat-99',
      chatTitle: 'Updated Chat',
      chatType: 'chat' as const,
    };

    const refreshed = await service.refreshUser(resolved!, updatedUser);

    expect(refreshed).toEqual({
      keyHash: resolved?.keyHash,
      record: {
        ...resolved?.record,
        user: updatedUser,
      },
    });
    expect(redis.set).toHaveBeenCalledWith(sessionKey, expect.any(String), 'KEEPTTL', 'XX');
    expect(redis.ttlSeconds.get(sessionKey)).toBe(originalTtl);
    expect(JSON.parse(redis.strings.get(sessionKey) as string)).toMatchObject({
      createdAt: resolved?.record.createdAt,
      expiresAt: resolved?.record.expiresAt,
      csrfToken: resolved?.record.csrfToken,
      user: updatedUser,
    });
  });

  it('does not resurrect a session removed before its user refresh', async () => {
    const service = new MiniappSessionService(createConfigMock(600));
    const created = await service.create(TEST_USER);
    const resolved = await service.resolve(created.sessionToken);
    const redis = mockRedisInstances[0];
    const sessionKey = `miniapp:session:v1:${sha256(created.sessionToken)}`;
    redis.strings.delete(sessionKey);
    redis.ttlSeconds.delete(sessionKey);

    await expect(
      service.refreshUser(resolved!, { ...TEST_USER, displayName: 'Too Late' }),
    ).resolves.toBeNull();
    expect(redis.strings.has(sessionKey)).toBe(false);
  });

  it('removes a destroyed session from the principal cap before creating a replacement', async () => {
    const service = new MiniappSessionService(createConfigMock(600));
    const created = await Promise.all(
      Array.from({ length: MINIAPP_SESSION_MAX_PER_PRINCIPAL }, () => service.create(TEST_USER)),
    );
    const removed = created.at(-1)!;
    const removedSession = await service.resolve(removed.sessionToken);

    await service.destroyResolved(removed.sessionToken, removedSession!);
    const replacement = await service.create(TEST_USER);
    const survivors = await Promise.all([
      ...created.slice(0, -1).map((session) => service.resolve(session.sessionToken)),
      service.resolve(replacement.sessionToken),
    ]);
    const redis = mockRedisInstances[0];

    expect(survivors.every(Boolean)).toBe(true);
    expect(await service.resolve(removed.sessionToken)).toBeNull();
    expect([...redis.sortedSets.values()][0]?.size).toBe(MINIAPP_SESSION_MAX_PER_PRINCIPAL);
  });

  it('atomically caps concurrent principal sessions and rate-limits creation abuse', async () => {
    const service = new MiniappSessionService(createConfigMock(600));

    const results = await Promise.allSettled(
      Array.from({ length: MINIAPP_SESSION_CREATE_RATE_LIMIT + 1 }, () =>
        service.create(TEST_USER),
      ),
    );
    const redis = mockRedisInstances[0];
    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof service.create>>> =>
        result.status === 'fulfilled',
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    const activeSessionKeys = [...redis.strings.keys()].filter((key) =>
      key.startsWith('miniapp:session:v1:'),
    );

    expect(fulfilled).toHaveLength(MINIAPP_SESSION_CREATE_RATE_LIMIT);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(MiniappSessionRateLimitedException);
    expect(activeSessionKeys).toHaveLength(MINIAPP_SESSION_MAX_PER_PRINCIPAL);
    expect([...redis.sortedSets.values()]).toHaveLength(1);
    expect([...redis.sortedSets.values()][0]?.size).toBe(MINIAPP_SESSION_MAX_PER_PRINCIPAL);
    expect([...redis.ttlSeconds.keys()].some((key) => key.includes(TEST_USER.userId))).toBe(false);
  });

  it('maps a rejected Redis command to a machine-readable 503', async () => {
    mockSetError = new Error('Redis unavailable');
    const service = new MiniappSessionService(createConfigMock());

    const error = await service.create(TEST_USER).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MiniappSessionUnavailableException);
    expect((error as MiniappSessionUnavailableException).getStatus()).toBe(503);
    expect((error as MiniappSessionUnavailableException).getResponse()).toEqual({
      statusCode: 503,
      error: 'Service Unavailable',
      message: 'Mini app session storage is temporarily unavailable',
      code: 'MINIAPP_SESSION_UNAVAILABLE',
      retryable: true,
      recovery: 'retry',
    });
  });
});
