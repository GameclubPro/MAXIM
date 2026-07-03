import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { ManagedEntitiesService } from './managed-entities.service';

const user = {
  userId: 'admin-1',
  username: null,
  displayName: null,
  chatTitle: null,
};

function createPlan(entityType: 'chat' | 'channel' = 'chat') {
  return {
    chatId: 'chat-1',
    entityType,
    primaryBotId: 'bot-1',
    speakerBotId: 'bot-1',
    workerBotId: 'bot-1',
    linkBotId: 'bot-1',
    partnerBotId: null,
    sharedMode: 'owned',
    userFacingPolicy: 'owner-only',
    reasons: [],
    warnings: [],
    assignedBots: [],
  };
}

function createPrismaMock() {
  return {
    chat: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'chat-1',
        title: 'Кэш чата',
      }),
      update: jest.fn().mockResolvedValue({}),
    },
    chatAdminAllowlist: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    chatBotMembership: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    managedEntityAdminMember: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
    managedEntityAccessEdge: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
    managedEntityFavorite: {
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn(() => ({ operation: 'delete-many-favorites' })),
      upsert: jest.fn(() => ({ operation: 'upsert-favorite' })),
    },
    managedEntityLocalActivity: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    managedEntityHandshakeOutcome: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
    auditLog: {
      create: jest.fn(() => ({ operation: 'audit-log' })),
    },
    $transaction: jest.fn().mockResolvedValue([]),
  };
}

function createConfigMock(
  options: {
    previousToken?: string;
    botId?: string | null;
    token?: string;
    systemAdminUserIds?: string | null;
  } = {},
) {
  return {
    getOrThrow: jest.fn((key: string) => {
      if (key === 'MAX_BOT_TOKEN') {
        return options.token ?? 'test-max-bot-token';
      }
      throw new Error(`Missing key: ${key}`);
    }),
    get: jest.fn((key: string) => {
      if (key === 'APP_BASE_URL') {
        return 'https://major-maksimov.ru';
      }
      if (key === 'MAX_BOT_ID') {
        return options.botId ?? '777000_bot';
      }
      if (key === 'MAX_BOT_CONTACT_ID') {
        return '777000';
      }
      if (key === 'MAX_BOT_TOKEN_PREVIOUS') {
        return options.previousToken ?? null;
      }
      if (key === 'NODE_ENV') {
        return options.systemAdminUserIds !== undefined ? 'production' : 'test';
      }
      if (key === 'SYSTEM_ADMIN_USER_IDS') {
        return options.systemAdminUserIds ?? null;
      }
      return null;
    }),
  };
}

function createMaxBotExecutionPlannerMock() {
  return {
    getManagedEntityExecutionPlan: jest.fn().mockResolvedValue(createPlan()),
    setPrimaryBot: jest.fn().mockResolvedValue(createPlan()),
    setPartnerAssist: jest.fn().mockResolvedValue(createPlan()),
    promoteStandby: jest.fn().mockResolvedValue(createPlan()),
  };
}

function createMaxBotRegistryMock() {
  return {
    getBotById: jest.fn((botId?: string | null) =>
      botId ? { id: botId, label: botId === 'bot-1' ? 'Основной бот' : botId } : null,
    ),
  };
}

