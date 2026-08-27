import { ChatBotAccessState, ChatBotMembershipStatus } from '../prisma/prisma-client';
import {
  PublisherBindingRefreshSchedulerService,
  PublisherBindingRefreshService,
} from './publisher-binding-refresh.service';

const createBackgroundWork = () => ({
  runExclusive: jest.fn((_lane: string, operation: () => Promise<unknown>) => operation()),
});

describe('PublisherBindingRefreshService', () => {
  function createHarness(
    accessResult:
      | { isAdmin: boolean; isOwner: boolean; permissions: string[]; permissionsKnown: boolean }
      | Error,
    dispatchEnabled = true,
  ) {
    const prisma = {
      chat: {
        findUnique: jest.fn(async () => ({
          id: 'chat-1',
          publicationPolicy: null,
          botMemberships: [{ id: 'main-membership' }],
          publisherBinding: {
            publisherBotId: 'publik_bot',
            status: ChatBotMembershipStatus.ACTIVE,
            botAccessState: ChatBotAccessState.CONFIRMED_ADMIN as ChatBotAccessState,
            lastSeenAt: new Date('2026-08-26T11:55:00.000Z') as Date | null,
            lastWebhookAt: null as Date | null,
          },
        })),
      },
      publisherEntityBinding: {
        updateMany: jest.fn(async () => ({ count: 1 })),
      },
    };
    const maxClient = {
      getCurrentChatMemberAccess: jest.fn(async () => {
        if (accessResult instanceof Error) {
          throw accessResult;
        }
        return accessResult;
      }),
    };
    const credentials = {
      getBotId: jest.fn(() => 'publik_bot'),
      getRequiredActionToken: jest.fn(() => 'not-a-real-token'),
    };
    const dispatchHealth = {
      isGloballyPaused: jest.fn(async () => false),
      recordAuthenticatedSuccess: jest.fn(async () => undefined),
      recordGlobalAuthorizationFailure: jest.fn(async () => undefined),
    };
    const identityAttestation = {
      assertAttested: jest.fn(async () => undefined),
    };
    const service = new PublisherBindingRefreshService(
      prisma as never,
      maxClient as never,
      credentials as never,
      dispatchHealth as never,
      identityAttestation as never,
      { dispatchEnabled } as never,
    );
    return { service, prisma, maxClient, dispatchHealth, identityAttestation };
  }

  const job = {
    version: 1,
    chatId: 'chat-1',
    publisherBotId: 'publik_bot',
    reason: 'bootstrap',
    requestedAt: '2026-08-26T12:00:00.000Z',
  } as const;

  it('probes only the exact publisher bot and persists fresh access behind a lifecycle fence', async () => {
    const { service, prisma, maxClient, dispatchHealth } = createHarness({
      isAdmin: true,
      isOwner: false,
      permissions: ['write'],
      permissionsKnown: true,
    });

    await service.refresh(job);

    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({
        botId: 'publik_bot',
        bypassCache: true,
        sourceTag: 'publisher_readiness',
      }),
    );
    expect(prisma.publisherEntityBinding.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          chatId: 'chat-1',
          publisherBotId: 'publik_bot',
          AND: expect.any(Array),
        }),
        data: expect.objectContaining({
          status: ChatBotMembershipStatus.ACTIVE,
          botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
        }),
      }),
    );
    expect(dispatchHealth.recordAuthenticatedSuccess).toHaveBeenCalledTimes(1);
  });

  it('uses the publisher interactive lane for an explicit user recheck', async () => {
    const { service, maxClient } = createHarness({
      isAdmin: true,
      isOwner: false,
      permissions: ['write'],
      permissionsKnown: true,
    });

    await service.refresh({ ...job, reason: 'manual_recheck' });

    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({ trafficClass: 'interactive' }),
    );
  });

  it('maps a targeted 403 probe to LOST without retrying through a main bot', async () => {
    const error = Object.assign(new Error('denied'), { response: { status: 403 } });
    const { service, prisma, dispatchHealth } = createHarness(error);

    await expect(service.refresh(job)).resolves.toBeUndefined();
    expect(prisma.publisherEntityBinding.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          chatId: 'chat-1',
          publisherBotId: 'publik_bot',
          AND: expect.any(Array),
        }),
        data: expect.objectContaining({
          botAccessState: ChatBotAccessState.LOST,
          botAccessExpiresAt: null,
          botAccessLastErrorCode: 'HTTP_403',
        }),
      }),
    );
    expect(dispatchHealth.recordAuthenticatedSuccess).not.toHaveBeenCalled();
  });

  it('does not create or probe a binding from a Major-only bootstrap job', async () => {
    const { service, prisma, maxClient } = createHarness({
      isAdmin: true,
      isOwner: false,
      permissions: ['write'],
      permissionsKnown: true,
    });
    prisma.chat.findUnique.mockResolvedValueOnce({
      id: 'chat-1',
      publicationPolicy: null,
      botMemberships: [{ id: 'main-membership' }],
      publisherBinding: {
        publisherBotId: 'publik_bot',
        status: ChatBotMembershipStatus.ACTIVE,
        botAccessState: ChatBotAccessState.UNKNOWN,
        lastSeenAt: null,
        lastWebhookAt: null,
      },
    });

    await service.refresh(job);

    expect(maxClient.getCurrentChatMemberAccess).not.toHaveBeenCalled();
    expect(prisma.publisherEntityBinding.updateMany).not.toHaveBeenCalled();
  });

  it('allows the first targeted probe after a publisher webhook observation', async () => {
    const { service, prisma, maxClient } = createHarness({
      isAdmin: true,
      isOwner: false,
      permissions: ['write'],
      permissionsKnown: true,
    });
    prisma.chat.findUnique.mockResolvedValueOnce({
      id: 'chat-1',
      publicationPolicy: null,
      botMemberships: [{ id: 'main-membership' }],
      publisherBinding: {
        publisherBotId: 'publik_bot',
        status: ChatBotMembershipStatus.ACTIVE,
        botAccessState: ChatBotAccessState.UNKNOWN,
        lastSeenAt: new Date('2026-08-26T11:59:00.000Z'),
        lastWebhookAt: new Date('2026-08-26T11:59:00.000Z'),
      },
    });

    await service.refresh({ ...job, reason: 'bot_added' });

    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledTimes(1);
    expect(prisma.publisherEntityBinding.updateMany).toHaveBeenCalledTimes(1);
  });

  it('globally pauses and rethrows an exact-token 401', async () => {
    const error = Object.assign(new Error('unauthorized'), { response: { status: 401 } });
    const { service, dispatchHealth } = createHarness(error);

    await expect(service.refresh(job)).rejects.toBe(error);
    expect(dispatchHealth.recordGlobalAuthorizationFailure).toHaveBeenCalledTimes(1);
  });

  it('does not probe MAX while the global exact-token pause is active', async () => {
    const { service, maxClient, dispatchHealth } = createHarness({
      isAdmin: true,
      isOwner: false,
      permissions: ['write'],
      permissionsKnown: true,
    });
    dispatchHealth.isGloballyPaused.mockResolvedValueOnce(true);

    await service.refresh(job);

    expect(maxClient.getCurrentChatMemberAccess).not.toHaveBeenCalled();
  });

  it('does not read candidates or probe MAX before action-token attestation', async () => {
    const { service, prisma, maxClient, identityAttestation } = createHarness({
      isAdmin: true,
      isOwner: false,
      permissions: ['write'],
      permissionsKnown: true,
    });
    identityAttestation.assertAttested.mockRejectedValueOnce(new Error('not attested'));

    await expect(service.refresh(job)).rejects.toThrow('not attested');

    expect(prisma.chat.findUnique).not.toHaveBeenCalled();
    expect(maxClient.getCurrentChatMemberAccess).not.toHaveBeenCalled();
  });

  it('does not read candidates or probe MAX while dispatch is disabled', async () => {
    const { service, prisma, maxClient, identityAttestation } = createHarness(
      {
        isAdmin: true,
        isOwner: false,
        permissions: ['write'],
        permissionsKnown: true,
      },
      false,
    );

    await service.refresh(job);

    expect(identityAttestation.assertAttested).not.toHaveBeenCalled();
    expect(prisma.chat.findUnique).not.toHaveBeenCalled();
    expect(maxClient.getCurrentChatMemberAccess).not.toHaveBeenCalled();
  });

  it('does not start binding refresh scans while dispatch is disabled', async () => {
    jest.useFakeTimers();
    try {
      const prisma = {
        $queryRaw: jest.fn(),
        publisherEntityBinding: { findMany: jest.fn() },
      };
      const identityAttestation = { assertAttested: jest.fn() };
      const dispatchHealth = { isGloballyPaused: jest.fn() };
      const scheduler = new PublisherBindingRefreshSchedulerService(
        prisma as never,
        { enqueue: jest.fn() } as never,
        { getBotId: () => 'publik_bot', getRequiredActionToken: jest.fn() } as never,
        dispatchHealth as never,
        identityAttestation as never,
        { dispatchEnabled: false } as never,
        createBackgroundWork() as never,
      );

      await scheduler.onModuleInit();
      await jest.advanceTimersByTimeAsync(120_000);
      await scheduler.scan('scheduled');

      expect(identityAttestation.assertAttested).not.toHaveBeenCalled();
      expect(dispatchHealth.isGloballyPaused).not.toHaveBeenCalled();
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
      expect(prisma.publisherEntityBinding.findMany).not.toHaveBeenCalled();
      scheduler.onModuleDestroy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('refreshes only existing evidenced bindings at startup', async () => {
    const prisma = {
      $queryRaw: jest.fn(),
      publisherEntityBinding: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([{ chatId: 'chat-ready' }])
          .mockResolvedValueOnce([{ chatId: 'chat-discovery' }]),
      },
    };
    const refreshQueue = { enqueue: jest.fn().mockResolvedValue(undefined) };
    const dispatchHealth = { isGloballyPaused: jest.fn().mockResolvedValue(false) };
    const identityAttestation = { assertAttested: jest.fn().mockResolvedValue(undefined) };
    const scheduler = new PublisherBindingRefreshSchedulerService(
      prisma as never,
      refreshQueue as never,
      { getBotId: () => 'publik_bot', getRequiredActionToken: jest.fn() } as never,
      dispatchHealth as never,
      identityAttestation as never,
      { dispatchEnabled: true } as never,
      createBackgroundWork() as never,
    );

    const scan = jest.spyOn(scheduler, 'scan');
    scheduler.onModuleInit();
    await scan.mock.results[0]?.value;

    expect(identityAttestation.assertAttested).toHaveBeenCalledTimes(1);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.publisherEntityBinding.findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        take: 200,
        where: expect.objectContaining({
          botAccessState: {
            in: [ChatBotAccessState.CONFIRMED_ADMIN, ChatBotAccessState.CONFIRMED_OWNER],
          },
        }),
      }),
    );
    expect(prisma.publisherEntityBinding.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        take: 25,
        where: expect.objectContaining({
          publisherBotId: 'publik_bot',
          status: ChatBotMembershipStatus.ACTIVE,
          OR: expect.arrayContaining([
            { lastWebhookAt: { not: null } },
            { lastSeenAt: { not: null } },
          ]),
        }),
      }),
    );
    expect(refreshQueue.enqueue).toHaveBeenCalledTimes(2);
    expect(refreshQueue.enqueue.mock.calls.map(([request]) => request.chatId)).toEqual([
      'chat-ready',
      'chat-discovery',
    ]);
    scheduler.onModuleDestroy();
  });

  it('never scans the Major chat catalog or creates candidate bindings', async () => {
    const prisma = {
      $queryRaw: jest.fn(),
      publisherEntityBinding: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const scheduler = new PublisherBindingRefreshSchedulerService(
      prisma as never,
      { enqueue: jest.fn() } as never,
      { getBotId: () => 'publik_bot', getRequiredActionToken: jest.fn() } as never,
      { isGloballyPaused: jest.fn().mockResolvedValue(false) } as never,
      { assertAttested: jest.fn().mockResolvedValue(undefined) } as never,
      { dispatchEnabled: true } as never,
      createBackgroundWork() as never,
    );

    await scheduler.scan('scheduled');

    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.publisherEntityBinding.findMany).toHaveBeenCalledTimes(2);
  });

  it('prioritizes an expiring ready binding and cools down 2500 fresh LOST rows', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-26T12:00:00.000Z'));
    try {
      const checkedAt = new Date('2026-08-26T11:59:30.000Z');
      const freshLost = Array.from({ length: 2_500 }, (_, index) => ({
        chatId: `lost-${String(index).padStart(4, '0')}`,
        botAccessCheckedAt: checkedAt,
      }));
      const ready = {
        chatId: 'ready-expiring',
        botAccessExpiresAt: new Date('2026-08-26T12:01:00.000Z'),
      };
      const findMany = jest.fn(
        async (query: {
          where: {
            chatId?: { gt?: string };
            botAccessState?: { in?: ChatBotAccessState[] };
            OR?: Array<{
              botAccessExpiresAt?: { lte?: Date } | null;
              botAccessState?: { in?: ChatBotAccessState[] };
              OR?: Array<{ botAccessCheckedAt?: { lte?: Date } | null }>;
            }>;
            AND?: Array<{
              OR?: Array<{
                botAccessState?: { in?: ChatBotAccessState[] };
                OR?: Array<{ botAccessCheckedAt?: { lte?: Date } | null }>;
              }>;
            }>;
          };
          take: number;
        }) => {
          if (query.where.botAccessState?.in?.includes(ChatBotAccessState.CONFIRMED_ADMIN)) {
            const refreshBefore = query.where.OR?.find(
              (branch) => branch.botAccessExpiresAt && 'lte' in branch.botAccessExpiresAt,
            )?.botAccessExpiresAt?.lte;
            return refreshBefore && ready.botAccessExpiresAt <= refreshBefore
              ? [{ chatId: ready.chatId }]
              : [];
          }

          const lostBranch = query.where.AND?.[0]?.OR?.find((branch) =>
            branch.botAccessState?.in?.includes(ChatBotAccessState.LOST),
          );
          const retryBefore = lostBranch?.OR?.find(
            (branch) => branch.botAccessCheckedAt && 'lte' in branch.botAccessCheckedAt,
          )?.botAccessCheckedAt?.lte;
          return freshLost
            .filter(
              (row) =>
                retryBefore !== undefined &&
                row.botAccessCheckedAt <= retryBefore &&
                (!query.where.chatId?.gt || row.chatId > query.where.chatId.gt),
            )
            .slice(0, query.take)
            .map(({ chatId }) => ({ chatId }));
        },
      );
      const prisma = {
        publisherEntityBinding: { findMany },
      };
      const refreshQueue = { enqueue: jest.fn().mockResolvedValue(undefined) };
      const scheduler = new PublisherBindingRefreshSchedulerService(
        prisma as never,
        refreshQueue as never,
        { getBotId: () => 'publik_bot', getRequiredActionToken: jest.fn() } as never,
        { isGloballyPaused: jest.fn().mockResolvedValue(false) } as never,
        { assertAttested: jest.fn().mockResolvedValue(undefined) } as never,
        { dispatchEnabled: true } as never,
        createBackgroundWork() as never,
      );

      await scheduler.scan('scheduled');
      jest.advanceTimersByTime(60_000);
      await scheduler.scan('scheduled');

      expect(refreshQueue.enqueue).toHaveBeenCalledTimes(2);
      expect(refreshQueue.enqueue.mock.calls.map(([request]) => request.chatId)).toEqual([
        'ready-expiring',
        'ready-expiring',
      ]);
      const discoveryQueries = findMany.mock.calls
        .map(([query]) => query)
        .filter((query) => query.where.botAccessState === undefined);
      expect(discoveryQueries).toHaveLength(2);
      const lostRetryCutoffs = discoveryQueries.map((query) => {
        expect(query.where.OR).toEqual(
          expect.arrayContaining([{ lastWebhookAt: { not: null } }, { lastSeenAt: { not: null } }]),
        );
        const lostBranch = query.where.AND?.[0]?.OR?.find((branch) =>
          branch.botAccessState?.in?.includes(ChatBotAccessState.LOST),
        );
        expect(lostBranch).toEqual(
          expect.objectContaining({
            OR: expect.arrayContaining([
              expect.objectContaining({
                botAccessCheckedAt: { lte: expect.any(Date) },
              }),
            ]),
          }),
        );
        return lostBranch?.OR?.find(
          (branch) => branch.botAccessCheckedAt && 'lte' in branch.botAccessCheckedAt,
        )?.botAccessCheckedAt?.lte;
      });
      expect(lostRetryCutoffs).toEqual([
        new Date('2026-08-26T06:00:00.000Z'),
        new Date('2026-08-26T06:01:00.000Z'),
      ]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('advances the disconnected discovery cursor across repeated scans', async () => {
    const eligible = Array.from({ length: 60 }, (_, index) => ({
      chatId: `lost-${String(index).padStart(3, '0')}`,
    }));
    const discoveryCursors: Array<string | null> = [];
    const findMany = jest.fn(
      async (query: {
        where: {
          chatId?: { gt?: string };
          botAccessState?: { in?: ChatBotAccessState[] };
        };
        take: number;
      }) => {
        if (query.where.botAccessState) {
          return [];
        }
        const cursor = query.where.chatId?.gt ?? null;
        discoveryCursors.push(cursor);
        return eligible.filter((row) => !cursor || row.chatId > cursor).slice(0, query.take);
      },
    );
    const prisma = {
      publisherEntityBinding: { findMany },
    };
    const refreshQueue = { enqueue: jest.fn().mockResolvedValue(undefined) };
    const scheduler = new PublisherBindingRefreshSchedulerService(
      prisma as never,
      refreshQueue as never,
      { getBotId: () => 'publik_bot', getRequiredActionToken: jest.fn() } as never,
      { isGloballyPaused: jest.fn().mockResolvedValue(false) } as never,
      { assertAttested: jest.fn().mockResolvedValue(undefined) } as never,
      { dispatchEnabled: true } as never,
      createBackgroundWork() as never,
    );

    await scheduler.scan('scheduled');
    await scheduler.scan('scheduled');
    await scheduler.scan('scheduled');

    expect(discoveryCursors).toEqual([null, 'lost-024', 'lost-049']);
    expect(new Set(refreshQueue.enqueue.mock.calls.map(([request]) => request.chatId))).toEqual(
      new Set(eligible.map((row) => row.chatId)),
    );
  });

  it('keeps enabled refresh timers idle before identity, DB, or queue work while paused', async () => {
    jest.useFakeTimers();
    try {
      const prisma = {
        publisherEntityBinding: { findMany: jest.fn().mockResolvedValue([]) },
      };
      const refreshQueue = { enqueue: jest.fn() };
      let globallyPaused = true;
      const dispatchHealth = {
        isGloballyPaused: jest.fn(async () => globallyPaused),
      };
      const identityAttestation = { assertAttested: jest.fn() };
      const scheduler = new PublisherBindingRefreshSchedulerService(
        prisma as never,
        refreshQueue as never,
        { getBotId: () => 'publik_bot', getRequiredActionToken: jest.fn() } as never,
        dispatchHealth as never,
        identityAttestation as never,
        { dispatchEnabled: true } as never,
        createBackgroundWork() as never,
      );

      await scheduler.onModuleInit();
      await jest.advanceTimersByTimeAsync(60_000);

      expect(identityAttestation.assertAttested).not.toHaveBeenCalled();
      expect(prisma.publisherEntityBinding.findMany).not.toHaveBeenCalled();
      expect(refreshQueue.enqueue).not.toHaveBeenCalled();

      globallyPaused = false;
      await jest.advanceTimersByTimeAsync(60_000);

      expect(dispatchHealth.isGloballyPaused).toHaveBeenCalledTimes(3);
      expect(identityAttestation.assertAttested).toHaveBeenCalledTimes(1);
      expect(prisma.publisherEntityBinding.findMany).toHaveBeenCalledTimes(2);
      scheduler.onModuleDestroy();
    } finally {
      jest.useRealTimers();
    }
  });
});
