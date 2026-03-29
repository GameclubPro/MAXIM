import Redis from 'ioredis';

jest.mock('ioredis', () => {
  const store = new Map<string, string>();
  const subscribers = new Set<(channel: string, payload: string) => void>();
  const createInstance = () => {
    const messageHandlers = new Set<(channel: string, payload: string) => void>();
    const instance = {
      get: jest.fn().mockImplementation(async (key: string) => store.get(key) ?? null),
      set: jest.fn().mockImplementation(async (key: string, value: string) => {
        store.set(key, value);
        return 'OK';
      }),
      del: jest.fn().mockImplementation(async (...keys: string[]) => {
        let deleted = 0;
        for (const key of keys) {
          if (store.delete(key)) {
            deleted += 1;
          }
        }
        return deleted;
      }),
      publish: jest.fn().mockImplementation(async (channel: string, payload: string) => {
        for (const subscriber of subscribers) {
          subscriber(channel, payload);
        }
        return subscribers.size;
      }),
      subscribe: jest.fn().mockResolvedValue(1),
      on: jest.fn().mockImplementation((event: string, handler: unknown) => {
        if (event === 'message' && typeof handler === 'function') {
          const messageHandler = handler as (channel: string, payload: string) => void;
          messageHandlers.add(messageHandler);
          subscribers.add(messageHandler);
        }
        return instance;
      }),
      duplicate: jest.fn().mockImplementation(() => createInstance()),
      quit: jest.fn().mockImplementation(async () => {
        for (const handler of messageHandlers) {
          subscribers.delete(handler);
        }
        messageHandlers.clear();
      }),
    };

    return instance;
  };

  const RedisMock = Object.assign(
    jest.fn().mockImplementation(() => {
      const instance = {
        ...createInstance(),
      };
      return instance;
    }),
    {
      __store: store,
      __subscribers: subscribers,
    },
  );

  return {
    __esModule: true,
    default: RedisMock,
  };
});

import { MaxMembershipLookupService } from './max-membership-lookup.service';

function createConfigMock() {
  return {
    getOrThrow: jest.fn((key: string) => {
      if (key === 'REDIS_URL') {
        return 'redis://localhost:6379/0';
      }

      throw new Error(`Unexpected config key ${key}`);
    }),
  };
}