function createService(
  options: {
    maxClient?: Record<string, unknown>;
    maxBotExecutionPlanner?: ReturnType<typeof createMaxBotExecutionPlannerMock> | null;
    maxBotRegistry?: ReturnType<typeof createMaxBotRegistryMock> | null;
    maxChatAdminRosterSyncService?: { scheduleChatAdminRosterSync: jest.Mock } | null;
    config?: Parameters<typeof createConfigMock>[0];
  } = {},
) {
  const legacyAdminService = {
    assertManagedEntityAdminAccess: jest.fn().mockResolvedValue(undefined),
    assertManagedEntityReadAccess: jest.fn().mockResolvedValue(undefined),
    listChats: jest.fn(),
    listChatsWithRefreshState: jest.fn(),
    listChannels: jest.fn(),
    listChannelsWithRefreshState: jest.fn(),
    processManagedEntitiesRefreshJob: jest.fn(),
    runManagedEntitiesBoundedRefreshForManagedEntities: jest
      .fn()
      .mockResolvedValue({ continueAfterMs: 5_000 }),
    runManagedEntitiesRemoteFullRefreshForManagedEntities: jest.fn(),
    listManagedEntitiesDetailedForManagedEntities: jest.fn().mockResolvedValue({
      items: [],
      refresh: null,
    }),
    attachManagedEntityFavoriteTypesForManagedEntities: jest
      .fn()
      .mockImplementation(async (_userId: string, items: readonly unknown[]) => items),
    attachManagedEntityFavoriteTypesToDiffForManagedEntities: jest
      .fn()
      .mockImplementation(async (_userId: string, diff: unknown) => diff),
    createIdleManagedEntitiesRefreshStateForManagedEntities: jest.fn().mockReturnValue({
      complete: false,
      cursor: null,
      backoffActive: false,
      nextPollAfterMs: 1500,
      processedCandidates: 0,
      totalCandidates: null,
      progressPercent: null,
      lastSyncedAt: null,
      manualRefreshBlockedReason: null,
      manualRefreshRetryAfterMs: null,
    }),
    getChatHeader: jest.fn(),
    getChannelHeader: jest.fn(),
    resolveManagedEntityHeaderReadBotId: jest.fn().mockResolvedValue('bot-1'),
    attachManagedEntityHeaderBotAssignmentsForManagedEntities: jest
      .fn()
      .mockImplementation(async (header) => ({
        ...header,
        primaryBotId: header.primaryBotId ?? 'bot-1',
        assignedBots: header.assignedBots ?? [],
        sharedMode: header.sharedMode ?? 'owned',
      })),
    updateManagedEntityFavorites: jest.fn(),
  };
  const prisma = createPrismaMock();
  const chatContextCache = {
    getManagedEntityHeader: jest.fn().mockResolvedValue(null),
    setManagedEntityHeader: jest.fn().mockResolvedValue(undefined),
    invalidateManagedEntityHeader: jest.fn().mockResolvedValue(undefined),
  };
  const maxClient = options.maxClient ?? {
    getChatMemberProfiles: jest.fn(),
    getChatSnapshot: jest.fn().mockResolvedValue({
      chatId: 'chat-1',
      title: 'Живой чат',
      participantsCount: 12,
      status: null,
      isPublic: true,
      link: 'https://max.ru/chat-1',
      lastEventAt: null,
      entityType: 'chat',
      avatarUrl: 'https://cdn.max/chat-1.png',
    }),
  };
  const configService = createConfigMock(options.config);
  const maxBotExecutionPlanner =
    options.maxBotExecutionPlanner === null
      ? undefined
      : (options.maxBotExecutionPlanner ?? createMaxBotExecutionPlannerMock());
  const maxBotRegistry =
    options.maxBotRegistry === null ? undefined : (options.maxBotRegistry ?? createMaxBotRegistryMock());
  const maxChatAdminRosterSyncService =
    options.maxChatAdminRosterSyncService === null
      ? undefined
      : (options.maxChatAdminRosterSyncService ?? {
          scheduleChatAdminRosterSync: jest.fn().mockResolvedValue(true),
        });
  const service = new ManagedEntitiesService(
    legacyAdminService as never,
    prisma as never,
    chatContextCache as never,
    maxClient as never,
    configService as never,
    maxBotExecutionPlanner as never,
    undefined,
    maxBotRegistry as never,
    maxChatAdminRosterSyncService as never,
  );

  return {
    chatContextCache,
    configService,
    legacyAdminService,
    maxClient,
    maxBotExecutionPlanner,
    maxBotRegistry,
    maxChatAdminRosterSyncService,
    prisma,
    service,
  };
}

