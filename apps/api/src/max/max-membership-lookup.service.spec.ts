import Redis from 'ioredis';

jest.mock('ioredis', () => {
  const store = new Map<string, string>();
  const subscribers = new Set<(channel: string, payload: string) => void>();
  const createInstance = () => {
    const messageHandlers = new Set<(channel: string, payload: string) => void>();
    const instance = {
      get: jest.fn().mockImplementation(async (key: string) => store.get(key) ?? null),
      mget: jest
        .fn()
        .mockImplementation(async (...keys: string[]) => keys.map((key) => store.get(key) ?? null)),
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

function createConfigMock(overrides: Partial<Record<string, number | string | boolean>> = {}) {
  return {
    getOrThrow: jest.fn((key: string) => {
      if (key === 'REDIS_URL') {
        return 'redis://localhost:6379/0';
      }

      throw new Error(`Unexpected config key ${key}`);
    }),
    get: jest.fn((key: string, fallback?: unknown) => {
      if (key in overrides) {
        return overrides[key];
      }
      if (key === 'MAX_MEMBERSHIP_LOOKUP_BATCH_WINDOW_MS') {
        return 0;
      }
      return fallback;
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

  it('disables Redis ready check on the pub/sub subscriber connection', () => {
    const maxClient = {
      hasChatMember: jest.fn(),
      getChatMembersAccess: jest.fn(),
    };

    new MaxMembershipLookupService(maxClient as never, createConfigMock() as never);

    const redisInstance = (Redis as unknown as jest.Mock).mock.results.at(-1)?.value as {
      duplicate: jest.Mock;
    };
    expect(redisInstance.duplicate).toHaveBeenCalledWith({ enableReadyCheck: false });
  });

  it('reuses a positive membership snapshot across policies while it remains fresh enough', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-29T10:00:00.000Z'));

    const maxClient = {
      hasChatMember: jest.fn(),
      getChatMembersAccess: jest
        .fn()
        .mockResolvedValue(new Map([['user-1', { userId: 'user-1', isAdmin: false }]])),
    };
    const service = new MaxMembershipLookupService(maxClient as never, createConfigMock() as never);

    await expect(
      service.getMembership('channel-1', 'user-1', 'giveaway_interactive'),
    ).resolves.toBe(true);

    jest.advanceTimersByTime(12_000);

    await expect(
      service.getMembership('channel-1', 'user-1', 'moderation_required_subscription'),
    ).resolves.toBe(true);

    expect(maxClient.getChatMembersAccess).toHaveBeenCalledTimes(1);
    expect(maxClient.hasChatMember).not.toHaveBeenCalled();
  });

  it('keeps a positive required-subscription snapshot warm for fifteen seconds', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-29T10:01:00.000Z'));

    const maxClient = {
      hasChatMember: jest.fn(),
      getChatMembersAccess: jest
        .fn()
        .mockResolvedValue(new Map([['user-1', { userId: 'user-1', isAdmin: false }]])),
    };
    const service = new MaxMembershipLookupService(maxClient as never, createConfigMock() as never);

    await expect(
      service.getMembership('channel-1', 'user-1', 'moderation_required_subscription'),
    ).resolves.toBe(true);

    jest.advanceTimersByTime(12_000);

    await expect(
      service.getMembership('channel-1', 'user-1', 'moderation_required_subscription'),
    ).resolves.toBe(true);

    expect(maxClient.getChatMembersAccess).toHaveBeenCalledTimes(1);
  });

  it('expires negative snapshots sooner than positive ones', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-29T10:05:00.000Z'));

    const maxClient = {
      hasChatMember: jest.fn(),
      getChatMembersAccess: jest.fn().mockResolvedValue(new Map()),
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

    expect(maxClient.getChatMembersAccess).toHaveBeenCalledTimes(2);
    expect(maxClient.hasChatMember).not.toHaveBeenCalled();
  });

  it('reports whether membership resolutions are fresh or stale fallbacks', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-29T10:07:00.000Z'));

    const timeoutError = Object.assign(new Error('lookup timeout'), {
      code: 'ECONNABORTED',
    });
    const maxClient = {
      hasChatMember: jest.fn(),
      getChatMembersAccess: jest
        .fn()
        .mockResolvedValueOnce(new Map())
        .mockRejectedValueOnce(timeoutError),
    };
    const service = new MaxMembershipLookupService(maxClient as never, createConfigMock() as never);

    await expect(
      service.getMembershipResolution('channel-1', 'user-2', 'giveaway_interactive'),
    ).resolves.toEqual({ membership: false, fresh: true });

    jest.advanceTimersByTime(4_000);

    await expect(
      service.getMembershipResolution('channel-1', 'user-2', 'giveaway_interactive', {
        allowStaleOnError: true,
      }),
    ).resolves.toEqual({ membership: false, fresh: false });

    expect(maxClient.getChatMembersAccess).toHaveBeenCalledTimes(2);
    expect(maxClient.hasChatMember).not.toHaveBeenCalled();
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

  it('uses member-access bot resolution before falling back to the generic chat binding', async () => {
    const maxClient = {
      hasChatMember: jest.fn(),
      getChatMembersAccess: jest
        .fn()
        .mockResolvedValue(new Map([['user-1', { userId: 'user-1', isAdmin: false }]])),
    };
    const maxBotLinkService = {
      resolveBotIdForMemberAccess: jest.fn().mockResolvedValue('id613002203036_4_bot'),
      resolveBotId: jest.fn(),
    };
    const service = new MaxMembershipLookupService(
      maxClient as never,
      createConfigMock() as never,
      maxBotLinkService as never,
    );

    await expect(
      service.getMembership('channel-lookup', 'user-1', 'moderation_required_subscription', {
        forceRefresh: true,
      }),
    ).resolves.toBe(true);

    expect(maxBotLinkService.resolveBotIdForMemberAccess).toHaveBeenCalledWith({
      chatId: 'channel-lookup',
    });
    expect(maxBotLinkService.resolveBotId).not.toHaveBeenCalled();
    expect(maxClient.getChatMembersAccess).toHaveBeenCalledWith(
      'channel-lookup',
      ['user-1'],
      expect.objectContaining({
        botId: 'id613002203036_4_bot',
      }),
    );
  });

  it('uses the unified read route when the link service exposes it', async () => {
    const maxClient = {
      hasChatMember: jest.fn(),
      getChatMembersAccess: jest
        .fn()
        .mockResolvedValue(new Map([['user-1', { userId: 'user-1', isAdmin: false }]])),
    };
    const maxBotLinkService = {
      resolveBotRoute: jest.fn().mockResolvedValue({
        purpose: 'read',
        chatId: 'channel-route-lookup',
        primaryBotId: 'id613002203036_bot',
        botId: 'id613002203036_4_bot',
        candidateBotIds: ['id613002203036_4_bot'],
        reason: 'alternate_confirmed',
      }),
    };
    const service = new MaxMembershipLookupService(
      maxClient as never,
      createConfigMock() as never,
      maxBotLinkService as never,
    );

    await expect(
      service.getMembership('channel-route-lookup', 'user-1', 'moderation_required_subscription', {
        forceRefresh: true,
      }),
    ).resolves.toBe(true);

    expect(maxBotLinkService.resolveBotRoute).toHaveBeenCalledWith({
      purpose: 'read',
      chatId: 'channel-route-lookup',
    });
    expect(maxClient.getChatMembersAccess).toHaveBeenCalledWith(
      'channel-route-lookup',
      ['user-1'],
      expect.objectContaining({
        botId: 'id613002203036_4_bot',
      }),
    );
  });

  it('keeps membership cache isolated per bot scope while leaving chat-level hot state shared', async () => {
    const maxClient = {
      hasChatMember: jest.fn(),
      getChatMembersAccess: jest
        .fn()
        .mockResolvedValueOnce(new Map([['user-1', { userId: 'user-1', isAdmin: false }]]))
        .mockResolvedValueOnce(new Map()),
    };
    const maxBotRegistry = {
      getBotById: jest.fn((botId: string) => ({ id: botId })),
      getAllBots: jest.fn(() => [{ id: 'bot-a' }, { id: 'bot-b' }]),
    };
    const service = new MaxMembershipLookupService(
      maxClient as never,
      createConfigMock() as never,
      undefined,
      maxBotRegistry as never,
    );

    await expect(
      service.getMembership('channel-shared', 'user-1', 'moderation_required_subscription', {
        botId: 'bot-a',
      }),
    ).resolves.toBe(true);

    await expect(
      service.getMembership('channel-shared', 'user-1', 'moderation_required_subscription', {
        botId: 'bot-b',
      }),
    ).resolves.toBe(false);

    await expect(
      service.getMembership('channel-shared', 'user-1', 'moderation_required_subscription', {
        botId: 'bot-a',
      }),
    ).resolves.toBe(true);

    expect(maxClient.getChatMembersAccess).toHaveBeenCalledTimes(2);
    expect(maxClient.getChatMembersAccess).toHaveBeenNthCalledWith(
      1,
      'channel-shared',
      ['user-1'],
      expect.objectContaining({
        botId: 'bot-a',
      }),
    );
    expect(maxClient.getChatMembersAccess).toHaveBeenNthCalledWith(
      2,
      'channel-shared',
      ['user-1'],
      expect.objectContaining({
        botId: 'bot-b',
      }),
    );
  });

  it('does not let a stalled redis membership read block the fallback MAX lookup', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-29T10:11:00.000Z'));

    const maxClient = {
      hasChatMember: jest.fn(),
      getChatMembersAccess: jest
        .fn()
        .mockResolvedValue(
          new Map([['user-redis-timeout', { userId: 'user-redis-timeout', isAdmin: false }]]),
        ),
    };
    const service = new MaxMembershipLookupService(maxClient as never, createConfigMock() as never);
    const redisInstance = (Redis as unknown as jest.Mock).mock.results[0]?.value as {
      mget: jest.Mock;
    };
    redisInstance.mget.mockImplementationOnce(() => new Promise(() => undefined));

    const pendingLookup = service.getMembership(
      'channel-redis-timeout',
      'user-redis-timeout',
      'moderation_required_subscription',
    );
    await jest.advanceTimersByTimeAsync(150);

    await expect(pendingLookup).resolves.toBe(true);
    expect(maxClient.getChatMembersAccess).toHaveBeenCalledTimes(1);
    expect(maxClient.getChatMembersAccess).toHaveBeenCalledWith(
      'channel-redis-timeout',
      ['user-redis-timeout'],
      expect.objectContaining({
        trafficClass: 'critical',
        timeoutMs: 1500,
        sourceTag: 'required_subscription_membership',
        ignoreFailureMetricStatuses: [403, 404],
      }),
    );
    expect(maxClient.hasChatMember).not.toHaveBeenCalled();
  });

  it('coalesces concurrent single-user lookups for the same chat into one MAX batch request', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-29T10:12:00.000Z'));

    const maxClient = {
      hasChatMember: jest.fn(),
      getChatMembersAccess: jest.fn().mockResolvedValue(
        new Map([
          ['user-1', { userId: 'user-1', isAdmin: false }],
          ['user-3', { userId: 'user-3', isAdmin: false }],
        ]),
      ),
    };
    const service = new MaxMembershipLookupService(maxClient as never, createConfigMock() as never);

    await expect(
      Promise.all([
        service.getMembership('channel-1', 'user-1', 'moderation_required_subscription', {
          forceRefresh: true,
        }),
        service.getMembership('channel-1', 'user-2', 'moderation_required_subscription', {
          forceRefresh: true,
        }),
        service.getMembership('channel-1', 'user-3', 'moderation_required_subscription', {
          forceRefresh: true,
        }),
      ]),
    ).resolves.toEqual([true, false, true]);

    expect(maxClient.getChatMembersAccess).toHaveBeenCalledTimes(1);
    expect(maxClient.getChatMembersAccess).toHaveBeenCalledWith(
      'channel-1',
      ['user-1', 'user-2', 'user-3'],
      {
        trafficClass: 'critical',
        timeoutMs: 1_500,
        sourceTag: 'required_subscription_membership',
        ignoreFailureMetricStatuses: [403, 404],
      },
    );
    expect(maxClient.hasChatMember).not.toHaveBeenCalled();
  });

  it('routes membership lookups through the chat-bound bot when one is assigned', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-29T10:12:30.000Z'));

    const maxClient = {
      hasChatMember: jest.fn(),
      getChatMembersAccess: jest
        .fn()
        .mockResolvedValue(new Map([['user-1', { userId: 'user-1', isAdmin: false }]])),
    };
    const maxBotLinkService = {
      resolveBotId: jest.fn().mockResolvedValue('id613002203036_4_bot'),
    };
    const service = new MaxMembershipLookupService(
      maxClient as never,
      createConfigMock() as never,
      maxBotLinkService as never,
    );

    await expect(
      service.getMembership('channel-1', 'user-1', 'moderation_required_subscription', {
        forceRefresh: true,
      }),
    ).resolves.toBe(true);

    expect(maxBotLinkService.resolveBotId).toHaveBeenCalledWith({ chatId: 'channel-1' });
    expect(maxClient.getChatMembersAccess).toHaveBeenCalledWith('channel-1', ['user-1'], {
      trafficClass: 'critical',
      timeoutMs: 1_500,
      sourceTag: 'required_subscription_membership',
      ignoreFailureMetricStatuses: [403, 404],
      botId: 'id613002203036_4_bot',
    });
  });

  it('debounces hot single-user moderation lookups long enough to batch near-simultaneous updates', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-29T10:13:00.000Z'));

    const maxClient = {
      hasChatMember: jest.fn(),
      getChatMembersAccess: jest.fn().mockResolvedValue(
        new Map([
          ['user-7', { userId: 'user-7', isAdmin: false }],
          ['user-8', { userId: 'user-8', isAdmin: false }],
        ]),
      ),
    };
    const service = new MaxMembershipLookupService(
      maxClient as never,
      createConfigMock({
        MAX_MEMBERSHIP_LOOKUP_BATCH_WINDOW_MS: 12,
      }) as never,
    );

    const firstLookup = service.getMembership(
      'channel-2',
      'user-7',
      'moderation_required_subscription',
      {
        forceRefresh: true,
      },
    );
    jest.advanceTimersByTime(6);
    const secondLookup = service.getMembership(
      'channel-2',
      'user-8',
      'moderation_required_subscription',
      {
        forceRefresh: true,
      },
    );

    expect(maxClient.getChatMembersAccess).not.toHaveBeenCalled();

    jest.advanceTimersByTime(6);

    await expect(Promise.all([firstLookup, secondLookup])).resolves.toEqual([true, true]);
    expect(maxClient.getChatMembersAccess).toHaveBeenCalledTimes(1);
    expect(maxClient.getChatMembersAccess).toHaveBeenCalledWith('channel-2', ['user-7', 'user-8'], {
      trafficClass: 'critical',
      timeoutMs: 1_500,
      sourceTag: 'required_subscription_membership',
      ignoreFailureMetricStatuses: [403, 404],
    });
  });

  it('backs off repeated lookups for the same chat after a transient batch failure', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-29T10:14:00.000Z'));

    const throttleError = Object.assign(new Error('MAX API rate limit exceeded'), {
      response: { status: 429, data: { message: 'MAX API rate limit exceeded' } },
    });
    const maxClient = {
      hasChatMember: jest.fn(),
      getChatMembersAccess: jest
        .fn()
        .mockRejectedValueOnce(throttleError)
        .mockResolvedValueOnce(new Map([['user-3', { userId: 'user-3', isAdmin: false }]])),
    };
    const service = new MaxMembershipLookupService(maxClient as never, createConfigMock() as never);

    await expect(
      Promise.all([
        service.getMembership('channel-1', 'user-1', 'moderation_required_subscription', {
          forceRefresh: true,
        }),
        service.getMembership('channel-1', 'user-2', 'moderation_required_subscription', {
          forceRefresh: true,
        }),
      ]),
    ).resolves.toEqual([null, null]);

    await expect(
      service.getMembership('channel-1', 'user-3', 'moderation_required_subscription'),
    ).resolves.toBeNull();

    expect(maxClient.getChatMembersAccess).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(15_001);

    await expect(
      service.getMembership('channel-1', 'user-3', 'moderation_required_subscription'),
    ).resolves.toBe(true);

    expect(maxClient.getChatMembersAccess).toHaveBeenCalledTimes(2);
    expect(maxClient.hasChatMember).not.toHaveBeenCalled();
  });

  it('persists a terminal single-user probe without reviving rejected lifecycle state', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-29T10:14:15.000Z'));

    const deniedError = Object.assign(new Error('Request failed with status code 403'), {
      response: {
        status: 403,
        data: { code: 'chat.denied', message: 'Request failed with status code 403' },
      },
    });
    const maxClient = {
      hasChatMember: jest.fn(),
      getChatMembersAccess: jest
        .fn()
        .mockRejectedValueOnce(deniedError)
        .mockResolvedValueOnce(new Map([['user-2', { userId: 'user-2', isAdmin: false }]])),
    };
    const maxBotLinkService = {
      recordBotAccessProbe: jest.fn().mockResolvedValue(false),
    };
    const service = new MaxMembershipLookupService(
      maxClient as never,
      createConfigMock() as never,
      maxBotLinkService as never,
    );

    await expect(
      service.getMembership('channel-denied', 'user-1', 'giveaway_draw_background', {
        forceRefresh: true,
        allowStaleOnError: false,
        botId: 'bot-1',
      }),
    ).resolves.toBeNull();

    await expect(
      service.getMembership('channel-denied', 'user-2', 'giveaway_draw_background', {
        forceRefresh: true,
        allowStaleOnError: false,
        botId: 'bot-1',
      }),
    ).resolves.toBeNull();

    expect(maxClient.getChatMembersAccess).toHaveBeenCalledTimes(1);
    expect(maxBotLinkService.recordBotAccessProbe).toHaveBeenCalledTimes(1);
    expect(maxBotLinkService.recordBotAccessProbe).toHaveBeenCalledWith({
      chatId: 'channel-denied',
      botId: 'bot-1',
      access: null,
      source: 'membership_lookup_giveaway_draw_background',
      checkedAt: new Date('2026-03-29T10:14:15.000Z'),
      lastErrorCode: 'chat.denied',
      allowMembershipRecovery: false,
    });
    expect(service.getLookupIssue('channel-denied', 'giveaway_draw_background')).toEqual(
      expect.objectContaining({
        chatId: 'channel-denied',
        policyName: 'giveaway_draw_background',
        kind: 'terminal',
        retryAfterMs: 30 * 60 * 1_000,
        statusCode: 403,
      }),
    );

    jest.advanceTimersByTime(30 * 60 * 1_000 + 1);

    await expect(
      service.getMembership('channel-denied', 'user-2', 'giveaway_draw_background', {
        forceRefresh: true,
        allowStaleOnError: false,
        botId: 'bot-1',
      }),
    ).resolves.toBe(true);

    expect(maxClient.getChatMembersAccess).toHaveBeenCalledTimes(2);
    expect(maxClient.hasChatMember).not.toHaveBeenCalled();
  });

  it('persists a terminal multi-user probe before strict required subscription backoff', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-29T10:15:00.000Z'));

    const deniedError = Object.assign(new Error('Request failed with status code 404'), {
      response: {
        status: 404,
        data: { code: 'chat.not.found', message: 'Request failed with status code 404' },
      },
    });
    const maxClient = {
      hasChatMember: jest.fn(),
      getChatMembersAccess: jest
        .fn()
        .mockRejectedValueOnce(deniedError)
        .mockResolvedValueOnce(new Map([['user-3', { userId: 'user-3', isAdmin: false }]])),
    };
    const runtimeDiagnosticsService = {
      recordMembershipBackoff: jest.fn(),
      recordMembershipIssue: jest.fn(),
    };
    const maxBotLinkService = {
      recordBotAccessProbe: jest.fn().mockResolvedValue(true),
    };
    const service = new MaxMembershipLookupService(
      maxClient as never,
      createConfigMock({
        MAX_MEMBERSHIP_LOOKUP_REQUIRED_SUBSCRIPTION_TERMINAL_BACKOFF_MS: 60_000,
      }) as never,
      maxBotLinkService as never,
      undefined,
      runtimeDiagnosticsService as never,
    );

    await expect(
      service.getMemberships(
        'channel-denied',
        ['user-1', 'user-2'],
        'moderation_required_subscription',
        {
          forceRefresh: true,
          allowStaleOnError: false,
          botId: 'bot-1',
        },
      ),
    ).resolves.toEqual(
      new Map([
        ['user-1', null],
        ['user-2', null],
      ]),
    );

    expect(maxClient.getChatMembersAccess).toHaveBeenCalledWith(
      'channel-denied',
      ['user-1', 'user-2'],
      {
        trafficClass: 'critical',
        timeoutMs: 1_500,
        sourceTag: 'required_subscription_membership',
        ignoreFailureMetricStatuses: [403, 404],
        botId: 'bot-1',
      },
    );

    await expect(
      service.getMembership('channel-denied', 'user-3', 'moderation_required_subscription', {
        forceRefresh: true,
        allowStaleOnError: false,
        botId: 'bot-1',
      }),
    ).resolves.toBeNull();

    expect(maxClient.getChatMembersAccess).toHaveBeenCalledTimes(1);
    expect(maxBotLinkService.recordBotAccessProbe).toHaveBeenCalledTimes(1);
    expect(maxBotLinkService.recordBotAccessProbe).toHaveBeenCalledWith({
      chatId: 'channel-denied',
      botId: 'bot-1',
      access: null,
      source: 'membership_lookup_moderation_required_subscription',
      checkedAt: new Date('2026-03-29T10:15:00.000Z'),
      lastErrorCode: 'chat.not.found',
      allowMembershipRecovery: false,
    });
    expect(service.getLookupIssue('channel-denied', 'moderation_required_subscription')).toEqual(
      expect.objectContaining({
        chatId: 'channel-denied',
        policyName: 'moderation_required_subscription',
        kind: 'terminal',
        retryAfterMs: 60_000,
        statusCode: 404,
      }),
    );
    expect(runtimeDiagnosticsService.recordMembershipBackoff).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'channel-denied',
        policyName: 'moderation_required_subscription',
        retryAfterMs: 60_000,
      }),
    );
    expect(runtimeDiagnosticsService.recordMembershipIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'channel-denied',
        policyName: 'moderation_required_subscription',
        kind: 'terminal',
        retryAfterMs: 60_000,
      }),
    );

    jest.advanceTimersByTime(60_001);

    await expect(
      service.getMembership('channel-denied', 'user-3', 'moderation_required_subscription', {
        forceRefresh: true,
        allowStaleOnError: false,
        botId: 'bot-1',
      }),
    ).resolves.toBe(true);

    expect(maxClient.getChatMembersAccess).toHaveBeenCalledTimes(2);
    expect(maxClient.hasChatMember).not.toHaveBeenCalled();
  });

  it('fails open instead of hanging the caller when a membership batch lookup never resolves', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-29T10:14:30.000Z'));

    const maxClient = {
      hasChatMember: jest.fn(),
      getChatMembersAccess: jest.fn().mockImplementation(
        () =>
          new Promise<Map<string, { userId: string; isAdmin: boolean }>>(() => {
            // Intentionally never resolves to simulate a transport/runtime hang.
          }),
      ),
    };
    const service = new MaxMembershipLookupService(
      maxClient as never,
      createConfigMock({
        MAX_MEMBERSHIP_LOOKUP_TIMEOUT_MS_CRITICAL: 50,
      }) as never,
    );

    const lookup = service.getMembership(
      'channel-hang',
      'user-hang',
      'moderation_required_subscription',
      {
        forceRefresh: true,
      },
    );

    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(801);

    await expect(lookup).resolves.toBeNull();
    expect(maxClient.getChatMembersAccess).toHaveBeenCalledTimes(1);
    expect(maxClient.hasChatMember).not.toHaveBeenCalled();
  });

  it('extends chat backoff after consecutive transient failures on the same moderation channel', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-29T10:14:00.000Z'));

    const throttleError = Object.assign(new Error('MAX API rate limit exceeded'), {
      response: { status: 429, data: { message: 'MAX API rate limit exceeded' } },
    });
    const maxClient = {
      hasChatMember: jest.fn(),
      getChatMembersAccess: jest
        .fn()
        .mockRejectedValueOnce(throttleError)
        .mockRejectedValueOnce(throttleError)
        .mockResolvedValueOnce(new Map([['user-4', { userId: 'user-4', isAdmin: false }]])),
    };
    const service = new MaxMembershipLookupService(
      maxClient as never,
      createConfigMock({
        MAX_MEMBERSHIP_LOOKUP_HOT_CHANNEL_BATCH_WINDOW_MS: 0,
      }) as never,
    );

    await expect(
      service.getMembership('channel-hot', 'user-1', 'moderation_required_subscription', {
        forceRefresh: true,
      }),
    ).resolves.toBeNull();

    jest.advanceTimersByTime(15_001);

    await expect(
      service.getMembership('channel-hot', 'user-2', 'moderation_required_subscription', {
        forceRefresh: true,
      }),
    ).resolves.toBeNull();

    await expect(
      service.getMembership('channel-hot', 'user-3', 'moderation_required_subscription'),
    ).resolves.toBeNull();

    expect(maxClient.getChatMembersAccess).toHaveBeenCalledTimes(2);

    jest.advanceTimersByTime(29_999);

    await expect(
      service.getMembership('channel-hot', 'user-4', 'moderation_required_subscription'),
    ).resolves.toBeNull();

    expect(maxClient.getChatMembersAccess).toHaveBeenCalledTimes(2);

    jest.advanceTimersByTime(2);

    await expect(
      service.getMembership('channel-hot', 'user-4', 'moderation_required_subscription'),
    ).resolves.toBe(true);

    expect(maxClient.getChatMembersAccess).toHaveBeenCalledTimes(3);
    expect(maxClient.hasChatMember).not.toHaveBeenCalled();
  });

  it('does not return stale required-subscription membership on transient errors, but still allows it for interactive policies', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-29T10:15:00.000Z'));

    const maxClient = {
      hasChatMember: jest.fn(),
      getChatMembersAccess: jest
        .fn()
        .mockResolvedValueOnce(new Map([['user-3', { userId: 'user-3', isAdmin: false }]]))
        .mockRejectedValueOnce(
          Object.assign(new Error('MAX API rate limit exceeded'), {
            response: { status: 429, data: { message: 'MAX API rate limit exceeded' } },
          }),
        )
        .mockRejectedValueOnce(
          Object.assign(new Error('MAX API rate limit exceeded'), {
            response: { status: 429, data: { message: 'MAX API rate limit exceeded' } },
          }),
        ),
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
    ).resolves.toBeNull();

    await expect(
      service.getMembership('channel-1', 'user-3', 'giveaway_interactive', {
        forceRefresh: true,
      }),
    ).resolves.toBe(true);
  });

  it('returns stale background giveaway membership when a retained positive snapshot exists', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-29T10:15:00.000Z'));

    const maxClient = {
      hasChatMember: jest.fn(),
      getChatMembersAccess: jest
        .fn()
        .mockResolvedValueOnce(new Map([['user-3', { userId: 'user-3', isAdmin: false }]]))
        .mockRejectedValueOnce(
          Object.assign(new Error('MAX API rate limit exceeded'), {
            response: { status: 429, data: { message: 'MAX API rate limit exceeded' } },
          }),
        ),
    };
    const service = new MaxMembershipLookupService(maxClient as never, createConfigMock() as never);

    await expect(
      service.getMembership('channel-1', 'user-3', 'giveaway_draw_background', {
        forceRefresh: true,
        allowStaleOnError: false,
      }),
    ).resolves.toBe(true);

    jest.advanceTimersByTime(11_000);

    await expect(
      service.getMembership('channel-1', 'user-3', 'giveaway_draw_background', {
        forceRefresh: true,
        allowStaleOnError: true,
      }),
    ).resolves.toBe(true);
  });

  it('extends positive moderation freshness on hot channels after repeated transient failures', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-29T10:16:00.000Z'));

    const throttleError = Object.assign(new Error('MAX API rate limit exceeded'), {
      response: { status: 429, data: { message: 'MAX API rate limit exceeded' } },
    });
    const maxClient = {
      hasChatMember: jest.fn(),
      getChatMembersAccess: jest
        .fn()
        .mockResolvedValueOnce(
          new Map([['user-stale-positive', { userId: 'user-stale-positive', isAdmin: false }]]),
        )
        .mockRejectedValueOnce(throttleError)
        .mockRejectedValueOnce(throttleError),
    };
    const service = new MaxMembershipLookupService(maxClient as never, createConfigMock() as never);

    await expect(
      service.getMembership(
        'channel-hot-mode',
        'user-stale-positive',
        'moderation_required_subscription',
      ),
    ).resolves.toBe(true);

    jest.advanceTimersByTime(61_000);

    await expect(
      service.getMembership(
        'channel-hot-mode',
        'user-trigger-1',
        'moderation_required_subscription',
        {
          forceRefresh: true,
        },
      ),
    ).resolves.toBeNull();
    jest.advanceTimersByTime(15_001);
    await expect(
      service.getMembership(
        'channel-hot-mode',
        'user-trigger-2',
        'moderation_required_subscription',
        {
          forceRefresh: true,
        },
      ),
    ).resolves.toBeNull();

    await expect(
      service.getMembership(
        'channel-hot-mode',
        'user-stale-positive',
        'moderation_required_subscription',
      ),
    ).resolves.toBe(true);

    expect(maxClient.getChatMembersAccess).toHaveBeenCalledTimes(3);
    expect(maxClient.hasChatMember).not.toHaveBeenCalled();
  });

  it('drops stale negative moderation snapshots in hot-channel mode and fails open instead', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-29T10:17:00.000Z'));

    const timeoutError = Object.assign(new Error('timeout of 2000ms exceeded'), {
      code: 'ECONNABORTED',
    });
    const maxClient = {
      hasChatMember: jest.fn(),
      getChatMembersAccess: jest
        .fn()
        .mockResolvedValueOnce(new Map())
        .mockRejectedValueOnce(timeoutError)
        .mockRejectedValueOnce(timeoutError),
    };
    const service = new MaxMembershipLookupService(maxClient as never, createConfigMock() as never);

    await expect(
      service.getMembership(
        'channel-hot-negative',
        'user-stale-negative',
        'moderation_required_subscription',
      ),
    ).resolves.toBe(false);

    jest.advanceTimersByTime(11_000);

    await expect(
      service.getMembership(
        'channel-hot-negative',
        'user-trigger-1',
        'moderation_required_subscription',
        { forceRefresh: true },
      ),
    ).resolves.toBeNull();
    jest.advanceTimersByTime(15_001);
    await expect(
      service.getMembership(
        'channel-hot-negative',
        'user-trigger-2',
        'moderation_required_subscription',
        { forceRefresh: true },
      ),
    ).resolves.toBeNull();

    await expect(
      service.getMembership(
        'channel-hot-negative',
        'user-stale-negative',
        'moderation_required_subscription',
      ),
    ).resolves.toBeNull();

    expect(maxClient.getChatMembersAccess).toHaveBeenCalledTimes(3);
    expect(maxClient.hasChatMember).not.toHaveBeenCalled();
  });

  it('invalidates cached membership snapshots and forces a fresh lookup', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-29T10:20:00.000Z'));

    const maxClient = {
      hasChatMember: jest.fn(),
      getChatMembersAccess: jest
        .fn()
        .mockResolvedValueOnce(new Map([['user-4', { userId: 'user-4', isAdmin: false }]]))
        .mockResolvedValueOnce(new Map()),
    };
    const service = new MaxMembershipLookupService(maxClient as never, createConfigMock() as never);

    await expect(
      service.getMembership('channel-1', 'user-4', 'giveaway_interactive'),
    ).resolves.toBe(true);
    await service.invalidateMemberships('channel-1', ['user-4']);
    await expect(
      service.getMembership('channel-1', 'user-4', 'giveaway_interactive'),
    ).resolves.toBe(false);

    expect(maxClient.getChatMembersAccess).toHaveBeenCalledTimes(2);
    expect(maxClient.hasChatMember).not.toHaveBeenCalled();
  });

  it('starts a fresh lookup instead of reusing an invalidated in-flight promise', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-29T10:25:00.000Z'));

    let resolveLookup: ((value: Map<string, { userId: string; isAdmin: boolean }>) => void) | null =
      null;
    const maxClient = {
      hasChatMember: jest.fn(),
      getChatMembersAccess: jest
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<Map<string, { userId: string; isAdmin: boolean }>>((resolve) => {
              resolveLookup = resolve;
            }),
        )
        .mockResolvedValueOnce(new Map()),
    };
    const service = new MaxMembershipLookupService(maxClient as never, createConfigMock() as never);

    const pendingLookup = service.getMembership('channel-1', 'user-5', 'giveaway_interactive', {
      forceRefresh: true,
    });

    await service.invalidateMemberships('channel-1', ['user-5']);
    await expect(
      service.getMembership('channel-1', 'user-5', 'giveaway_interactive'),
    ).resolves.toBe(false);

    const finishLookup = resolveLookup as
      | ((value: Map<string, { userId: string; isAdmin: boolean }>) => void)
      | null;
    if (!finishLookup) {
      throw new Error('Expected pending membership lookup resolver');
    }
    finishLookup(new Map([['user-5', { userId: 'user-5', isAdmin: false }]]));
    await expect(pendingLookup).resolves.toBe(true);

    await expect(
      service.getMembership('channel-1', 'user-5', 'giveaway_interactive'),
    ).resolves.toBe(false);

    expect(maxClient.getChatMembersAccess).toHaveBeenCalledTimes(2);
    expect(maxClient.hasChatMember).not.toHaveBeenCalled();
  });

  it('propagates membership invalidations across instances via Redis pub/sub', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-29T10:30:00.000Z'));

    const maxClientA = {
      hasChatMember: jest.fn(),
      getChatMembersAccess: jest
        .fn()
        .mockResolvedValueOnce(new Map([['user-6', { userId: 'user-6', isAdmin: false }]]))
        .mockResolvedValueOnce(new Map()),
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

    expect(maxClientA.getChatMembersAccess).toHaveBeenCalledTimes(2);
    expect(maxClientA.hasChatMember).not.toHaveBeenCalled();
    expect(maxClientB.hasChatMember).not.toHaveBeenCalled();

    await serviceA.onModuleDestroy();
    await serviceB.onModuleDestroy();
  });
});