describe('MaxMembershipLookupService', () => {
  beforeEach(() => {
    (Redis as unknown as { __store: Map<string, string> }).__store.clear();
    (
      Redis as unknown as { __subscribers: Set<(channel: string, payload: string) => void> }
    ).__subscribers.clear();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('reuses a positive membership snapshot across policies while it remains fresh enough', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-29T10:00:00.000Z'));

    const maxClient = {
      hasChatMember: jest.fn().mockResolvedValue(true),
      getChatMembersAccess: jest.fn(),
    };
    const service = new MaxMembershipLookupService(maxClient as never, createConfigMock() as never);

    await expect(
      service.getMembership('channel-1', 'user-1', 'giveaway_interactive'),
    ).resolves.toBe(true);

    jest.advanceTimersByTime(12_000);

    await expect(
      service.getMembership('channel-1', 'user-1', 'moderation_required_subscription'),
    ).resolves.toBe(true);

    expect(maxClient.hasChatMember).toHaveBeenCalledTimes(1);
  });

  it('expires negative snapshots sooner than positive ones', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-29T10:05:00.000Z'));

    const maxClient = {
      hasChatMember: jest.fn().mockResolvedValue(false),
      getChatMembersAccess: jest.fn(),
    };
    const service = new MaxMembershipLookupService(maxClient as never, createConfigMock() as never);

    await expect(
      service.getMembership('channel-1', 'user-2', 'giveaway_interactive'),
    ).resolves.toBe(false);

    jest.advanceTimersByTime(2_000);
    await expect(
      service.getMembership('channel-1', 'user-2', 'giveaway_interactive'),
    ).resolves.toBe(false);

    jest.advanceTimersByTime(2_000);
    await expect(
      service.getMembership('channel-1', 'user-2', 'giveaway_interactive'),
    ).resolves.toBe(false);

    expect(maxClient.hasChatMember).toHaveBeenCalledTimes(2);
  });

  it('uses MAX batch membership lookups for shared chat checks and reuses the cached result later', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-29T10:10:00.000Z'));

    const maxClient = {
      hasChatMember: jest.fn(),
      getChatMembersAccess: jest
        .fn()
        .mockResolvedValue(new Map([['user-1', { userId: 'user-1', isAdmin: false }]])),
    };
    const service = new MaxMembershipLookupService(maxClient as never, createConfigMock() as never);

    await expect(
      service.getMemberships('channel-1', ['user-1', 'user-2'], 'giveaway_draw_background', {
        forceRefresh: true,
        allowStaleOnError: false,
      }),
    ).resolves.toEqual(
      new Map([
        ['user-1', true],
        ['user-2', false],
      ]),
    );

    await expect(
      service.getMembership('channel-1', 'user-2', 'giveaway_interactive'),
    ).resolves.toBe(false);

    expect(maxClient.getChatMembersAccess).toHaveBeenCalledTimes(1);
    expect(maxClient.hasChatMember).not.toHaveBeenCalled();
  });

  it('returns stale membership on transient errors only when the policy allows it', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-29T10:15:00.000Z'));

    const maxClient = {
      hasChatMember: jest
        .fn()
        .mockResolvedValueOnce(true)
        .mockRejectedValueOnce(
          Object.assign(new Error('MAX API rate limit exceeded'), {
            response: { status: 429, data: { message: 'MAX API rate limit exceeded' } },
          }),
        ),
      getChatMembersAccess: jest.fn(),
    };
    const service = new MaxMembershipLookupService(maxClient as never, createConfigMock() as never);

    await expect(
      service.getMembership('channel-1', 'user-3', 'moderation_required_subscription'),
    ).resolves.toBe(true);

    jest.advanceTimersByTime(20_000);

    await expect(
      service.getMembership('channel-1', 'user-3', 'moderation_required_subscription', {
        forceRefresh: true,
      }),
    ).resolves.toBe(true);

    await expect(
      service.getMembership('channel-1', 'user-3', 'giveaway_strict', {
        forceRefresh: true,
        allowStaleOnError: false,
      }),
    ).resolves.toBeNull();
  });

  it('invalidates cached membership snapshots and forces a fresh lookup', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-29T10:20:00.000Z'));

    const maxClient = {
      hasChatMember: jest.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false),
      getChatMembersAccess: jest.fn(),
    };
    const service = new MaxMembershipLookupService(maxClient as never, createConfigMock() as never);

    await expect(
      service.getMembership('channel-1', 'user-4', 'giveaway_interactive'),
    ).resolves.toBe(true);
    await service.invalidateMemberships('channel-1', ['user-4']);
    await expect(
      service.getMembership('channel-1', 'user-4', 'giveaway_interactive'),
    ).resolves.toBe(false);

    expect(maxClient.hasChatMember).toHaveBeenCalledTimes(2);
  });

  it('starts a fresh lookup instead of reusing an invalidated in-flight promise', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-29T10:25:00.000Z'));

    let resolveLookup: ((value: boolean) => void) | null = null;
    const maxClient = {
      hasChatMember: jest
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<boolean>((resolve) => {
              resolveLookup = resolve;
            }),
        )
        .mockResolvedValueOnce(false),
      getChatMembersAccess: jest.fn(),
    };
    const service = new MaxMembershipLookupService(maxClient as never, createConfigMock() as never);

    const pendingLookup = service.getMembership('channel-1', 'user-5', 'giveaway_interactive', {
      forceRefresh: true,
    });

    await service.invalidateMemberships('channel-1', ['user-5']);
    await expect(
      service.getMembership('channel-1', 'user-5', 'giveaway_interactive'),
    ).resolves.toBe(false);

    const finishLookup = resolveLookup as ((value: boolean) => void) | null;
    if (!finishLookup) {
      throw new Error('Expected pending membership lookup resolver');
    }
    finishLookup(true);
    await expect(pendingLookup).resolves.toBe(true);

    await expect(
      service.getMembership('channel-1', 'user-5', 'giveaway_interactive'),
    ).resolves.toBe(false);

    expect(maxClient.hasChatMember).toHaveBeenCalledTimes(2);
  });

  it('propagates membership invalidations across instances via Redis pub/sub', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-29T10:30:00.000Z'));

    const maxClientA = {
      hasChatMember: jest.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false),
      getChatMembersAccess: jest.fn(),
    };
    const maxClientB = {
      hasChatMember: jest.fn(),
      getChatMembersAccess: jest.fn(),
    };
    const serviceA = new MaxMembershipLookupService(
      maxClientA as never,
      createConfigMock() as never,
    );
    const serviceB = new MaxMembershipLookupService(
      maxClientB as never,
      createConfigMock() as never,
    );

    await serviceA.onModuleInit();
    await serviceB.onModuleInit();

    await expect(
      serviceA.getMembership('channel-1', 'user-6', 'giveaway_interactive'),
    ).resolves.toBe(true);

    await serviceB.invalidateMemberships('channel-1', ['user-6']);

    await expect(
      serviceA.getMembership('channel-1', 'user-6', 'giveaway_interactive'),
    ).resolves.toBe(false);

    expect(maxClientA.hasChatMember).toHaveBeenCalledTimes(2);
    expect(maxClientB.hasChatMember).not.toHaveBeenCalled();

    await serviceA.onModuleDestroy();
    await serviceB.onModuleDestroy();
  });
});