describe('ManagedEntitiesService getMe', () => {
  const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const encodeProfileLabel = (value: string): string =>
    new URLSearchParams({ profile_label: value }).toString().replace(/^profile_label=/u, '');
  const chatProfileHandoffUrl = (profileLabel: string | null) =>
    expect.stringMatching(
      new RegExp(
        `^https:\\/\\/max\\.ru\\/777000_bot\\?start=pm2_chat-1_h_admin-1_[a-f0-9]{16}${
          profileLabel ? `&profile_label=${escapeRegex(encodeProfileLabel(profileLabel))}` : ''
        }$`,
        'u',
      ),
    );

  it('returns init data profile when username is already present', async () => {
    const maxClient = {
      getChatMemberProfiles: jest.fn(),
    };
    const { service } = createService({ maxClient });

    await expect(
      service.getMe({
        userId: 'admin-1',
        username: 'designer',
        displayName: 'Designer',
        avatarUrl: 'https://cdn.max/avatar.png',
        chatId: 'chat-1',
        chatTitle: 'Рабочий чат',
        chatType: 'chat',
      }),
    ).resolves.toEqual({
      userId: 'admin-1',
      username: 'designer',
      displayName: 'Designer',
      avatarUrl: 'https://cdn.max/avatar.png',
      profileUrl: 'https://max.ru/designer',
      profileHandoffUrl: chatProfileHandoffUrl('Designer'),
    });
    expect(maxClient.getChatMemberProfiles).not.toHaveBeenCalled();
  });

  it('enriches current admin profile from MAX member data only when explicitly requested', async () => {
    const maxClient = {
      getChatMemberProfiles: jest.fn().mockResolvedValue(
        new Map([
          [
            'admin-1',
            {
              userId: 'admin-1',
              username: 'designer',
              displayName: 'Designer Max',
              avatarUrl: 'https://cdn.max/designer.png',
            },
          ],
        ]),
      ),
    };
    const { service } = createService({ maxClient });

    await expect(
      service.getMe(
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          avatarUrl: null,
        },
        { chatId: 'chat-1', enrichFromMax: true },
      ),
    ).resolves.toEqual({
      userId: 'admin-1',
      username: 'designer',
      displayName: 'Designer Max',
      avatarUrl: 'https://cdn.max/designer.png',
      profileUrl: 'https://max.ru/designer',
      profileHandoffUrl: chatProfileHandoffUrl('Designer Max'),
    });
    expect(maxClient.getChatMemberProfiles).toHaveBeenCalledWith('chat-1', ['admin-1'], {
      trafficClass: 'interactive',
      actionHealthLane: 'background',
    });
  });

  it('keeps direct MAX profile url when init data already has it without username', async () => {
    const maxClient = {
      getChatMemberProfiles: jest.fn(),
    };
    const { service } = createService({ maxClient });

    await expect(
      service.getMe({
        userId: 'admin-1',
        username: null,
        displayName: 'Designer',
        avatarUrl: 'https://cdn.max/avatar.png',
        profileUrl: 'https://max.ru/designer-direct',
      }),
    ).resolves.toEqual({
      userId: 'admin-1',
      username: null,
      displayName: 'Designer',
      avatarUrl: 'https://cdn.max/avatar.png',
      profileUrl: 'https://max.ru/designer-direct',
      profileHandoffUrl: null,
    });
    expect(maxClient.getChatMemberProfiles).not.toHaveBeenCalled();
  });

  it('keeps profile url empty when username is unavailable', async () => {
    const maxClient = {
      getChatMemberProfiles: jest.fn().mockResolvedValue(
        new Map([
          [
            'admin-1',
            {
              userId: 'admin-1',
              username: null,
              displayName: 'Designer Max',
              avatarUrl: 'https://cdn.max/designer.png',
            },
          ],
        ]),
      ),
    };
    const { service } = createService({ maxClient });

    await expect(
      service.getMe(
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          avatarUrl: null,
        },
        { chatId: 'chat-1', entityType: 'chat', enrichFromMax: true },
      ),
    ).resolves.toEqual({
      userId: 'admin-1',
      username: null,
      displayName: 'Designer Max',
      avatarUrl: 'https://cdn.max/designer.png',
      profileUrl: null,
      profileHandoffUrl: chatProfileHandoffUrl('Designer Max'),
    });
    expect(maxClient.getChatMemberProfiles).toHaveBeenCalledWith('chat-1', ['admin-1'], {
      trafficClass: 'interactive',
      actionHealthLane: 'background',
    });
  });

  it('returns direct MAX profile url from member data when username is unavailable', async () => {
    const maxClient = {
      getChatMemberProfiles: jest.fn().mockResolvedValue(
        new Map([
          [
            'admin-1',
            {
              userId: 'admin-1',
              username: null,
              displayName: 'Designer Max',
              avatarUrl: 'https://cdn.max/designer.png',
              profileUrl: 'https://max.ru/designer-direct',
            },
          ],
        ]),
      ),
    };
    const { service } = createService({ maxClient });

    await expect(
      service.getMe(
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          avatarUrl: null,
        },
        { chatId: 'chat-1', entityType: 'chat', enrichFromMax: true },
      ),
    ).resolves.toEqual({
      userId: 'admin-1',
      username: null,
      displayName: 'Designer Max',
      avatarUrl: 'https://cdn.max/designer.png',
      profileUrl: 'https://max.ru/designer-direct',
      profileHandoffUrl: chatProfileHandoffUrl('Designer Max'),
    });
    expect(maxClient.getChatMemberProfiles).toHaveBeenCalledWith('chat-1', ['admin-1'], {
      trafficClass: 'interactive',
      actionHealthLane: 'background',
    });
  });

  it('returns init data fallback by default when profile enrichment is not explicitly requested', async () => {
    const maxClient = {
      getChatMemberProfiles: jest.fn(),
    };
    const { service } = createService({ maxClient });

    await expect(
      service.getMe(
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          avatarUrl: null,
        },
        { chatId: 'chat-1' },
      ),
    ).resolves.toEqual({
      userId: 'admin-1',
      username: null,
      displayName: null,
      avatarUrl: null,
      profileUrl: null,
      profileHandoffUrl: chatProfileHandoffUrl(null),
    });
    expect(maxClient.getChatMemberProfiles).not.toHaveBeenCalled();
  });
});

