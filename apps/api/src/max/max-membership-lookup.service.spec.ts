import Redis from 'ioredis';

jest.mock('ioredis', () => {
  const store = new Map<string, string>();
  const RedisMock = Object.assign(
    jest.fn().mockImplementation(() => ({
      get: jest.fn().mockImplementation(async (key: string) => store.get(key) ?? null),
      set: jest.fn().mockImplementation(async (key: string, value: string) => {
        store.set(key, value);
        return 'OK';
      }),
      quit: jest.fn().mockResolvedValue(undefined),
    })),
    {
      __store: store,
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
});
