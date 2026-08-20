import {
  MaxChatAdminRosterSyncService,
  MaxChatAdminRosterSyncSourceBackoffError,
} from './max-chat-admin-roster-sync.service';

describe('MaxChatAdminRosterSyncService', () => {
  function createService() {
    const latestProbeByMembership = new Map<
      string,
      {
        status: 'ACTIVE' | 'REMOVED';
        botAccessState: 'CONFIRMED_OWNER' | 'CONFIRMED_ADMIN' | 'CONFIRMED_MEMBER' | 'DENIED';
        botAccessCheckedAt: Date;
        botAccessSource: string;
        lifecycleEventAt: Date | null;
        lifecycleEventType: string | null;
        lifecycleSource: string | null;
      }
    >();
    const prisma = {
      chat: {
        findUnique: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockResolvedValue({}),
      },
      chatAdminAllowlist: {
        findMany: jest.fn().mockResolvedValue([]),
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
        upsert: jest.fn(),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      chatBotMembership: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn(
          async ({ where }: { where: { chatId_botId: { chatId: string; botId: string } } }) =>
            latestProbeByMembership.get(
              `${where.chatId_botId.chatId}:${where.chatId_botId.botId}`,
            ) ?? null,
        ),
        count: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
          const membership = latestProbeByMembership.get(`${where.chatId}:${where.botId}`);
          const checkedAt = where.botAccessCheckedAt as Date | undefined;
          return membership &&
            membership.status === where.status &&
            membership.botAccessState === where.botAccessState &&
            membership.botAccessSource === where.botAccessSource &&
            membership.botAccessCheckedAt.getTime() === checkedAt?.getTime()
            ? 1
            : 0;
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      managedEntityAccessEdge: {
        upsert: jest.fn().mockResolvedValue(undefined),
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      managedEntityAdminMember: {
        upsert: jest.fn().mockResolvedValue(undefined),
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      $queryRaw: jest.fn(async (query: unknown) => {
        const statement = query as {
          strings?: readonly string[];
          sql?: string;
          values?: readonly unknown[];
        };
        const sql = statement.strings?.join('') ?? statement.sql ?? '';
        if (sql.includes('FROM "chats"')) {
          return [{ id: 'chat-lock' }];
        }
        if (sql.includes('FROM "chat_membership_activity_events"')) {
          return [];
        }
        const chatId = statement.values?.[0];
        const requestedBotIds = (statement.values ?? [])
          .slice(1)
          .filter((value): value is string => typeof value === 'string');
        const memberships = [...latestProbeByMembership.entries()]
          .filter(([key]) => typeof chatId === 'string' && key.startsWith(`${chatId}:`))
          .map(([key, membership]) => ({
            id: `membership-lock:${key}`,
            botId: key.slice(String(chatId).length + 1),
            status: membership.status,
          }));
        return requestedBotIds.length > 0
          ? memberships.filter((membership) => requestedBotIds.includes(membership.botId))
          : memberships;
      }),
      $transaction: jest.fn(
        async <T>(callback: (transaction: unknown) => Promise<T>): Promise<T> => callback(prisma),
      ),
    };
    const maxClient = {
      getCurrentChatMemberAccess: jest.fn(),
      getChatAdminIds: jest.fn(),
      listBotChats: jest.fn(),
    };
    const maxBotLinkService = {
      bindDiscoveredChatBots: jest.fn().mockResolvedValue('bot-1'),
      recordBotAccessProbe: jest.fn(
        async (params: {
          chatId: string;
          botId: string;
          access: { isAdmin?: boolean; isOwner?: boolean } | null;
          source: string;
          checkedAt: Date;
        }) => {
          latestProbeByMembership.set(`${params.chatId}:${params.botId}`, {
            status: 'ACTIVE',
            botAccessState: params.access?.isOwner
              ? 'CONFIRMED_OWNER'
              : params.access?.isAdmin
                ? 'CONFIRMED_ADMIN'
                : params.access
                  ? 'CONFIRMED_MEMBER'
                  : 'DENIED',
            botAccessCheckedAt: params.checkedAt,
            botAccessSource: params.source,
            lifecycleEventAt: null,
            lifecycleEventType: null,
            lifecycleSource: null,
          });
          return true;
        },
      ),
      reconcileChatPrimaryByAccess: jest.fn().mockResolvedValue('bot-1'),
    };
    const maxBotRegistry = {
      getBotById: jest.fn((botId?: string | null) =>
        botId ? { id: botId, state: botId.includes('dormant') ? 'dormant' : 'active' } : null,
      ),
      getDiscoveryBots: jest.fn().mockReturnValue([
        { id: 'bot-1', state: 'active' },
        { id: 'bot-2', state: 'active' },
      ]),
    };
    const chatContextCache = {
      replaceChatAdminUsers: jest.fn().mockResolvedValue(undefined),
      setAdminAccess: jest.fn().mockResolvedValue(undefined),
      getManagedEntityHeader: jest.fn().mockResolvedValue(null),
      getManagedEntitiesPublishedSnapshot: jest.fn().mockResolvedValue(null),
      setManagedEntitiesPublishedSnapshot: jest.fn().mockResolvedValue(undefined),
      clearManagedEntitiesRecentBootstrapForChat: jest.fn().mockResolvedValue(undefined),
      isManagedRefreshSourceBackoffActive: jest.fn().mockResolvedValue(false),
      getManagedRefreshSourceBackoffRemainingMs: jest.fn().mockResolvedValue(0),
      activateManagedRefreshSourceBackoff: jest.fn().mockResolvedValue(undefined),
      invalidate: jest.fn().mockResolvedValue(undefined),
      invalidateManagedEntityHeader: jest.fn().mockResolvedValue(undefined),
      clearManagedEntitiesPublishedSnapshotsForUsers: jest.fn().mockResolvedValue(undefined),
      clearAdminAccess: jest.fn().mockResolvedValue(undefined),
      applyAdminAccessEpochMutation: jest.fn().mockResolvedValue(true),
    };
    const queue = {
      getJob: jest.fn().mockResolvedValue(null),
      add: jest.fn().mockResolvedValue(undefined),
    };
    const nightModeTransitionScheduler = {
      reconcileChat: jest.fn().mockResolvedValue(undefined),
    };

    const service = new MaxChatAdminRosterSyncService(
      prisma as never,
      maxClient as never,
      maxBotLinkService as never,
      maxBotRegistry as never,
      chatContextCache as never,
      queue as never,
      nightModeTransitionScheduler as never,
    );

    return {
      service,
      prisma,
      maxClient,
      maxBotLinkService,
      maxBotRegistry,
      chatContextCache,
      queue,
      nightModeTransitionScheduler,
      latestProbeByMembership,
    };
  }

  it('enqueues fresh webhook bot_added jobs with delayed exponential retry cadence', async () => {
    const { service, queue } = createService();

    await expect(
      service.scheduleChatAdminRosterSync({
        chatId: '-100122',
        botIds: ['bot-1'],
        title: 'Fresh chat',
        entityType: 'chat',
        source: 'webhook_bot_added',
        retryUntilMs: Date.now() + 45_000,
      }),
    ).resolves.toBe(true);

    expect(queue.add).toHaveBeenCalledWith(
      'sync-chat-admin-roster',
      expect.objectContaining({
        chatId: '-100122',
        source: 'webhook_bot_added',
      }),
      expect.objectContaining({
        attempts: 8,
        priority: 1,
        delay: expect.any(Number),
        backoff: {
          type: 'exponential',
          delay: 5_000,
        },
      }),
    );
    const options = queue.add.mock.calls[0]?.[2] as { delay?: number };
    expect(options.delay).toBeGreaterThanOrEqual(5_000);
    expect(options.delay).toBeLessThanOrEqual(10_000);
  });

  it('keeps an equivalent delayed bot_added roster sync instead of rescheduling retryUntil churn', async () => {
    const { service, queue } = createService();
    const remove = jest.fn();
    const baseRetryUntilMs = Date.now() + 45_000;
    queue.getJob.mockResolvedValue({
      getState: jest.fn().mockResolvedValue('delayed'),
      remove,
      data: {
        chatId: '-100122',
        botIds: ['bot-1'],
        title: 'Fresh chat',
        entityType: 'chat',
        source: 'webhook_bot_added',
        retryUntilMs: baseRetryUntilMs,
      },
    });

    await expect(
      service.scheduleChatAdminRosterSync({
        chatId: '-100122',
        botIds: ['bot-1'],
        title: 'Fresh chat',
        entityType: 'chat',
        source: 'webhook_bot_added',
        retryUntilMs: baseRetryUntilMs + 5_000,
      }),
    ).resolves.toBe(true);

    expect(remove).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('prioritizes webhook membership churn roster sync jobs ahead of discovery sync', async () => {
    const { service, queue } = createService();

    await expect(
      service.scheduleChatAdminRosterSync({
        chatId: '-100122',
        botIds: ['bot-1'],
        title: 'Membership churn chat',
        entityType: 'chat',
        source: 'webhook_membership_churn',
      }),
    ).resolves.toBe(true);

    expect(queue.add).toHaveBeenCalledWith(
      'sync-chat-admin-roster',
      expect.objectContaining({
        chatId: '-100122',
        source: 'webhook_membership_churn',
      }),
      expect.objectContaining({
        attempts: 6,
        priority: 2,
        backoff: {
          type: 'fixed',
          delay: 3_000,
        },
      }),
    );
  });

  it('backfills managed entity roster jobs from local memberships by default', async () => {
    const { service, prisma, maxClient } = createService();
    prisma.chatBotMembership.findMany = jest.fn().mockResolvedValue([
      {
        botId: 'bot-1',
        lastSeenAt: new Date('2026-05-14T09:00:00.000Z'),
        lastWebhookAt: null,
        chat: {
          id: '-100123',
          title: 'Shared chat',
          entityType: 'CHAT',
          primaryBotId: 'bot-1',
          botId: null,
        },
      },
    ]);
    maxClient.getCurrentChatMemberAccess.mockResolvedValue({
      userId: 'bot-user-1',
      isAdmin: true,
      isOwner: false,
      permissions: ['delete_messages'],
    });
    maxClient.getChatAdminIds.mockResolvedValue(['user-1']);

    await expect(service.backfillManagedEntitiesIndex()).resolves.toEqual({
      discoveredChats: 1,
      syncedChats: 1,
    });

    expect(maxClient.listBotChats).not.toHaveBeenCalled();
    expect(prisma.chatBotMembership.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: 'ACTIVE',
        },
      }),
    );
  });

  it('skips dormant local bot memberships during managed entity roster backfill', async () => {
    const { service, prisma, maxClient, maxBotLinkService } = createService();
    prisma.chatBotMembership.findMany = jest.fn().mockResolvedValue([
      {
        botId: 'bot-dormant',
        lastSeenAt: new Date('2026-05-14T09:00:00.000Z'),
        lastWebhookAt: null,
        chat: {
          id: '-100125',
          title: 'Dormant chat',
          entityType: 'CHAT',
          primaryBotId: 'bot-dormant',
          botId: null,
        },
      },
    ]);

    await expect(service.backfillManagedEntitiesIndex()).resolves.toEqual({
      discoveredChats: 0,
      syncedChats: 0,
    });

    expect(maxClient.getCurrentChatMemberAccess).not.toHaveBeenCalled();
    expect(maxBotLinkService.bindDiscoveredChatBots).not.toHaveBeenCalled();
  });

  it('paginates local membership backfill past 60,000 rows without truncation', async () => {
    const { service, prisma, maxClient, maxBotRegistry } = createService();
    const totalMemberships = 60_001;
    maxBotRegistry.getBotById.mockImplementation((botId?: string | null) =>
      botId === 'bot-1' ? { id: 'bot-1', state: 'active' } : null,
    );
    prisma.chatBotMembership.findMany.mockImplementation(
      async (args: { cursor?: { chatId_botId?: { botId?: string } }; take?: number }) => {
        const cursorBotId = args.cursor?.chatId_botId?.botId ?? null;
        const startIndex = cursorBotId
          ? Number.parseInt(cursorBotId.replace('membership-', ''), 10) + 1
          : 0;
        const pageSize = Math.min(args.take ?? 500, totalMemberships - startIndex);
        return Array.from({ length: Math.max(0, pageSize) }, (_, offset) => {
          const index = startIndex + offset;
          return {
            chatId: '-100-paginated',
            botId: `membership-${String(index).padStart(6, '0')}`,
            lastSeenAt: new Date('2026-05-14T09:00:00.000Z'),
            lastWebhookAt: null,
            chat: {
              id: '-100-paginated',
              title: 'Paginated chat',
              entityType: 'CHAT',
              primaryBotId: 'bot-1',
              botId: null,
            },
          };
        });
      },
    );
    maxClient.getCurrentChatMemberAccess.mockResolvedValue({
      userId: 'bot-user-1',
      isAdmin: true,
      isOwner: false,
      permissions: ['delete_messages'],
    });
    maxClient.getChatAdminIds.mockResolvedValue(['user-1']);

    await expect(service.backfillManagedEntitiesIndex()).resolves.toEqual({
      discoveredChats: 1,
      syncedChats: 1,
    });

    expect(prisma.chatBotMembership.findMany).toHaveBeenCalledTimes(121);
    expect(prisma.chatBotMembership.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        cursor: {
          chatId_botId: {
            chatId: '-100-paginated',
            botId: 'membership-059999',
          },
        },
        skip: 1,
        take: 500,
      }),
    );
    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledTimes(1);
  });

  it('syncs admin allowlist from the first admin-capable bot', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-14T09:00:00.000Z'));
    const {
      service,
      prisma,
      maxClient,
      maxBotLinkService,
      chatContextCache,
      nightModeTransitionScheduler,
    } = createService();
    prisma.chatAdminAllowlist.findMany
      .mockResolvedValueOnce([{ userId: 'user-1' }, { userId: 'user-3' }])
      .mockResolvedValueOnce([{ userId: 'user-1' }, { userId: 'user-2' }]);
    maxClient.getCurrentChatMemberAccess.mockResolvedValue({
      userId: 'bot-user-1',
      isAdmin: true,
      isOwner: false,
      permissions: ['delete_messages'],
    });
    maxClient.getChatAdminIds.mockResolvedValue(['user-1', 'user-2']);

    try {
      await expect(
        service.processJob({
          chatId: '-100123',
          botIds: ['bot-1'],
          title: 'Shared chat',
          entityType: 'chat',
        }),
      ).resolves.toBe(true);
    } finally {
      jest.useRealTimers();
    }

    expect(maxBotLinkService.bindDiscoveredChatBots).toHaveBeenCalledWith({
      chatId: '-100123',
      primaryBotId: 'bot-1',
      botIds: ['bot-1'],
      title: 'Shared chat',
      entityType: 'CHAT',
    });
    expect(prisma.chatAdminAllowlist.createMany).toHaveBeenCalledWith({
      data: [{ chatId: '-100123', userId: 'user-2' }],
      skipDuplicates: true,
    });
    expect(prisma.chatAdminAllowlist.deleteMany).toHaveBeenCalledWith({
      where: {
        chatId: '-100123',
        userId: {
          in: ['user-3'],
        },
      },
    });
    expect(chatContextCache.applyAdminAccessEpochMutation).toHaveBeenCalledTimes(3);
    expect(chatContextCache.applyAdminAccessEpochMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: '-100123',
        userId: 'user-1',
        state: 'granted',
        eventAt: new Date('2026-05-14T09:00:00.000Z'),
      }),
    );
    expect(chatContextCache.applyAdminAccessEpochMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: '-100123',
        userId: 'user-2',
        state: 'granted',
        eventAt: new Date('2026-05-14T09:00:00.000Z'),
      }),
    );
    expect(chatContextCache.applyAdminAccessEpochMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: '-100123',
        userId: 'user-3',
        state: 'user_denied',
        eventAt: new Date('2026-05-14T09:00:00.000Z'),
      }),
    );
    expect(chatContextCache.replaceChatAdminUsers).not.toHaveBeenCalled();
    expect(chatContextCache.setAdminAccess).not.toHaveBeenCalled();
    expect(prisma.managedEntityAccessEdge.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          chatId_userId_botId: {
            chatId: '-100123',
            userId: 'user-1',
            botId: 'bot-1',
          },
        },
        update: expect.objectContaining({
          state: 'GRANTED',
          userRole: 'ADMIN',
          botRole: 'ADMIN',
          expiresAt: new Date('2026-05-17T09:00:00.000Z'),
          deniedReason: null,
          lastMaxErrorCode: null,
          lastMaxErrorMessage: null,
          lastMaxStatusCode: null,
        }),
      }),
    );
    expect(prisma.managedEntityAccessEdge.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          chatId_userId_botId: {
            chatId: '-100123',
            userId: 'user-2',
            botId: 'bot-1',
          },
        },
        update: expect.objectContaining({
          state: 'GRANTED',
          userRole: 'ADMIN',
          botRole: 'ADMIN',
          expiresAt: new Date('2026-05-17T09:00:00.000Z'),
        }),
      }),
    );
    expect(prisma.managedEntityAccessEdge.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          chatId: '-100123',
          userId: {
            in: ['user-3'],
          },
          botId: 'bot-1',
          checkedAt: { lte: new Date('2026-05-14T09:00:00.000Z') },
        }),
        data: expect.objectContaining({
          state: 'USER_DENIED',
          deniedReason: 'user_removed_from_admin_roster',
        }),
      }),
    );
    expect(prisma.managedEntityAdminMember.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          chatId_userId_observedByBotId: {
            chatId: '-100123',
            userId: 'user-1',
            observedByBotId: 'bot-1',
          },
        },
        update: expect.objectContaining({
          role: 'ADMIN',
          expiresAt: new Date('2026-05-17T09:00:00.000Z'),
        }),
      }),
    );
    expect(prisma.chat.update).toHaveBeenCalledWith({
      where: { id: '-100123' },
      data: {
        catalogKind: 'MANAGED',
        entityType: 'CHAT',
      },
    });
    expect(chatContextCache.clearManagedEntitiesRecentBootstrapForChat).not.toHaveBeenCalled();
    expect(nightModeTransitionScheduler.reconcileChat).toHaveBeenCalledWith('-100123');
  });

  it('keeps one access identity when MAX returns an id-prefixed alias', async () => {
    const { service, prisma, maxClient, chatContextCache } = createService();
    prisma.chatAdminAllowlist.findMany
      .mockResolvedValueOnce([{ userId: '123' }])
      .mockResolvedValueOnce([{ userId: '123' }]);
    maxClient.getCurrentChatMemberAccess.mockResolvedValue({
      userId: 'bot-user-1',
      isAdmin: true,
      isOwner: false,
      permissions: ['delete_messages'],
    });
    maxClient.getChatAdminIds.mockResolvedValue(['id123']);

    await expect(
      service.processJob({
        chatId: '-100-roster-alias',
        botIds: ['bot-1'],
        title: 'Alias chat',
        entityType: 'chat',
      }),
    ).resolves.toBe(true);

    expect(prisma.chatAdminAllowlist.createMany).not.toHaveBeenCalled();
    expect(prisma.chatAdminAllowlist.deleteMany).not.toHaveBeenCalled();
    expect(prisma.managedEntityAccessEdge.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          chatId_userId_botId: {
            chatId: '-100-roster-alias',
            userId: '123',
            botId: 'bot-1',
          },
        },
      }),
    );
    expect(chatContextCache.applyAdminAccessEpochMutation).toHaveBeenCalledTimes(1);
    expect(chatContextCache.applyAdminAccessEpochMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: '-100-roster-alias',
        userId: '123',
        state: 'granted',
      }),
    );
    expect(chatContextCache.applyAdminAccessEpochMutation).not.toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: '-100-roster-alias',
        userId: 'id123',
        state: 'user_denied',
      }),
    );
  });

  it.each(['USER_DENIED', 'BOT_DENIED'] as const)(
    'does not restore a stale roster grant over a newer %s edge',
    async (newerState) => {
      const { service, prisma, maxClient, chatContextCache } = createService();
      prisma.managedEntityAccessEdge.findMany.mockImplementation(
        async (args: {
          where?: {
            userId?: { in?: string[] };
            checkedAt?: { gt?: Date };
            state?: string;
          };
        }) => {
          const where = args.where;
          if (
            where?.checkedAt?.gt &&
            where.userId?.in?.includes('user-1') &&
            (where.state === undefined || where.state === newerState)
          ) {
            return [{ userId: 'user-1', state: newerState }];
          }
          return [];
        },
      );
      maxClient.getCurrentChatMemberAccess.mockResolvedValue({
        userId: 'bot-user-1',
        isAdmin: true,
        isOwner: false,
        permissions: ['delete_messages'],
      });
      maxClient.getChatAdminIds.mockResolvedValue(['user-1']);

      await expect(
        service.processJob({
          chatId: `-100-roster-newer-${newerState.toLowerCase()}`,
          botIds: ['bot-1'],
          title: 'Newer edge chat',
          entityType: 'chat',
        }),
      ).resolves.toBe(true);

      expect(prisma.chatAdminAllowlist.createMany).not.toHaveBeenCalled();
      expect(prisma.managedEntityAccessEdge.upsert).not.toHaveBeenCalled();
      expect(prisma.managedEntityAdminMember.upsert).not.toHaveBeenCalled();
      expect(chatContextCache.applyAdminAccessEpochMutation).not.toHaveBeenCalled();
      const supersedingEdgeQuery = prisma.managedEntityAccessEdge.findMany.mock.calls.find(
        ([args]) => args?.where?.userId?.in?.includes('user-1'),
      )?.[0];
      expect(supersedingEdgeQuery?.where).not.toHaveProperty('state');
    },
  );

  it('refreshes every assigned bot self-access snapshot but fetches the admin roster once', async () => {
    const { service, prisma, maxClient, maxBotLinkService } = createService();
    prisma.chat.findUnique.mockResolvedValue({
      id: '-100-shared-access',
      title: 'Shared access chat',
      entityType: 'CHAT',
      primaryBotId: 'bot-1',
      botId: 'bot-1',
      botMemberships: [{ botId: 'bot-1' }, { botId: 'bot-2' }, { botId: 'bot-3' }],
      createdAt: new Date('2026-04-05T10:00:00.000Z'),
    });
    maxClient.getCurrentChatMemberAccess.mockImplementation(
      async (_chatId: string, options?: { botId?: string }) => ({
        userId: `${options?.botId ?? 'unknown'}-user`,
        isAdmin: options?.botId !== 'bot-3',
        isOwner: false,
        permissions: options?.botId === 'bot-3' ? [] : ['delete_messages'],
      }),
    );
    maxClient.getChatAdminIds.mockResolvedValue(['user-1']);

    await expect(
      service.processJob({
        chatId: '-100-shared-access',
        botIds: ['bot-1'],
        title: 'Shared access chat',
        entityType: 'chat',
      }),
    ).resolves.toBe(true);

    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledTimes(3);
    expect(maxClient.getCurrentChatMemberAccess.mock.calls.map((call) => call[1]?.botId)).toEqual([
      'bot-1',
      'bot-2',
      'bot-3',
    ]);
    expect(
      maxClient.getCurrentChatMemberAccess.mock.calls.every(
        (call) => call[1]?.bypassCache === true,
      ),
    ).toBe(true);
    expect(maxBotLinkService.recordBotAccessProbe).toHaveBeenCalledTimes(3);
    expect(maxBotLinkService.recordBotAccessProbe).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: '-100-shared-access',
        botId: 'bot-1',
        access: expect.objectContaining({ isAdmin: true }),
        source: 'admin_roster_sync',
        allowMembershipRecovery: true,
      }),
    );
    expect(maxClient.getChatAdminIds).toHaveBeenCalledTimes(1);
    expect(maxClient.getChatAdminIds).toHaveBeenCalledWith(
      '-100-shared-access',
      expect.objectContaining({ botId: 'bot-1', bypassCache: true }),
    );
    expect(maxBotLinkService.reconcileChatPrimaryByAccess).toHaveBeenCalledTimes(1);
  });

  it('resolves empty job botIds from persisted active bot memberships before runtime fallback', async () => {
    const { service, prisma, maxClient, maxBotLinkService } = createService();
    prisma.chat.findUnique.mockResolvedValue({
      id: '-100-empty-bots',
      title: 'Persisted membership chat',
      entityType: 'CHAT',
      primaryBotId: null,
      botId: null,
      botMemberships: [{ botId: 'bot-2' }],
      createdAt: new Date('2026-04-05T10:00:00.000Z'),
    });
    maxClient.getCurrentChatMemberAccess.mockResolvedValue({
      userId: 'bot-user-2',
      isAdmin: true,
      isOwner: false,
      permissions: ['delete_messages'],
    });
    maxClient.getChatAdminIds.mockResolvedValue(['user-1']);

    await expect(
      service.processJob({
        chatId: '-100-empty-bots',
        botIds: [],
        title: 'Persisted membership chat',
        entityType: 'chat',
        source: 'admin_access_validation',
      }),
    ).resolves.toBe(true);

    expect(maxBotLinkService.bindDiscoveredChatBots).toHaveBeenCalledWith({
      chatId: '-100-empty-bots',
      primaryBotId: 'bot-2',
      botIds: ['bot-2'],
      title: 'Persisted membership chat',
      entityType: 'CHAT',
    });
    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledTimes(1);
    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledWith(
      '-100-empty-bots',
      expect.objectContaining({
        botId: 'bot-2',
      }),
    );
  });

  it('falls back from empty job botIds to runtime discovery bots when no persisted membership exists', async () => {
    const { service, prisma, maxClient } = createService();
    prisma.chat.findUnique.mockResolvedValue(null);
    maxClient.getCurrentChatMemberAccess
      .mockResolvedValueOnce({
        userId: 'bot-user-1',
        isAdmin: false,
        isOwner: false,
        permissions: [],
      })
      .mockResolvedValueOnce({
        userId: 'bot-user-2',
        isAdmin: true,
        isOwner: false,
        permissions: ['delete_messages'],
      });
    maxClient.getChatAdminIds.mockResolvedValue(['user-1']);

    await expect(
      service.processJob({
        chatId: '-100-runtime-fallback',
        botIds: [],
        title: 'Runtime fallback chat',
        entityType: 'chat',
        source: 'admin_access_validation',
      }),
    ).resolves.toBe(true);

    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenNthCalledWith(
      1,
      '-100-runtime-fallback',
      expect.objectContaining({
        botId: 'bot-1',
      }),
    );
    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenNthCalledWith(
      2,
      '-100-runtime-fallback',
      expect.objectContaining({
        botId: 'bot-2',
      }),
    );
    expect(maxClient.getChatAdminIds).toHaveBeenCalledWith(
      '-100-runtime-fallback',
      expect.objectContaining({
        botId: 'bot-2',
      }),
    );
    expect(prisma.chatAdminAllowlist.deleteMany).not.toHaveBeenCalled();
  });

  it('clears stale allowlist rows when no bot keeps admin access', async () => {
    const {
      service,
      prisma,
      maxClient,
      maxBotRegistry,
      chatContextCache,
      nightModeTransitionScheduler,
    } = createService();
    maxBotRegistry.getDiscoveryBots.mockReturnValue([{ id: 'bot-1', state: 'active' }]);
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      { userId: 'user-7' },
      { userId: 'user-8' },
    ]);
    maxClient.getCurrentChatMemberAccess.mockResolvedValue({
      userId: 'bot-user-1',
      isAdmin: false,
      isOwner: false,
      permissions: [],
    });

    await expect(
      service.processJob({
        chatId: '-100124',
        botIds: ['bot-1'],
        title: 'Lost admin chat',
        entityType: 'channel',
      }),
    ).resolves.toBe(false);

    expect(prisma.chatAdminAllowlist.deleteMany).toHaveBeenCalledWith({
      where: {
        chatId: '-100124',
        userId: {
          in: ['user-7', 'user-8'],
        },
      },
    });
    expect(chatContextCache.applyAdminAccessEpochMutation).toHaveBeenCalledTimes(2);
    expect(chatContextCache.applyAdminAccessEpochMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: '-100124',
        userId: 'user-7',
        state: 'bot_denied',
        eventAt: expect.any(Date),
      }),
    );
    expect(chatContextCache.applyAdminAccessEpochMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: '-100124',
        userId: 'user-8',
        state: 'bot_denied',
        eventAt: expect.any(Date),
      }),
    );
    expect(chatContextCache.replaceChatAdminUsers).not.toHaveBeenCalled();
    expect(chatContextCache.setAdminAccess).not.toHaveBeenCalled();
    expect(chatContextCache.clearManagedEntitiesRecentBootstrapForChat).not.toHaveBeenCalled();
    expect(nightModeTransitionScheduler.reconcileChat).not.toHaveBeenCalled();
  });

  it('does not clear the allowlist when a new active bot appears after candidate resolution', async () => {
    const {
      service,
      prisma,
      maxClient,
      maxBotLinkService,
      maxBotRegistry,
      chatContextCache,
      latestProbeByMembership,
    } = createService();
    maxBotRegistry.getDiscoveryBots.mockReturnValue([{ id: 'bot-1', state: 'active' }]);
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([{ userId: 'user-7' }]);
    maxClient.getCurrentChatMemberAccess.mockResolvedValue({
      userId: 'bot-user-1',
      isAdmin: false,
      isOwner: false,
      permissions: [],
    });
    maxBotLinkService.reconcileChatPrimaryByAccess.mockImplementationOnce(async () => {
      latestProbeByMembership.set('-100-new-candidate:bot-2', {
        status: 'ACTIVE',
        botAccessState: 'CONFIRMED_ADMIN',
        botAccessCheckedAt: new Date(),
        botAccessSource: 'concurrent_bot_added',
        lifecycleEventAt: new Date(),
        lifecycleEventType: 'bot_added',
        lifecycleSource: 'webhook',
      });
      return 'bot-2';
    });

    await expect(
      service.processJob({
        chatId: '-100-new-candidate',
        botIds: ['bot-1'],
        title: 'Concurrent bot add',
        entityType: 'chat',
      }),
    ).rejects.toThrow('Bot denial epochs were superseded before roster cleanup');

    expect(prisma.chatAdminAllowlist.deleteMany).not.toHaveBeenCalled();
    expect(prisma.managedEntityAccessEdge.updateMany).not.toHaveBeenCalled();
    expect(prisma.managedEntityAdminMember.updateMany).not.toHaveBeenCalled();
    expect(chatContextCache.replaceChatAdminUsers).not.toHaveBeenCalledWith(
      '-100-new-candidate',
      [],
    );
    expect(chatContextCache.applyAdminAccessEpochMutation).not.toHaveBeenCalled();
  });

  it('keeps allowlist repairable without writing fresh bot-scoped denied visibility edges when candidates are incomplete', async () => {
    const { service, prisma, maxClient, chatContextCache, nightModeTransitionScheduler } =
      createService();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([{ userId: 'user-7' }]);
    prisma.chat.findUnique.mockResolvedValue({
      title: 'Partial chat',
      entityType: 'CHANNEL',
      primaryBotId: 'bot-1',
      botId: 'bot-1',
      botMemberships: [],
    });
    maxClient.getCurrentChatMemberAccess.mockResolvedValue({
      userId: 'bot-user-1',
      isAdmin: false,
      isOwner: false,
      permissions: [],
    });

    await expect(
      service.processJob({
        chatId: '-100-partial',
        botIds: ['bot-1'],
        title: 'Partial chat',
        entityType: 'channel',
        source: 'webhook_membership_churn',
      }),
    ).resolves.toBe(false);

    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledTimes(1);
    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledWith(
      '-100-partial',
      expect.objectContaining({
        botId: 'bot-1',
      }),
    );
    expect(prisma.chatAdminAllowlist.deleteMany).not.toHaveBeenCalled();
    expect(chatContextCache.replaceChatAdminUsers).not.toHaveBeenCalledWith('-100-partial', []);
    expect(chatContextCache.setAdminAccess).not.toHaveBeenCalledWith(
      '-100-partial',
      'user-7',
      'bot_denied',
    );
    expect(chatContextCache.applyAdminAccessEpochMutation).not.toHaveBeenCalled();
    expect(prisma.managedEntityAccessEdge.updateMany).not.toHaveBeenCalled();
    expect(prisma.managedEntityAdminMember.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          chatId: '-100-partial',
          userId: {
            in: ['user-7'],
          },
        }),
      }),
    );
    expect(chatContextCache.clearManagedEntitiesRecentBootstrapForChat).toHaveBeenCalledWith(
      '-100-partial',
      null,
    );
    expect(nightModeTransitionScheduler.reconcileChat).not.toHaveBeenCalled();
  });

  it('does not clear allowlist or write denied visibility edges for ambiguous MAX 400 failures', async () => {
    const { service, prisma, maxClient, maxBotRegistry, chatContextCache } = createService();
    maxBotRegistry.getDiscoveryBots.mockReturnValue([{ id: 'bot-1', state: 'active' }]);
    maxClient.getCurrentChatMemberAccess.mockRejectedValue(
      Object.assign(new Error('Request failed with status code 400'), {
        response: {
          status: 400,
          data: {},
        },
      }),
    );

    await expect(
      service.processJob({
        chatId: '-100-ambiguous-400',
        botIds: ['bot-1'],
        title: 'Ambiguous 400 chat',
        entityType: 'chat',
        source: 'admin_access_validation',
      }),
    ).rejects.toThrow('Request failed with status code 400');

    expect(prisma.chatAdminAllowlist.deleteMany).not.toHaveBeenCalled();
    expect(chatContextCache.replaceChatAdminUsers).not.toHaveBeenCalled();
    expect(chatContextCache.setAdminAccess).not.toHaveBeenCalled();
    expect(chatContextCache.applyAdminAccessEpochMutation).not.toHaveBeenCalled();
    expect(prisma.managedEntityAccessEdge.updateMany).not.toHaveBeenCalled();
  });

  it('backs off repeated terminal bot access failures before clearing allowlist again', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-14T09:00:00.000Z'));
    const { service, prisma, maxClient, maxBotRegistry, chatContextCache } = createService();
    maxBotRegistry.getDiscoveryBots.mockReturnValue([{ id: 'bot-1', state: 'active' }]);
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([{ userId: 'user-7' }]);
    const deniedError = Object.assign(new Error('Request failed with status code 403'), {
      response: {
        status: 403,
        data: {
          code: 'chat.denied',
          message: 'chat denied',
        },
      },
    });
    maxClient.getCurrentChatMemberAccess.mockRejectedValue(deniedError);

    try {
      await expect(
        service.processJob({
          chatId: '-100124',
          botIds: ['bot-1'],
          title: 'Lost admin chat',
          entityType: 'channel',
        }),
      ).resolves.toBe(false);
      await expect(
        service.processJob({
          chatId: '-100124',
          botIds: ['bot-1'],
          title: 'Lost admin chat',
          entityType: 'channel',
        }),
      ).resolves.toBe(false);
    } finally {
      jest.useRealTimers();
    }

    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledTimes(1);
    expect(prisma.chatAdminAllowlist.deleteMany).toHaveBeenCalledTimes(1);
    expect(chatContextCache.applyAdminAccessEpochMutation).toHaveBeenCalledTimes(1);
  });

  it('surfaces managed_refresh source pressure as a delayed backoff instead of a failure', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-14T09:00:00.000Z'));
    const { service, maxClient, maxBotLinkService, chatContextCache } = createService();
    maxClient.getCurrentChatMemberAccess.mockRejectedValue(
      new Error('MAX API managed_refresh source limit exceeded for bot bot-1'),
    );

    try {
      await expect(
        service.processJob({
          chatId: '-100131',
          botIds: ['bot-1'],
          title: 'Busy chat',
          entityType: 'chat',
        }),
      ).rejects.toMatchObject({
        chatId: '-100131',
        delayMs: expect.any(Number),
      });
      await expect(
        service.processJob({
          chatId: '-100132',
          botIds: ['bot-1'],
          title: 'Another busy chat',
          entityType: 'chat',
        }),
      ).rejects.toBeInstanceOf(MaxChatAdminRosterSyncSourceBackoffError);
    } finally {
      jest.useRealTimers();
    }

    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledTimes(1);
    expect(maxBotLinkService.bindDiscoveredChatBots).toHaveBeenCalledTimes(2);
    expect(chatContextCache.activateManagedRefreshSourceBackoff).toHaveBeenCalledWith(10);
  });

  it('uses shared managed_refresh source backoff before making another MAX request', async () => {
    const { service, maxClient, chatContextCache } = createService();
    chatContextCache.getManagedRefreshSourceBackoffRemainingMs.mockResolvedValue(7_000);

    await expect(
      service.processJob({
        chatId: '-100133',
        botIds: ['bot-1'],
        title: 'Busy shared chat',
        entityType: 'chat',
      }),
    ).rejects.toMatchObject({
      chatId: '-100133',
      delayMs: expect.any(Number),
    });

    expect(maxClient.getCurrentChatMemberAccess).not.toHaveBeenCalled();
    expect(maxClient.getChatAdminIds).not.toHaveBeenCalled();
  });

  it('retries a fresh webhook bot_added sync while bot admin rights are still propagating', async () => {
    const { service, prisma, maxClient, chatContextCache, nightModeTransitionScheduler } =
      createService();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([{ userId: 'user-7' }]);
    maxClient.getCurrentChatMemberAccess.mockResolvedValue({
      userId: 'bot-user-1',
      isAdmin: false,
      isOwner: false,
      permissions: [],
    });

    await expect(
      service.processJob({
        chatId: '-100125',
        botIds: ['bot-1'],
        title: 'Fresh chat',
        entityType: 'chat',
        source: 'webhook_bot_added',
        retryUntilMs: Date.now() + 30_000,
      }),
    ).rejects.toThrow('still propagating');

    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledWith(
      '-100125',
      expect.objectContaining({
        botId: 'bot-1',
        trafficClass: 'background',
        actionHealthLane: 'background',
        timeoutMs: 1_500,
      }),
    );
    expect(prisma.chatAdminAllowlist.deleteMany).not.toHaveBeenCalled();
    expect(chatContextCache.replaceChatAdminUsers).not.toHaveBeenCalledWith('-100125', []);
    expect(chatContextCache.applyAdminAccessEpochMutation).not.toHaveBeenCalled();
    expect(nightModeTransitionScheduler.reconcileChat).not.toHaveBeenCalled();
  });

  it('authorizes removal recovery only after a successful live roster probe', async () => {
    const { service, maxClient, maxBotLinkService } = createService();
    maxClient.getCurrentChatMemberAccess.mockResolvedValue({
      userId: 'bot-user-1',
      isAdmin: true,
      isOwner: false,
      permissions: ['write'],
    });
    maxClient.getChatAdminIds.mockResolvedValue(['user-1']);

    await expect(
      service.processJob({
        chatId: '-100-removed-roster',
        botIds: ['bot-1'],
        title: 'Removed roster chat',
        entityType: 'chat',
        source: 'webhook_bot_removed',
      }),
    ).resolves.toBe(true);

    expect(maxBotLinkService.bindDiscoveredChatBots).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: '-100-removed-roster',
        botIds: ['bot-1'],
      }),
    );
    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledWith(
      '-100-removed-roster',
      expect.objectContaining({ botId: 'bot-1' }),
    );
    expect(maxBotLinkService.recordBotAccessProbe).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: '-100-removed-roster',
        botId: 'bot-1',
        access: expect.objectContaining({ isAdmin: true }),
        allowMembershipRecovery: true,
      }),
    );
  });

  it('does not run roster side effects when the access probe CAS is superseded', async () => {
    const {
      service,
      prisma,
      maxClient,
      maxBotLinkService,
      maxBotRegistry,
      chatContextCache,
      nightModeTransitionScheduler,
    } = createService();
    maxBotRegistry.getDiscoveryBots.mockReturnValue([{ id: 'bot-1', state: 'active' }]);
    maxClient.getCurrentChatMemberAccess.mockResolvedValue({
      userId: 'bot-user-1',
      isAdmin: true,
      isOwner: false,
      permissions: ['write'],
    });
    maxBotLinkService.recordBotAccessProbe.mockResolvedValue(false);

    await expect(
      service.processJob({
        chatId: '-100-superseded-roster',
        botIds: ['bot-1'],
        title: 'Superseded roster chat',
        entityType: 'chat',
        source: 'webhook_bot_removed',
      }),
    ).rejects.toThrow('superseded');

    expect(maxClient.getChatAdminIds).not.toHaveBeenCalled();
    expect(prisma.chatAdminAllowlist.findMany).not.toHaveBeenCalled();
    expect(prisma.chatAdminAllowlist.createMany).not.toHaveBeenCalled();
    expect(prisma.chatAdminAllowlist.deleteMany).not.toHaveBeenCalled();
    expect(prisma.managedEntityAccessEdge.upsert).not.toHaveBeenCalled();
    expect(prisma.managedEntityAdminMember.upsert).not.toHaveBeenCalled();
    expect(prisma.chat.update).not.toHaveBeenCalled();
    expect(chatContextCache.replaceChatAdminUsers).not.toHaveBeenCalled();
    expect(chatContextCache.applyAdminAccessEpochMutation).not.toHaveBeenCalled();
    expect(nightModeTransitionScheduler.reconcileChat).not.toHaveBeenCalled();
  });

  it('uses probe start as the recovery boundary when a removal arrives in flight', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-14T09:00:00.000Z'));
    try {
      const { service, maxClient, maxBotLinkService } = createService();
      let resolveAccess!: (value: {
        userId: string;
        isAdmin: boolean;
        isOwner: boolean;
        permissions: string[];
      }) => void;
      let markRequestStarted!: () => void;
      const requestStarted = new Promise<void>((resolve) => {
        markRequestStarted = resolve;
      });
      const accessResult = new Promise<{
        userId: string;
        isAdmin: boolean;
        isOwner: boolean;
        permissions: string[];
      }>((resolve) => {
        resolveAccess = resolve;
      });
      maxClient.getCurrentChatMemberAccess.mockImplementation(() => {
        markRequestStarted();
        return accessResult;
      });
      maxClient.getChatAdminIds.mockResolvedValue(['user-1']);

      const processing = service.processJob({
        chatId: '-100-in-flight-removal',
        botIds: ['bot-1'],
        title: 'In-flight removal chat',
        entityType: 'chat',
        source: 'webhook_bot_removed',
      });
      await requestStarted;
      jest.setSystemTime(new Date('2026-05-14T09:00:30.000Z'));
      resolveAccess({
        userId: 'bot-user-1',
        isAdmin: true,
        isOwner: false,
        permissions: ['write'],
      });

      await expect(processing).resolves.toBe(true);
      expect(maxBotLinkService.recordBotAccessProbe).toHaveBeenCalledWith(
        expect.objectContaining({
          chatId: '-100-in-flight-removal',
          botId: 'bot-1',
          checkedAt: new Date('2026-05-14T09:00:00.000Z'),
          allowMembershipRecovery: true,
        }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps non-webhook roster sync reads on the background traffic lane', async () => {
    const { service, maxClient } = createService();
    maxClient.getCurrentChatMemberAccess.mockResolvedValue({
      userId: 'bot-user-1',
      isAdmin: true,
      isOwner: false,
      permissions: ['delete_messages'],
    });
    maxClient.getChatAdminIds.mockResolvedValue(['user-1']);

    await expect(
      service.processJob({
        chatId: '-100127',
        botIds: ['bot-1'],
        title: 'Discovery chat',
        entityType: 'chat',
        source: 'discovery_snapshot',
      }),
    ).resolves.toBe(true);

    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledWith(
      '-100127',
      expect.objectContaining({
        botId: 'bot-1',
        trafficClass: 'background',
        actionHealthLane: 'background',
        timeoutMs: 2_500,
      }),
    );
    expect(maxClient.getChatAdminIds).toHaveBeenCalledWith(
      '-100127',
      expect.objectContaining({
        botId: 'bot-1',
        trafficClass: 'background',
        actionHealthLane: 'background',
        timeoutMs: 2_500,
      }),
    );
  });

  it('uses the background lane with a fast timeout to prewarm membership churn snapshots', async () => {
    const { service, maxClient } = createService();
    maxClient.getCurrentChatMemberAccess.mockResolvedValue({
      userId: 'bot-user-1',
      isAdmin: true,
      isOwner: false,
      permissions: ['delete_messages'],
    });
    maxClient.getChatAdminIds.mockResolvedValue(['user-1']);

    await expect(
      service.processJob({
        chatId: '-100128',
        botIds: ['bot-1'],
        title: 'Joined chat',
        entityType: 'chat',
        source: 'webhook_membership_churn',
      }),
    ).resolves.toBe(true);

    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledWith(
      '-100128',
      expect.objectContaining({
        botId: 'bot-1',
        trafficClass: 'background',
        actionHealthLane: 'background',
        timeoutMs: 1_500,
      }),
    );
    expect(maxClient.getChatAdminIds).toHaveBeenCalledWith(
      '-100128',
      expect.objectContaining({
        botId: 'bot-1',
        trafficClass: 'background',
        actionHealthLane: 'background',
        timeoutMs: 1_500,
      }),
    );
  });

  it('uses the background lane with a fast timeout for destructive moderation roster refreshes', async () => {
    const { service, queue, maxClient } = createService();

    await expect(
      service.scheduleChatAdminRosterSync({
        chatId: '-100129',
        botIds: ['bot-1'],
        title: 'Closed chat',
        entityType: 'chat',
        source: 'moderation_destructive_path',
      }),
    ).resolves.toBe(true);

    expect(queue.add).toHaveBeenCalledWith(
      'sync-chat-admin-roster',
      expect.objectContaining({
        chatId: '-100129',
        source: 'moderation_destructive_path',
      }),
      expect.objectContaining({
        attempts: 6,
        priority: 2,
        backoff: {
          type: 'fixed',
          delay: 3_000,
        },
      }),
    );

    maxClient.getCurrentChatMemberAccess.mockResolvedValue({
      userId: 'bot-user-1',
      isAdmin: true,
      isOwner: false,
      permissions: ['delete_messages'],
    });
    maxClient.getChatAdminIds.mockResolvedValue(['user-1']);

    await expect(
      service.processJob({
        chatId: '-100129',
        botIds: ['bot-1'],
        title: 'Closed chat',
        entityType: 'chat',
        source: 'moderation_destructive_path',
      }),
    ).resolves.toBe(true);

    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledWith(
      '-100129',
      expect.objectContaining({
        botId: 'bot-1',
        trafficClass: 'background',
        actionHealthLane: 'background',
        timeoutMs: 1_500,
      }),
    );
    expect(maxClient.getChatAdminIds).toHaveBeenCalledWith(
      '-100129',
      expect.objectContaining({
        botId: 'bot-1',
        trafficClass: 'background',
        actionHealthLane: 'background',
        timeoutMs: 1_500,
      }),
    );
  });

  it('keeps read-only admin access validation on the background refresh lane', async () => {
    const { service, queue } = createService();

    await expect(
      service.scheduleChatAdminRosterSync({
        chatId: '-100130',
        entityType: 'chat',
        source: 'admin_access_validation',
      }),
    ).resolves.toBe(true);

    expect(queue.add).toHaveBeenCalledWith(
      'sync-chat-admin-roster',
      expect.objectContaining({
        chatId: '-100130',
        source: 'admin_access_validation',
      }),
      expect.objectContaining({
        attempts: 6,
        priority: 2,
        backoff: {
          type: 'fixed',
          delay: 3_000,
        },
      }),
    );
  });

  it('does not enqueue private direct chats as managed roster sync jobs', async () => {
    const { service, queue } = createService();

    await expect(
      service.scheduleChatAdminRosterSync({
        chatId: '214007512',
        source: 'webhook_membership_churn',
      }),
    ).resolves.toBe(false);

    expect(queue.add).not.toHaveBeenCalled();
  });

  it('skips private direct roster sync jobs that were already queued', async () => {
    const { service, maxClient, maxBotLinkService } = createService();

    await expect(
      service.processJob({
        chatId: '214007512',
        botIds: ['bot-1'],
        source: 'webhook_membership_churn',
      }),
    ).resolves.toBe(false);

    expect(maxClient.getCurrentChatMemberAccess).not.toHaveBeenCalled();
    expect(maxBotLinkService.bindDiscoveredChatBots).not.toHaveBeenCalled();
  });

  it('pushes allowlist changes into existing published snapshots for affected admins', async () => {
    const { service, prisma, maxClient, chatContextCache } = createService();
    prisma.chatAdminAllowlist.findMany
      .mockResolvedValueOnce([{ userId: 'user-1' }, { userId: 'user-3' }])
      .mockResolvedValueOnce([{ userId: 'user-1' }, { userId: 'user-2' }]);
    prisma.chat.findUnique.mockResolvedValue({
      title: 'Snapshot chat',
      entityType: 'CHAT',
      primaryBotId: 'bot-1',
      botId: 'bot-1',
      botMemberships: [],
      id: '-100126',
      createdAt: new Date('2026-04-05T10:00:00.000Z'),
    });
    maxClient.getCurrentChatMemberAccess.mockResolvedValue({
      userId: 'bot-user-1',
      isAdmin: true,
      isOwner: false,
      permissions: ['delete_messages'],
    });
    maxClient.getChatAdminIds.mockResolvedValue(['user-1', 'user-2']);
    chatContextCache.getManagedEntitiesPublishedSnapshot.mockImplementation(
      async (userId: string, entityType: string) => {
        if (entityType !== 'chat') {
          return null;
        }
        if (userId === 'user-1') {
          return {
            version: 'snapshot-user-1',
            builtAt: '2026-04-05T09:00:00.000Z',
            lastSyncedAt: '2026-04-05T09:00:00.000Z',
            itemCount: 1,
            itemsHash: 'hash-1',
            items: [
              {
                id: '-100000',
                title: 'Existing',
                createdAt: '2026-04-04T10:00:00.000Z',
                entityType: 'chat',
                link: null,
                channelOverview: null,
                primaryBotId: 'bot-1',
                assignedBots: [],
                sharedMode: 'owned',
              },
            ],
          };
        }
        if (userId === 'user-3') {
          return {
            version: 'snapshot-user-3',
            builtAt: '2026-04-05T09:00:00.000Z',
            lastSyncedAt: '2026-04-05T09:00:00.000Z',
            itemCount: 2,
            itemsHash: 'hash-3',
            items: [
              {
                id: '-100126',
                title: 'Snapshot chat',
                createdAt: '2026-04-05T10:00:00.000Z',
                entityType: 'chat',
                link: null,
                channelOverview: null,
                primaryBotId: 'bot-1',
                assignedBots: [],
                sharedMode: 'owned',
              },
              {
                id: '-100999',
                title: 'Other',
                createdAt: '2026-04-04T10:00:00.000Z',
                entityType: 'chat',
                link: null,
                channelOverview: null,
                primaryBotId: 'bot-1',
                assignedBots: [],
                sharedMode: 'owned',
              },
            ],
          };
        }
        return null;
      },
    );

    await expect(
      service.processJob({
        chatId: '-100126',
        botIds: ['bot-1'],
        title: 'Snapshot chat',
        entityType: 'chat',
      }),
    ).resolves.toBe(true);

    expect(chatContextCache.applyAdminAccessEpochMutation).toHaveBeenCalledTimes(3);
    for (const userId of ['user-1', 'user-2']) {
      expect(chatContextCache.applyAdminAccessEpochMutation).toHaveBeenCalledWith(
        expect.objectContaining({
          chatId: '-100126',
          userId,
          state: 'granted',
          eventAt: expect.any(Date),
          publishedSummary: expect.objectContaining({
            id: '-100126',
            title: 'Snapshot chat',
            entityType: 'chat',
          }),
          publishedSnapshotTtlSec: 604800,
        }),
      );
    }
    expect(chatContextCache.applyAdminAccessEpochMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: '-100126',
        userId: 'user-3',
        state: 'user_denied',
        eventAt: expect.any(Date),
      }),
    );
    expect(chatContextCache.getManagedEntitiesPublishedSnapshot).not.toHaveBeenCalled();
    expect(chatContextCache.setManagedEntitiesPublishedSnapshot).not.toHaveBeenCalled();
  });

  it('atomically creates a first published snapshot during roster sync', async () => {
    const { service, prisma, maxClient, chatContextCache } = createService();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([{ userId: 'user-1' }]);
    prisma.chat.findUnique.mockResolvedValue({
      title: 'New chat',
      entityType: 'CHAT',
      primaryBotId: 'bot-1',
      botId: 'bot-1',
      id: '-100127',
      createdAt: new Date('2026-04-05T10:00:00.000Z'),
    });
    maxClient.getCurrentChatMemberAccess.mockResolvedValue({
      userId: 'bot-user-1',
      isAdmin: true,
      isOwner: false,
      permissions: ['delete_messages'],
    });
    maxClient.getChatAdminIds.mockResolvedValue(['user-1']);
    chatContextCache.getManagedEntitiesPublishedSnapshot.mockResolvedValue(null);

    await expect(
      service.processJob({
        chatId: '-100127',
        botIds: ['bot-1'],
        title: 'New chat',
        entityType: 'chat',
        source: 'handshake_start',
      }),
    ).resolves.toBe(true);

    expect(chatContextCache.applyAdminAccessEpochMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: '-100127',
        userId: 'user-1',
        state: 'granted',
        publishedSummary: expect.objectContaining({
          id: '-100127',
          title: 'New chat',
          entityType: 'chat',
        }),
        publishedSnapshotTtlSec: 604800,
      }),
    );
    expect(chatContextCache.getManagedEntitiesPublishedSnapshot).not.toHaveBeenCalled();
    expect(chatContextCache.setManagedEntitiesPublishedSnapshot).not.toHaveBeenCalled();
  });

  it('rejects a roster result when bot removal supersedes its accepted probe before persistence', async () => {
    const {
      service,
      prisma,
      maxClient,
      chatContextCache,
      nightModeTransitionScheduler,
      latestProbeByMembership,
    } = createService();
    maxClient.getCurrentChatMemberAccess.mockResolvedValue({
      userId: 'bot-user-1',
      isAdmin: true,
      isOwner: false,
      permissions: ['delete_messages'],
    });
    let releaseRoster!: () => void;
    const rosterGate = new Promise<void>((resolve) => {
      releaseRoster = resolve;
    });
    let markRosterRequested!: () => void;
    const rosterRequested = new Promise<void>((resolve) => {
      markRosterRequested = resolve;
    });
    maxClient.getChatAdminIds.mockImplementation(async () => {
      markRosterRequested();
      await rosterGate;
      return ['user-1'];
    });

    const processing = service.processJob({
      chatId: '-100-roster-removed-before-persist',
      botIds: ['bot-1'],
      title: 'Removed roster chat',
      entityType: 'chat',
      source: 'webhook_membership_churn',
    });
    await rosterRequested;
    const membershipKey = '-100-roster-removed-before-persist:bot-1';
    const acceptedProbe = latestProbeByMembership.get(membershipKey);
    if (!acceptedProbe) {
      throw new Error('accepted probe fixture state missing');
    }
    latestProbeByMembership.set(membershipKey, {
      ...acceptedProbe,
      status: 'REMOVED',
      botAccessState: 'DENIED',
      lifecycleEventAt: new Date(acceptedProbe.botAccessCheckedAt.getTime() + 1),
      lifecycleEventType: 'bot_removed',
      lifecycleSource: 'webhook',
    });
    releaseRoster();

    await expect(processing).rejects.toThrow(
      'Admin roster access epoch was superseded before sync completion (bot-1)',
    );
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.chatAdminAllowlist.findMany).not.toHaveBeenCalled();
    expect(prisma.chatAdminAllowlist.createMany).not.toHaveBeenCalled();
    expect(prisma.chatAdminAllowlist.deleteMany).not.toHaveBeenCalled();
    expect(prisma.managedEntityAccessEdge.upsert).not.toHaveBeenCalled();
    expect(prisma.managedEntityAdminMember.upsert).not.toHaveBeenCalled();
    expect(prisma.chat.update).not.toHaveBeenCalled();
    expect(chatContextCache.replaceChatAdminUsers).not.toHaveBeenCalled();
    expect(chatContextCache.setAdminAccess).not.toHaveBeenCalled();
    expect(chatContextCache.setManagedEntitiesPublishedSnapshot).not.toHaveBeenCalled();
    expect(chatContextCache.applyAdminAccessEpochMutation).not.toHaveBeenCalled();
    expect(nightModeTransitionScheduler.reconcileChat).not.toHaveBeenCalled();
  });

  it('does not publish roster caches when removal wins after the database commit', async () => {
    const { service, prisma, maxClient, chatContextCache, latestProbeByMembership } =
      createService();
    maxClient.getCurrentChatMemberAccess.mockResolvedValue({
      userId: 'bot-user-1',
      isAdmin: true,
      isOwner: false,
      permissions: ['delete_messages'],
    });
    maxClient.getChatAdminIds.mockResolvedValue(['user-1']);
    const originalTransaction = prisma.$transaction.getMockImplementation();
    if (!originalTransaction) {
      throw new Error('transaction fixture implementation missing');
    }
    let transactionCalls = 0;
    prisma.$transaction.mockImplementation(async (...args) => {
      transactionCalls += 1;
      const result = await originalTransaction(...args);
      if (transactionCalls === 1) {
        const membershipKey = '-100-roster-removed-before-cache:bot-1';
        const acceptedProbe = latestProbeByMembership.get(membershipKey);
        if (!acceptedProbe) {
          throw new Error('accepted probe fixture state missing');
        }
        latestProbeByMembership.set(membershipKey, {
          ...acceptedProbe,
          status: 'REMOVED',
          botAccessState: 'DENIED',
          lifecycleEventAt: new Date(acceptedProbe.botAccessCheckedAt.getTime() + 1),
          lifecycleEventType: 'bot_removed',
          lifecycleSource: 'webhook',
        });
      }
      return result;
    });

    await expect(
      service.processJob({
        chatId: '-100-roster-removed-before-cache',
        botIds: ['bot-1'],
        title: 'Removed cache chat',
        entityType: 'chat',
        source: 'webhook_membership_churn',
      }),
    ).rejects.toThrow('Admin roster access epoch was superseded before sync completion (bot-1)');

    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(prisma.managedEntityAccessEdge.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.managedEntityAdminMember.upsert).toHaveBeenCalledTimes(1);
    expect(chatContextCache.replaceChatAdminUsers).not.toHaveBeenCalled();
    expect(chatContextCache.setAdminAccess).not.toHaveBeenCalled();
    expect(chatContextCache.setManagedEntitiesPublishedSnapshot).not.toHaveBeenCalled();
    expect(chatContextCache.applyAdminAccessEpochMutation).not.toHaveBeenCalled();
    expect(chatContextCache.clearManagedEntitiesRecentBootstrapForChat).not.toHaveBeenCalled();
  });
});