describe('ManagedEntitiesService list flow', () => {
  const chatSummary = {
    id: 'chat-1',
    title: 'Рабочий чат',
    entityType: 'chat',
    link: 'https://max.ru/chat-1',
    participantsCount: 12,
    channelOverview: null,
    primaryBotId: 'bot-1',
    assignedBots: [
      {
        botId: 'bot-1',
        label: 'Primary Bot',
        role: 'primary',
        membershipStatus: 'active',
        lifecycleState: 'active',
        speechPersona: 'male',
        characterName: null,
        avatarUrl: null,
        capabilities: [],
        permissionsSummary: null,
      },
      {
        botId: 'bot-2',
        label: 'Standby Bot',
        role: 'standby',
        membershipStatus: 'active',
        lifecycleState: 'active',
        speechPersona: 'female',
        characterName: null,
        avatarUrl: null,
        capabilities: [],
        permissionsSummary: null,
      },
    ],
    sharedMode: 'shared-standby',
  };
  const publicChatSummary = {
    ...chatSummary,
    primaryBotId: null,
    assignedBots: [],
    sharedMode: 'owned',
    botCount: 2,
    hasSharedAutomation: true,
  };

  const channelSummary = {
    ...chatSummary,
    id: 'channel-1',
    title: 'Канал MAX',
    entityType: 'channel',
    link: 'https://max.ru/channel-1',
  };

  const idleRefresh = {
    complete: false,
    cursor: null,
    backoffActive: false,
    nextPollAfterMs: 1500,
    processedCandidates: 0,
    totalCandidates: null,
    progressPercent: null,
    lastSyncedAt: null,
    manualRefreshBlockedReason: null,
    manualRefreshRetryAfterMs: null,
  };

  it('lists chats through managed-entities ports instead of legacy listChats', async () => {
    const { legacyAdminService, prisma, service } = createService();
    legacyAdminService.listManagedEntitiesDetailedForManagedEntities.mockResolvedValueOnce({
      items: [chatSummary],
      refresh: null,
    });
    prisma.managedEntityFavorite.findMany.mockResolvedValueOnce([
      {
        chatId: 'chat-1',
        entityType: 'CHAT',
        favoriteType: 'WATCH',
      },
    ]);

    await expect(service.listChats(user as never, { fresh: true })).resolves.toEqual([
      {
        ...publicChatSummary,
        favoriteTypes: ['watch'],
      },
    ]);

    expect(legacyAdminService.listChats).not.toHaveBeenCalled();
    expect(legacyAdminService.listManagedEntitiesDetailedForManagedEntities).toHaveBeenCalledWith(
      user,
      'chat',
      { fresh: true },
    );
    expect(legacyAdminService.attachManagedEntityFavoriteTypesForManagedEntities).not.toHaveBeenCalled();
    expect(prisma.managedEntityFavorite.findMany).toHaveBeenCalledWith({
      where: {
        userId: 'admin-1',
        chatId: {
          in: ['chat-1'],
        },
      },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      select: {
        chatId: true,
        entityType: true,
        favoriteType: true,
      },
    });
  });

  it('lists channels through managed-entities ports instead of legacy listChannels', async () => {
    const { legacyAdminService, prisma, service } = createService();
    legacyAdminService.listManagedEntitiesDetailedForManagedEntities.mockResolvedValueOnce({
      items: [channelSummary],
      refresh: null,
    });

    await expect(service.listChannels(user as never)).resolves.toEqual([
      {
        ...channelSummary,
        primaryBotId: null,
        assignedBots: [],
        sharedMode: 'owned',
        botCount: 2,
        hasSharedAutomation: true,
      },
    ]);

    expect(legacyAdminService.listChannels).not.toHaveBeenCalled();
    expect(legacyAdminService.listManagedEntitiesDetailedForManagedEntities).toHaveBeenCalledWith(
      user,
      'channel',
      {},
    );
    expect(legacyAdminService.attachManagedEntityFavoriteTypesForManagedEntities).not.toHaveBeenCalled();
    expect(prisma.managedEntityFavorite.findMany).toHaveBeenCalledTimes(1);
  });

  it('builds refresh-state chat responses without calling legacy listChatsWithRefreshState', async () => {
    const { legacyAdminService, prisma, service } = createService();
    legacyAdminService.listManagedEntitiesDetailedForManagedEntities.mockResolvedValueOnce({
      items: [chatSummary],
      refresh: {
        ...idleRefresh,
        cursor: 1,
        processedCandidates: 1,
        totalCandidates: 3,
        progressPercent: 33,
        manualRefreshBlockedReason: 'in_progress',
        manualRefreshRetryAfterMs: 1500,
        userVisibleComplete: false,
      },
      snapshot: {
        version: 'snapshot-v1',
        builtAt: '2026-05-27T10:00:00.000Z',
        lastSyncedAt: null,
        source: 'published_snapshot',
        stale: false,
      },
      diff: {
        mode: 'patch',
        baseVersion: 'snapshot-v1',
        nextVersion: 'snapshot-v2',
        added: [chatSummary],
        updated: [],
        removedIds: [],
        orderedIds: ['chat-1'],
      },
    });
    prisma.managedEntityFavorite.findMany
      .mockResolvedValueOnce([
        {
          chatId: 'chat-1',
          entityType: 'CHAT',
          favoriteType: 'BROADCAST',
        },
      ])
      .mockResolvedValueOnce([
        {
          chatId: 'chat-1',
          entityType: 'CHAT',
          favoriteType: 'WATCH',
        },
      ]);

    await expect(
      service.listChatsWithRefreshState(user as never, { sinceVersion: 'snapshot-v1' }),
    ).resolves.toEqual({
      items: [
        {
          ...chatSummary,
          primaryBotId: null,
          assignedBots: [],
          sharedMode: 'owned',
          botCount: 2,
          hasSharedAutomation: true,
          favoriteTypes: ['broadcast'],
        },
      ],
      refresh: expect.objectContaining({
        cursor: 1,
        userVisibleComplete: true,
      }),
      snapshot: {
        version: 'snapshot-v1',
        builtAt: '2026-05-27T10:00:00.000Z',
        lastSyncedAt: null,
        source: 'published_snapshot',
        stale: false,
      },
      diff: {
        mode: 'patch',
        baseVersion: 'snapshot-v1',
        nextVersion: 'snapshot-v2',
        added: [
          {
            ...chatSummary,
            primaryBotId: null,
            assignedBots: [],
            sharedMode: 'owned',
            botCount: 2,
            hasSharedAutomation: true,
            favoriteTypes: ['watch'],
          },
        ],
        updated: [],
        removedIds: [],
        orderedIds: ['chat-1'],
      },
    });

    expect(legacyAdminService.listChatsWithRefreshState).not.toHaveBeenCalled();
    expect(legacyAdminService.listManagedEntitiesDetailedForManagedEntities).toHaveBeenCalledWith(
      user,
      'chat',
      {
        sinceVersion: 'snapshot-v1',
        includeRefreshState: true,
      },
    );
    expect(
      legacyAdminService.attachManagedEntityFavoriteTypesForManagedEntities,
    ).not.toHaveBeenCalled();
    expect(
      legacyAdminService.attachManagedEntityFavoriteTypesToDiffForManagedEntities,
    ).not.toHaveBeenCalled();
    expect(prisma.managedEntityFavorite.findMany).toHaveBeenCalledTimes(2);
    expect(
      legacyAdminService.createIdleManagedEntitiesRefreshStateForManagedEntities,
    ).not.toHaveBeenCalled();
  });

  it('uses the idle refresh fallback for empty channel refresh responses', async () => {
    const { legacyAdminService, service } = createService();
    legacyAdminService.listManagedEntitiesDetailedForManagedEntities.mockResolvedValueOnce({
      items: [],
      refresh: null,
      diff: null,
    });
    legacyAdminService.createIdleManagedEntitiesRefreshStateForManagedEntities.mockReturnValueOnce(
      idleRefresh,
    );

    await expect(service.listChannelsWithRefreshState(user as never)).resolves.toEqual({
      items: [],
      refresh: {
        ...idleRefresh,
        userVisibleComplete: false,
      },
    });

    expect(legacyAdminService.listChannelsWithRefreshState).not.toHaveBeenCalled();
    expect(
      legacyAdminService.createIdleManagedEntitiesRefreshStateForManagedEntities,
    ).toHaveBeenCalledTimes(1);
    expect(
      legacyAdminService.attachManagedEntityFavoriteTypesToDiffForManagedEntities,
    ).not.toHaveBeenCalled();
  });
});

