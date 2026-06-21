import { MaxChatAdminRosterSyncService } from './max-chat-admin-roster-sync.service';

describe('MaxChatAdminRosterSyncService', () => {
  function createService() {
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
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      managedEntityAccessEdge: {
        upsert: jest.fn().mockResolvedValue(undefined),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      managedEntityAdminMember: {
        upsert: jest.fn().mockResolvedValue(undefined),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    const maxClient = {
      getCurrentChatMemberAccess: jest.fn(),
      getChatAdminIds: jest.fn(),
      listBotChats: jest.fn(),
    };
    const maxBotLinkService = {
      bindDiscoveredChatBots: jest.fn().mockResolvedValue('bot-1'),
      reconcileChatPrimaryByAccess: jest.fn().mockResolvedValue('bot-1'),
    };
    const maxBotRegistry = {
      getBotById: jest.fn((botId?: string | null) => (botId ? { id: botId } : null)),
      getDiscoveryBots: jest.fn().mockReturnValue([{ id: 'bot-1' }, { id: 'bot-2' }]),
    };
    const chatContextCache = {
      replaceChatAdminUsers: jest.fn().mockResolvedValue(undefined),
      setAdminAccess: jest.fn().mockResolvedValue(undefined),
      getManagedEntityHeader: jest.fn().mockResolvedValue(null),
      getManagedEntitiesPublishedSnapshot: jest.fn().mockResolvedValue(null),
      setManagedEntitiesPublishedSnapshot: jest.fn().mockResolvedValue(undefined),
      clearManagedEntitiesRecentBootstrapForChat: jest.fn().mockResolvedValue(undefined),
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
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      { userId: 'user-1' },
      { userId: 'user-3' },
    ]);
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
    expect(chatContextCache.replaceChatAdminUsers).toHaveBeenCalledWith('-100123', [
      'user-1',
      'user-2',
    ]);
    expect(chatContextCache.setAdminAccess).toHaveBeenCalledWith('-100123', 'user-1', 'granted');
    expect(chatContextCache.setAdminAccess).toHaveBeenCalledWith('-100123', 'user-2', 'granted');
    expect(chatContextCache.setAdminAccess).toHaveBeenCalledWith(
      '-100123',
      'user-3',
      'user_denied',
    );
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
        where: {
          chatId: '-100123',
          userId: {
            in: ['user-3'],
          },
          botId: 'bot-1',
        },
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
    expect(chatContextCache.clearManagedEntitiesRecentBootstrapForChat).toHaveBeenCalledWith(
      '-100123',
      'chat',
    );
    expect(nightModeTransitionScheduler.reconcileChat).toHaveBeenCalledWith('-100123');
  });

  it('clears stale allowlist rows when no bot keeps admin access', async () => {
    const { service, prisma, maxClient, chatContextCache, nightModeTransitionScheduler } =
      createService();
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
    expect(chatContextCache.replaceChatAdminUsers).toHaveBeenCalledWith('-100124', []);
    expect(chatContextCache.setAdminAccess).toHaveBeenCalledWith('-100124', 'user-7', 'bot_denied');
    expect(chatContextCache.setAdminAccess).toHaveBeenCalledWith('-100124', 'user-8', 'bot_denied');
    expect(chatContextCache.clearManagedEntitiesRecentBootstrapForChat).toHaveBeenCalledWith(
      '-100124',
      null,
    );
    expect(nightModeTransitionScheduler.reconcileChat).not.toHaveBeenCalled();
  });

  it('backs off repeated terminal bot access failures before clearing allowlist again', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-14T09:00:00.000Z'));
    const { service, prisma, maxClient, chatContextCache } = createService();
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
    expect(chatContextCache.replaceChatAdminUsers).toHaveBeenCalledTimes(1);
  });

  it('applies a short managed_refresh source backoff after source limit pressure', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-14T09:00:00.000Z'));
    const { service, maxClient, maxBotLinkService } = createService();
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
      ).rejects.toThrow('source limit exceeded');
      await expect(
        service.processJob({
          chatId: '-100132',
          botIds: ['bot-1'],
          title: 'Another busy chat',
          entityType: 'chat',
        }),
      ).rejects.toThrow('source backoff active');
    } finally {
      jest.useRealTimers();
    }

    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledTimes(1);
    expect(maxBotLinkService.bindDiscoveredChatBots).toHaveBeenCalledTimes(2);
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
    expect(nightModeTransitionScheduler.reconcileChat).not.toHaveBeenCalled();
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
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      { userId: 'user-1' },
      { userId: 'user-3' },
    ]);
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

    expect(chatContextCache.setManagedEntitiesPublishedSnapshot).toHaveBeenCalledTimes(2);
    expect(chatContextCache.setManagedEntitiesPublishedSnapshot).toHaveBeenNthCalledWith(
      1,
      'user-1',
      'chat',
      expect.objectContaining({
        itemCount: 2,
        items: expect.arrayContaining([
          expect.objectContaining({ id: '-100126', title: 'Snapshot chat' }),
        ]),
      }),
      604800,
    );
    expect(chatContextCache.setManagedEntitiesPublishedSnapshot).toHaveBeenNthCalledWith(
      2,
      'user-3',
      'chat',
      expect.objectContaining({
        itemCount: 1,
        items: [expect.objectContaining({ id: '-100999' })],
      }),
      604800,
    );
  });

  it('does not create first published snapshots during roster sync', async () => {
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

    expect(chatContextCache.getManagedEntitiesPublishedSnapshot).toHaveBeenCalledWith(
      'user-1',
      'chat',
    );
    expect(chatContextCache.setManagedEntitiesPublishedSnapshot).not.toHaveBeenCalled();
  });
});