describe('ManagedEntitiesService refresh jobs', () => {
  it('runs refresh jobs through the managed-entities boundary instead of legacy job wrapper', async () => {
    const { legacyAdminService, service } = createService();

    await expect(
      service.processManagedEntitiesRefreshJob({
        userId: 'admin-1',
        entityType: 'channel',
        bypassRemoteCache: true,
        resetRefreshCursor: false,
      }),
    ).resolves.toEqual({ continueAfterMs: 5_000 });

    expect(legacyAdminService.processManagedEntitiesRefreshJob).not.toHaveBeenCalled();
    expect(
      legacyAdminService.runManagedEntitiesBoundedRefreshForManagedEntities,
    ).toHaveBeenCalledWith(
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      'channel',
      {
        bypassRemoteCache: true,
        resetRefreshCursor: false,
      },
    );
    expect(
      legacyAdminService.runManagedEntitiesRemoteFullRefreshForManagedEntities,
    ).not.toHaveBeenCalled();
  });
});

describe('ManagedEntitiesService onboarding diagnostics', () => {
  it('returns bounded local diagnostics without remote discovery', async () => {
    const { maxClient, prisma, service } = createService();
    prisma.managedEntityAccessEdge.findFirst = jest.fn().mockResolvedValue({ chatId: '-100' });
    prisma.managedEntityLocalActivity.findMany.mockResolvedValueOnce([
      {
        chatId: '-100',
        chatTitle: 'Команда MAX',
        sourceEventType: 'handshake_start',
        lastEventAt: new Date('2026-06-20T12:00:00.000Z'),
      },
    ]);
    prisma.managedEntityAccessEdge.findMany.mockResolvedValueOnce([
      {
        chatId: '-100',
        state: 'GRANTED',
        checkedAt: new Date('2026-06-20T12:01:00.000Z'),
      },
    ]);
    prisma.managedEntityHandshakeOutcome.findFirst.mockResolvedValueOnce({
      chatId: '-100',
      title: 'Команда MAX',
      status: 'CONNECTED',
      reason: null,
      happenedAt: new Date('2026-06-20T12:02:00.000Z'),
    });

    await expect(service.getOnboardingDiagnostics('chat', user as never)).resolves.toEqual({
      entityType: 'chat',
      hasVisibleEntities: true,
      recentSignals: [
        {
          type: 'access_edge',
          chatId: '-100',
          title: null,
          status: 'granted',
          at: '2026-06-20T12:01:00.000Z',
        },
        {
          type: 'recent_activity',
          chatId: '-100',
          title: 'Команда MAX',
          status: 'handshake_start',
          at: '2026-06-20T12:00:00.000Z',
        },
      ],
      lastHandshake: {
        chatId: '-100',
        title: 'Команда MAX',
        status: 'connected',
        reason: null,
        happenedAt: '2026-06-20T12:02:00.000Z',
      },
    });
    expect(maxClient.getChatSnapshot).not.toHaveBeenCalled();
  });
});

describe('ManagedEntitiesService headers', () => {
  it('loads chat header without routing through legacy getChatHeader', async () => {
    const { chatContextCache, legacyAdminService, maxClient, prisma, service } = createService();

    const result = await service.getChatHeader('chat-1', user as never);

    expect(result).toEqual({
      id: 'chat-1',
      title: 'Живой чат',
      entityType: 'chat',
      link: 'https://max.ru/chat-1',
      participantsCount: 12,
      avatarUrl: 'https://cdn.max/chat-1.png',
      primaryBotId: null,
      assignedBots: [],
      sharedMode: 'owned',
      accessDiagnostics: {
        state: 'ok',
        lastDetectedAt: null,
        lastCheckedAt: null,
        freshUntil: null,
        source: 'unknown',
        activeBotCount: 0,
        lostBots: [],
      },
      viewerAccess: {
        state: 'checking',
        reason: null,
        checkedAt: null,
        canEdit: false,
      },
    });
    expect(legacyAdminService.assertManagedEntityReadAccess).toHaveBeenCalledWith(
      'chat-1',
      'admin-1',
      'chat',
      {},
    );
    expect(legacyAdminService.getChatHeader).not.toHaveBeenCalled();
    expect(legacyAdminService.resolveManagedEntityHeaderReadBotId).toHaveBeenCalledWith('chat-1');
    expect(maxClient.getChatSnapshot).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({
        botId: 'bot-1',
        trafficClass: 'interactive',
        actionHealthLane: 'background',
        ignoreFailureMetricStatuses: [403, 404],
      }),
    );
    expect(prisma.chat.update).toHaveBeenCalledWith({
      where: { id: 'chat-1' },
      data: { title: 'Живой чат' },
    });
    expect(
      legacyAdminService.attachManagedEntityHeaderBotAssignmentsForManagedEntities,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'chat-1',
        title: 'Живой чат',
      }),
    );
    expect(chatContextCache.setManagedEntityHeader).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'chat-1',
        primaryBotId: 'bot-1',
      }),
    );
  });

  it('returns fresh cached channel header without routing through legacy getChannelHeader', async () => {
    const cachedHeader = {
      id: 'channel-1',
      title: 'Канал MAX',
      entityType: 'channel',
      link: 'https://max.ru/channel-1',
      participantsCount: 120,
      avatarUrl: 'https://cdn.max/channel-1.png',
      primaryBotId: 'bot-1',
      assignedBots: [
        {
          botId: 'bot-1',
          label: 'Primary Bot',
          role: 'primary',
          membershipStatus: 'active',
          lifecycleState: 'active',
          speechPersona: 'male',
          characterName: null,
          avatarUrl: null,
          capabilities: [],
          permissionsSummary: null,
        },
      ],
      sharedMode: 'owned',
    };
    const { chatContextCache, legacyAdminService, maxClient, service } = createService();
    chatContextCache.getManagedEntityHeader.mockResolvedValueOnce(cachedHeader);

    await expect(service.getChannelHeader('channel-1', user as never)).resolves.toEqual({
      ...cachedHeader,
      primaryBotId: null,
      assignedBots: [],
      botCount: 1,
      accessDiagnostics: {
        state: 'ok',
        lastDetectedAt: null,
        lastCheckedAt: null,
        freshUntil: null,
        source: 'unknown',
        activeBotCount: 0,
        lostBots: [],
      },
      viewerAccess: {
        state: 'checking',
        reason: null,
        checkedAt: null,
        canEdit: false,
      },
    });

    expect(legacyAdminService.assertManagedEntityReadAccess).toHaveBeenCalledWith(
      'channel-1',
      'admin-1',
      'channel',
      {},
    );
    expect(legacyAdminService.getChannelHeader).not.toHaveBeenCalled();
    expect(maxClient.getChatSnapshot).not.toHaveBeenCalled();
    expect(chatContextCache.setManagedEntityHeader).not.toHaveBeenCalled();
  });

  it('attaches terminal access-loss diagnostics to managed entity headers', async () => {
    const { prisma, service } = createService();
    prisma.chatBotMembership.findMany.mockResolvedValueOnce([
      {
        botId: 'bot-1',
        status: 'REMOVED',
        updatedAt: new Date('2026-05-31T10:00:00.000Z'),
        permissionsSnapshot: {
          accessLostReason: 'bot_denied',
          accessLostSource: 'night_mode_transition:open',
          accessLostAt: '2026-05-31T09:59:00.000Z',
          lastMaxErrorCode: 'chat.denied',
          lastMaxErrorMessage: 'Forbidden',
          lastMaxStatusCode: 403,
        },
      },
    ]);

    const result = await service.getChatHeader('chat-1', user as never);

    expect(result.accessDiagnostics).toEqual({
      state: 'bot_access_lost',
      lastDetectedAt: '2026-05-31T09:59:00.000Z',
      lastCheckedAt: null,
      freshUntil: null,
      source: 'unknown',
      activeBotCount: 0,
      lostBots: [
        {
          reason: 'bot_denied',
          detectedAt: '2026-05-31T09:59:00.000Z',
        },
      ],
    });
  });

  it('suppresses access-loss diagnostics when another runtime bot has confirmed access', async () => {
    const { prisma, service } = createService();
    prisma.chatBotMembership.findMany
      .mockResolvedValueOnce([
        {
          botId: 'bot-1',
          status: 'REMOVED',
          updatedAt: new Date('2026-05-31T10:00:00.000Z'),
          permissionsSnapshot: {
            accessLostReason: 'bot_denied',
            accessLostSource: 'night_mode_transition:open',
            accessLostAt: '2026-05-31T09:59:00.000Z',
            lastMaxErrorCode: 'chat.denied',
            lastMaxErrorMessage: 'Forbidden',
            lastMaxStatusCode: 403,
          },
        },
        {
          botId: 'bot-2',
          status: 'ACTIVE',
          updatedAt: new Date('2026-05-31T10:02:00.000Z'),
          permissionsSnapshot: {
            isAdmin: true,
            isOwner: false,
            permissions: [],
          },
        },
      ])
      .mockResolvedValueOnce([
        {
          botId: 'bot-2',
          updatedAt: new Date('2026-05-31T10:02:00.000Z'),
          permissionsSnapshot: {
            isAdmin: true,
            isOwner: false,
            permissions: [],
          },
        },
      ]);
    prisma.managedEntityAccessEdge.findMany
      .mockResolvedValueOnce([
        {
          botId: 'bot-1',
          checkedAt: new Date('2026-05-31T09:59:00.000Z'),
          deniedReason: 'bot_denied',
          source: 'managed_broadcast:delivery',
          lastMaxErrorCode: 'chat.denied',
          lastMaxErrorMessage: 'Forbidden',
          lastMaxStatusCode: 403,
        },
      ])
      .mockResolvedValueOnce([]);

    const result = await service.getChatHeader('chat-1', user as never);

    expect(result.accessDiagnostics).toEqual({
      state: 'checking',
      lastDetectedAt: null,
      lastCheckedAt: null,
      freshUntil: null,
      source: 'unknown',
      activeBotCount: 1,
      lostBots: [],
    });
  });

  it('surfaces active denied bot access snapshots as bot access loss diagnostics', async () => {
    const { prisma, service } = createService();
    prisma.chatBotMembership.findMany.mockResolvedValueOnce([
      {
        botId: 'bot-1',
        status: 'ACTIVE',
        updatedAt: new Date('2026-06-01T10:00:01.000Z'),
        permissionsSnapshot: {
          checkedAt: '2026-06-01T10:00:00.000Z',
          isAdmin: false,
          isOwner: false,
          permissions: [],
        },
        botAccessState: 'DENIED',
        botAccessCheckedAt: new Date('2026-06-01T10:00:00.000Z'),
        botAccessExpiresAt: new Date('2026-06-01T10:05:00.000Z'),
        botAccessSource: 'admin_roster_sync',
        botAccessLastErrorCode: 'chat.denied',
      },
    ]);

    const result = await service.getChatHeader('chat-1', user as never);

    expect(result.accessDiagnostics).toEqual({
      state: 'bot_access_lost',
      lastDetectedAt: '2026-06-01T10:00:00.000Z',
      lastCheckedAt: null,
      freshUntil: null,
      source: 'unknown',
      activeBotCount: 1,
      lostBots: [
        {
          reason: 'bot_denied',
          detectedAt: '2026-06-01T10:00:00.000Z',
        },
      ],
    });
  });

  it('lets a fresh granted edge win over a fresher denied edge from another bot', async () => {
    const { prisma, service } = createService();
    prisma.managedEntityAccessEdge.findFirst
      .mockResolvedValueOnce({
        checkedAt: new Date('2026-06-01T10:00:00.000Z'),
      })
      .mockResolvedValueOnce(null);

    const result = await service.getChatHeader('chat-1', user as never);

    expect(result.viewerAccess).toEqual({
      state: 'granted',
      reason: null,
      checkedAt: '2026-06-01T10:00:00.000Z',
      canEdit: true,
    });
    expect(prisma.managedEntityAccessEdge.findFirst).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          state: 'GRANTED',
        }),
      }),
    );
  });
});

describe('ManagedEntitiesService bot execution plan', () => {
  it('loads chat bot plans through the managed entities boundary', async () => {
    const { legacyAdminService, maxBotExecutionPlanner, service } = createService();

    await service.getChatBotExecutionPlan('chat-1', user as never, { refresh: true });

    expect(legacyAdminService.assertManagedEntityAdminAccess).toHaveBeenCalledWith(
      'chat-1',
      'admin-1',
      'chat',
    );
    expect(maxBotExecutionPlanner?.getManagedEntityExecutionPlan).toHaveBeenCalledWith({
      chatId: 'chat-1',
      entityType: 'chat',
      refreshCapabilities: true,
    });
  });

  it('keeps raw bot plans behind system access in production mode', async () => {
    const { legacyAdminService, maxBotExecutionPlanner, service } = createService({
      config: { systemAdminUserIds: 'system-admin' },
    });

    await expect(service.getChatBotExecutionPlan('chat-1', user as never)).rejects.toThrow(
      ForbiddenException,
    );
    expect(legacyAdminService.assertManagedEntityAdminAccess).not.toHaveBeenCalled();
    expect(maxBotExecutionPlanner?.getManagedEntityExecutionPlan).not.toHaveBeenCalled();
  });

  it('allows system admins to inspect raw bot plans in production mode', async () => {
    const { legacyAdminService, maxBotExecutionPlanner, service } = createService({
      config: { systemAdminUserIds: 'admin-1' },
    });

    await service.getChatBotExecutionPlan('chat-1', user as never, { refresh: true });

    expect(legacyAdminService.assertManagedEntityAdminAccess).toHaveBeenCalledWith(
      'chat-1',
      'admin-1',
      'chat',
    );
    expect(maxBotExecutionPlanner?.getManagedEntityExecutionPlan).toHaveBeenCalledWith({
      chatId: 'chat-1',
      entityType: 'chat',
      refreshCapabilities: true,
    });
  });

  it('updates primary bot and invalidates the managed entity header', async () => {
    const { chatContextCache, legacyAdminService, maxBotExecutionPlanner, service } =
      createService();

    await service.updateChannelPrimaryBot('chat-1', user as never, { botId: 'bot-2' });

    expect(legacyAdminService.assertManagedEntityAdminAccess).toHaveBeenCalledWith(
      'chat-1',
      'admin-1',
      'channel',
    );
    expect(maxBotExecutionPlanner?.setPrimaryBot).toHaveBeenCalledWith({
      chatId: 'chat-1',
      entityType: 'channel',
      botId: 'bot-2',
    });
    expect(chatContextCache.invalidateManagedEntityHeader).toHaveBeenCalledWith('chat-1');
  });

  it('keeps the legacy service out of bot-plan orchestration when planner is unavailable', async () => {
    const { legacyAdminService, service } = createService({
      maxBotExecutionPlanner: null,
    });

    await expect(service.getChatBotExecutionPlan('chat-1', user as never)).rejects.toThrow(
      ServiceUnavailableException,
    );
    expect(legacyAdminService.assertManagedEntityAdminAccess).toHaveBeenCalledWith(
      'chat-1',
      'admin-1',
      'chat',
    );
  });

  it('updates favorites through the managed entities domain service', async () => {
    const { legacyAdminService, prisma, service } = createService();

    const result = await service.updateManagedEntityFavorites(
      'channel',
      'chat-1',
      user as never,
      {
        favoriteTypes: ['watch', 'watch', 'broadcast'],
      },
    );

    expect(result).toEqual({
      entityType: 'channel',
      entityId: 'chat-1',
      favoriteTypes: ['watch', 'broadcast'],
    });
    expect(legacyAdminService.assertManagedEntityAdminAccess).toHaveBeenCalledWith(
      'chat-1',
      'admin-1',
      'channel',
    );
    expect(legacyAdminService.updateManagedEntityFavorites).not.toHaveBeenCalled();
    expect(prisma.managedEntityFavorite.deleteMany).toHaveBeenCalledWith({
      where: {
        userId: 'admin-1',
        chatId: 'chat-1',
        entityType: 'CHANNEL',
        favoriteType: {
          notIn: ['WATCH', 'BROADCAST'],
        },
      },
    });
    expect(prisma.managedEntityFavorite.upsert).toHaveBeenCalledTimes(2);
    expect(prisma.managedEntityFavorite.upsert).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        create: expect.objectContaining({
          favoriteType: 'WATCH',
          position: 0,
        }),
        update: {
          position: 0,
        },
      }),
    );
    expect(prisma.managedEntityFavorite.upsert).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        create: expect.objectContaining({
          favoriteType: 'BROADCAST',
          position: 1,
        }),
        update: {
          position: 1,
        },
      }),
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        chatId: 'chat-1',
        actorUserId: 'admin-1',
        action: 'UPDATE_MANAGED_ENTITY_FAVORITES',
        payload: {
          entityType: 'channel',
          favoriteTypes: ['watch', 'broadcast'],
        },
      },
    });
    expect(prisma.$transaction.mock.calls[0][0]).toHaveLength(4);
  });

  it('schedules a roster access recheck when persisted admins need diagnostics recovery', async () => {
    const { legacyAdminService, maxChatAdminRosterSyncService, prisma, service } = createService();
    legacyAdminService.assertManagedEntityAdminAccess.mockRejectedValueOnce(new Error('lost'));
    prisma.managedEntityAdminMember.findFirst.mockResolvedValueOnce({ chatId: 'chat-1' });
    prisma.managedEntityAccessEdge.findMany.mockImplementation((args: unknown) => {
      const state = (args as { where?: { state?: unknown } })?.where?.state;
      if (state === 'BOT_DENIED') {
        return Promise.resolve([
          {
            botId: 'bot-1',
            checkedAt: new Date('2026-05-31T09:59:00.000Z'),
            deniedReason: 'bot_denied',
            source: 'managed_broadcast:delivery',
            lastMaxErrorCode: 'chat.denied',
            lastMaxErrorMessage: 'Forbidden',
            lastMaxStatusCode: 403,
          },
        ]);
      }
      return Promise.resolve([]);
    });

    await expect(
      service.recheckManagedEntityAccess('chat', 'chat-1', user as never),
    ).resolves.toEqual(
      expect.objectContaining({
        entityType: 'chat',
        entityId: 'chat-1',
        scheduled: true,
        diagnostics: expect.objectContaining({
          state: 'bot_access_lost',
        }),
      }),
    );
    expect(maxChatAdminRosterSyncService?.scheduleChatAdminRosterSync).toHaveBeenCalledWith({
      chatId: 'chat-1',
      entityType: 'chat',
      source: 'admin_access_validation',
      retryUntilMs: null,
    });
  });
});
