import { AdminService } from './admin.service';

function createPrismaMock() {
  return {
    chat: {
      upsert: jest.fn().mockResolvedValue({
        id: 'chat-1',
        title: 'Команда MAX',
        createdAt: new Date('2026-03-01T00:00:00.000Z'),
      }),
      update: jest.fn().mockResolvedValue(undefined),
      findUnique: jest.fn().mockResolvedValue({
        id: 'chat-1',
        title: 'Команда MAX',
      }),
    },
    channelSettings: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    chatSettings: {
      update: jest.fn().mockResolvedValue(undefined),
    },
    chatAdminAllowlist: {
      upsert: jest.fn().mockResolvedValue(undefined),
      findMany: jest.fn().mockResolvedValue([]),
    },
    domainAllowlist: {
      findMany: jest.fn().mockResolvedValue([]),
      upsert: jest.fn().mockResolvedValue(undefined),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    auditLog: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue(undefined),
    },
    channelAudienceSnapshot: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue(undefined),
    },
    channelPost: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({ id: 'post-1' }),
    },
    channelPostViewSnapshot: {
      create: jest.fn().mockResolvedValue(undefined),
    },
    chatRules: {
      upsert: jest.fn().mockResolvedValue({
        id: 'rules-1',
        chatId: 'chat-1',
        text: '',
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        publishedMessageId: null,
        publishedUrl: null,
        publishedAt: null,
        createdAt: new Date('2026-03-01T00:00:00.000Z'),
        updatedAt: new Date('2026-03-01T00:00:00.000Z'),
      }),
      findUnique: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue(undefined),
    },
    channelStatsSyncState: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue(undefined),
    },
    moderationEvent: {
      count: jest.fn(),
      findMany: jest.fn(),
    },
    $queryRaw: jest.fn(),
    $transaction: jest.fn((items: unknown[]) => Promise.all(items as Promise<unknown>[])),
  };
}

function extractSqlText(arg: unknown): string {
  if (Array.isArray(arg)) {
    return arg.map((part) => String(part)).join(' ');
  }

  if (arg && typeof arg === 'object' && 'strings' in arg) {
    const strings = (arg as { strings?: unknown }).strings;
    if (Array.isArray(strings)) {
      return strings.map((part) => String(part)).join(' ');
    }
  }

  return String(arg);
}

function createConfigMock() {
  return {
    getOrThrow: jest.fn((key: string) => {
      if (key === 'MAX_BOT_TOKEN') {
        return 'test-max-bot-token';
      }
      throw new Error(`Missing key: ${key}`);
    }),
    get: jest.fn((key: string) => {
      if (key === 'APP_BASE_URL') {
        return 'https://maxim.play-team.ru';
      }
      if (key === 'MAX_BOT_ID') {
        return '777000_bot';
      }
      if (key === 'MAX_BOT_CONTACT_ID') {
        return '777000';
      }
      return null;
    }),
  };
}

function decodeBase64UrlJson<T>(value: string): T {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as T;
}

describe('AdminService night mode settings normalization', () => {
  it('forces night bot message toggles off when night mode is disabled on update', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };
    const chatContextCache = {
      invalidate: jest.fn().mockResolvedValue(undefined),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const result = await service.updateSettings(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        nightModeEnabled: false,
        nightModeBotMessageEnabled: true,
        nightModeBotButtonEnabled: true,
        nightModeBotButtonUrl: 'https://max.ru/channel/rules',
        nightModeBotButtonText: 'Правила',
        nightModeRulesButtonEnabled: true,
      },
    );

    expect(result.nightModeEnabled).toBe(false);
    expect(result.nightModeBotMessageEnabled).toBe(false);
    expect(result.nightModeBotButtonEnabled).toBe(false);
    expect(result.nightModeRulesButtonEnabled).toBe(false);
    expect(prisma.chat.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: {
          settings: {
            upsert: {
              update: expect.objectContaining({
                nightModeEnabled: false,
                nightModeBotMessageEnabled: false,
                nightModeBotButtonEnabled: false,
                nightModeRulesButtonEnabled: false,
              }),
              create: expect.objectContaining({
                nightModeEnabled: false,
                nightModeBotMessageEnabled: false,
                nightModeBotButtonEnabled: false,
                nightModeRulesButtonEnabled: false,
              }),
            },
          },
        },
      }),
    );
  });

  it('normalizes stale night bot message toggles from stored settings', async () => {
    const prisma = createPrismaMock();
    prisma.chat.upsert.mockResolvedValue({
      id: 'chat-1',
      title: 'Команда MAX',
      createdAt: new Date('2026-03-01T00:00:00.000Z'),
      settings: {
        nightModeEnabled: false,
        nightModeBotMessageEnabled: true,
        nightModeBotButtonEnabled: true,
        nightModeBotButtonUrl: 'https://max.ru/channel/rules',
        nightModeBotButtonText: 'Правила',
        nightModeRulesButtonEnabled: true,
      },
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };
    const chatContextCache = {
      invalidate: jest.fn().mockResolvedValue(undefined),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const result = await service.getSettings('chat-1', {
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatTitle: null,
    });

    expect(result.nightModeEnabled).toBe(false);
    expect(result.nightModeBotMessageEnabled).toBe(false);
    expect(result.nightModeBotButtonEnabled).toBe(false);
    expect(result.nightModeRulesButtonEnabled).toBe(false);
    expect(prisma.chatSettings.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { chatId: 'chat-1' },
        data: {
          nightModeBotMessageEnabled: false,
          nightModeBotButtonEnabled: false,
          nightModeRulesButtonEnabled: false,
        },
      }),
    );
  });
});

describe('AdminService.getLogsDashboard', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns membership and violations summary for selected chat', async () => {
    const prisma = createPrismaMock();
    prisma.$queryRaw
      .mockResolvedValueOnce([{ joined_users: '5', left_users: '2' }])
      .mockResolvedValueOnce([
        { user_id: 'user-1', sender_name: 'Алексей' },
        { user_id: 'user-2', sender_name: 'Мария' },
      ]);
    prisma.moderationEvent.count
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(4)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(2);
    prisma.moderationEvent.findMany.mockResolvedValue([
      {
        id: 'evt-1',
        action: 'WARN',
        ruleCode: 'PROFANITY',
        userId: 'user-1',
        createdAt: new Date('2026-03-02T09:00:00.000Z'),
        maskedExcerpt: '***',
        metadata: { reason: 'Profanity detected' },
      },
      {
        id: 'evt-2',
        action: 'BAN',
        ruleCode: 'LINK_BLOCKED',
        userId: 'user-2',
        createdAt: new Date('2026-03-02T08:00:00.000Z'),
        maskedExcerpt: null,
        metadata: null,
      },
    ]);

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const result = await service.getLogsDashboard(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      { range: '7d' },
    );

    expect(result.chat).toEqual({ id: 'chat-1', title: 'Команда MAX' });
    expect(result.membership).toEqual({ joinedUsers: 5, leftUsers: 2 });
    expect(result.violationsSummary).toEqual({
      warn: 3,
      deleteMessage: 4,
      kick: 1,
      ban: 2,
      total: 10,
    });
    expect(result.violations).toHaveLength(2);
    expect(result.violations[0]?.userDisplayName).toBe('Алексей');
    expect(result.violations[1]?.userDisplayName).toBe('Мария');

    const membershipSqlText = extractSqlText(prisma.$queryRaw.mock.calls[0]?.[0]);
    expect(membershipSqlText).toContain('user_added');
    expect(membershipSqlText).toContain('user_removed');
    expect(membershipSqlText).not.toContain('bot_added');

    expect(prisma.moderationEvent.count).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ chatId: 'chat-1' }) }),
    );
    expect(prisma.moderationEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ chatId: 'chat-1' }) }),
    );
  });

  it('uses 24h period boundaries when range=24h', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-02T12:00:00.000Z'));

    const prisma = createPrismaMock();
    prisma.$queryRaw.mockResolvedValue([{ joined_users: '0', left_users: '0' }]);
    prisma.moderationEvent.count
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0);
    prisma.moderationEvent.findMany.mockResolvedValue([]);

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const result = await service.getLogsDashboard(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      { range: '24h' },
    );

    expect(result.period.range).toBe('24h');
    expect(result.period.from).toBe('2026-03-01T12:00:00.000Z');
    expect(result.period.to).toBe('2026-03-02T12:00:00.000Z');

    const countArgs = prisma.moderationEvent.count.mock.calls[0]?.[0];
    const createdAt = countArgs.where.createdAt;
    expect(createdAt.gte.toISOString()).toBe('2026-03-01T12:00:00.000Z');
    expect(createdAt.lte.toISOString()).toBe('2026-03-02T12:00:00.000Z');
  });
});

describe('AdminService.listChannels', () => {
  it('returns channel overview summary for each managed channel', async () => {
    const prisma = createPrismaMock();
    prisma.chat.upsert
      .mockResolvedValueOnce({
        id: 'channel-1',
        title: 'Новости MAX',
        createdAt: new Date('2026-03-02T10:00:00.000Z'),
        entityType: 'CHANNEL',
      })
      .mockResolvedValueOnce({
        id: 'channel-2',
        title: 'Обновления MAX',
        createdAt: new Date('2026-03-01T10:00:00.000Z'),
        entityType: 'CHANNEL',
      });
    prisma.channelSettings.findMany.mockResolvedValue([
      {
        chatId: 'channel-1',
        commentsEnabled: true,
        postSuggestionsEnabled: true,
        commentsModerationEnabled: true,
        commentsSlowModeSeconds: 45,
      },
    ]);

    const maxClient = {
      listBotChats: jest.fn().mockResolvedValue([
        {
          chatId: 'channel-1',
          title: 'Новости MAX',
          lastEventTime: 200,
          entityType: 'channel',
          link: 'https://max.ru/news',
        },
        {
          chatId: 'channel-2',
          title: 'Обновления MAX',
          lastEventTime: 100,
          entityType: 'channel',
          link: null,
        },
      ]),
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const result = await service.listChannels({
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatTitle: null,
    });

    expect(result).toEqual([
      {
        id: 'channel-1',
        title: 'Новости MAX',
        createdAt: '2026-03-02T10:00:00.000Z',
        entityType: 'channel',
        link: 'https://max.ru/news',
        channelOverview: {
          enabledScenariosCount: 2,
          commentsEnabled: true,
          postSuggestionsEnabled: true,
          commentsModerationEnabled: true,
          commentsSlowModeSeconds: 45,
        },
      },
      {
        id: 'channel-2',
        title: 'Обновления MAX',
        createdAt: '2026-03-01T10:00:00.000Z',
        entityType: 'channel',
        link: null,
        channelOverview: {
          enabledScenariosCount: 1,
          commentsEnabled: true,
          postSuggestionsEnabled: false,
          commentsModerationEnabled: false,
          commentsSlowModeSeconds: 0,
        },
      },
    ]);
    expect(prisma.channelSettings.findMany).toHaveBeenCalledWith({
      where: {
        chatId: {
          in: ['channel-1', 'channel-2'],
        },
      },
      select: {
        chatId: true,
        commentsEnabled: true,
        postSuggestionsEnabled: true,
        commentsModerationEnabled: true,
        commentsSlowModeSeconds: true,
      },
    });
  });
});

describe('AdminService.getChannelStats', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns official-first channel stats without reading channel settings', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-07T12:00:00.000Z'));

    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      entityType: 'CHANNEL',
    });
    prisma.$queryRaw
      .mockResolvedValueOnce([
        {
          posts_with_buttons: '2',
          comments: '4',
          suggestions: '3',
          comment_authors: '2',
          suggestion_authors: '2',
          suggestions_delivered: '2',
          suggestions_failed: '1',
          last_bot_activity_at: new Date('2026-03-07T11:25:00.000Z'),
        },
      ])
      .mockResolvedValueOnce([
        { created_at: new Date('2026-03-03T09:00:00.000Z'), event_type: 'user_added' },
        { created_at: new Date('2026-03-04T09:00:00.000Z'), event_type: 'user_added' },
        { created_at: new Date('2026-03-05T09:00:00.000Z'), event_type: 'user_removed' },
      ]);
    prisma.channelAudienceSnapshot.findFirst
      .mockResolvedValueOnce({
        chatId: 'channel-1',
        participantsCount: 1240,
        status: 'active',
        isPublic: true,
        link: 'https://max.ru/news',
        lastEventAt: new Date('2026-03-07T11:55:00.000Z'),
        capturedAt: new Date('2026-03-07T11:56:00.000Z'),
      })
      .mockResolvedValueOnce({
        capturedAt: new Date('2026-03-01T08:00:00.000Z'),
      })
      .mockResolvedValueOnce({
        participantsCount: 1210,
      });
    prisma.channelAudienceSnapshot.findMany.mockResolvedValue([
      {
        capturedAt: new Date('2026-03-03T10:00:00.000Z'),
        participantsCount: 1220,
      },
      {
        capturedAt: new Date('2026-03-06T10:00:00.000Z'),
        participantsCount: 1240,
      },
    ]);
    prisma.channelStatsSyncState.findUnique.mockResolvedValue({
      id: 'sync-1',
      chatId: 'channel-1',
      viewsCoverageFrom: new Date('2026-03-01T08:00:00.000Z'),
      membershipCoverageFrom: new Date('2026-02-28T08:00:00.000Z'),
      lastAudienceSyncAt: new Date('2026-03-07T11:56:00.000Z'),
      lastViewsSyncAt: new Date('2026-03-07T11:56:00.000Z'),
      lastOpportunisticSyncAt: null,
      createdAt: new Date('2026-02-28T08:00:00.000Z'),
      updatedAt: new Date('2026-03-07T11:56:00.000Z'),
    });
    prisma.channelPost.findMany.mockResolvedValue([
      {
        publishedAt: new Date('2026-03-03T07:00:00.000Z'),
        latestViews: 150,
        latestReactionsTotal: 5,
        latestReactions: [
          { emoji: '🔥', count: 3 },
          { emoji: '👍', count: 2 },
        ],
      },
      {
        publishedAt: new Date('2026-03-06T14:00:00.000Z'),
        latestViews: 260,
        latestReactionsTotal: 7,
        latestReactions: [
          { emoji: '🔥', count: 4 },
          { emoji: '❤️', count: 3 },
        ],
      },
    ]);
    prisma.channelPost.findFirst.mockResolvedValue({ id: 'post-1' });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getChatSnapshot: jest.fn(),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };
    const channelStatsCollector = {
      syncChannelIfStale: jest.fn().mockResolvedValue(undefined),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
      channelStatsCollector as never,
    );

    const result = await service.getChannelStats(
      'channel-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      { range: '7d' },
    );

    expect(result.channel).toEqual({
      id: 'channel-1',
      title: 'Новости MAX',
      participantsCount: 1240,
      status: 'active',
      isPublic: true,
      link: 'https://max.ru/news',
      lastEventAt: '2026-03-07T11:55:00.000Z',
    });
    expect(result.period).toEqual({
      range: '7d',
      from: '2026-02-28T12:00:00.000Z',
      to: '2026-03-07T12:00:00.000Z',
      bucket: 'day',
    });
    expect(result.official.audience).toEqual({
      joined: 2,
      left: 1,
      net: 1,
    });
    expect(result.official.content).toEqual({
      posts: 2,
      views: 410,
      reactions: 12,
      topReactions: [
        { emoji: '🔥', count: 7 },
        { emoji: '❤️', count: 3 },
        { emoji: '👍', count: 2 },
      ],
      lastPublishedAt: '2026-03-06T14:00:00.000Z',
    });
    expect(result.secondary).toEqual({
      postsWithButtons: 2,
      comments: 4,
      suggestions: 3,
      commentAuthors: 2,
      suggestionAuthors: 2,
      suggestionsDelivered: 2,
      suggestionsFailed: 1,
      lastBotActivityAt: '2026-03-07T11:25:00.000Z',
    });
    expect(result.meta).toEqual({
      maxSnapshotAvailable: true,
      viewsAvailable: true,
      churnAvailable: true,
      officialCoverageFrom: '2026-02-28T08:00:00.000Z',
      missingOfficialMetrics: ['reach', 'uniqueViews'],
    });
    expect(result.official.series.participants).toHaveLength(8);
    expect(result.official.series.membership).toHaveLength(8);
    expect(result.official.series.views).toHaveLength(8);
    expect(channelStatsCollector.syncChannelIfStale).toHaveBeenCalledWith('channel-1', {
      staleMs: 7200000,
      reason: 'stats_endpoint',
    });

    const statsSqlText = extractSqlText(prisma.$queryRaw.mock.calls[0]?.[0]);
    expect(statsSqlText).toContain('COUNT(DISTINCT CASE');
    expect(statsSqlText).toContain("payload->>'threadId'");
    expect(statsSqlText).toContain("payload->>'delivered' = 'true'");
    expect(statsSqlText).toContain("payload->>'delivered' = 'false'");
  });

  it.each([
    ['24h', '2026-03-06T12:00:00.000Z', 'hour'],
    ['30d', '2026-02-05T12:00:00.000Z', 'day'],
  ] as const)(
    'uses %s boundaries for official channel stats period',
    async (range, expectedFrom, expectedBucket) => {
      jest.useFakeTimers().setSystemTime(new Date('2026-03-07T12:00:00.000Z'));

      const prisma = createPrismaMock();
      prisma.chat.findUnique.mockResolvedValue({
        id: 'channel-1',
        title: 'Новости MAX',
        entityType: 'CHANNEL',
      });
      prisma.$queryRaw
        .mockResolvedValueOnce([
          {
            posts_with_buttons: '0',
            comments: '0',
            suggestions: '0',
            comment_authors: '0',
            suggestion_authors: '0',
            suggestions_delivered: '0',
            suggestions_failed: '0',
            last_bot_activity_at: null,
          },
        ])
        .mockResolvedValueOnce([]);
      prisma.channelAudienceSnapshot.findFirst
        .mockResolvedValueOnce({
          chatId: 'channel-1',
          participantsCount: 1240,
          status: 'active',
          isPublic: true,
          link: 'https://max.ru/news',
          lastEventAt: new Date('2026-03-07T11:55:00.000Z'),
          capturedAt: new Date('2026-03-07T11:56:00.000Z'),
        })
        .mockResolvedValueOnce({
          capturedAt: new Date('2026-03-01T08:00:00.000Z'),
        })
        .mockResolvedValueOnce({
          participantsCount: 1240,
        });
      prisma.channelStatsSyncState.findUnique.mockResolvedValue({
        id: 'sync-1',
        chatId: 'channel-1',
        viewsCoverageFrom: new Date('2026-03-01T08:00:00.000Z'),
        membershipCoverageFrom: new Date('2026-03-01T08:00:00.000Z'),
        lastAudienceSyncAt: new Date('2026-03-07T11:56:00.000Z'),
        lastViewsSyncAt: new Date('2026-03-07T11:56:00.000Z'),
        lastOpportunisticSyncAt: null,
        createdAt: new Date('2026-03-01T08:00:00.000Z'),
        updatedAt: new Date('2026-03-07T11:56:00.000Z'),
      });

      const maxClient = {
        getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
        getChatSnapshot: jest.fn(),
      };
      const chatContextCache = {
        invalidate: jest.fn(),
      };

      const service = new AdminService(
        prisma as never,
        maxClient as never,
        chatContextCache as never,
        createConfigMock() as never,
      );

      const result = await service.getChannelStats(
        'channel-1',
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        { range },
      );

      expect(result.period.range).toBe(range);
      expect(result.period.from).toBe(expectedFrom);
      expect(result.period.to).toBe('2026-03-07T12:00:00.000Z');
      expect(result.period.bucket).toBe(expectedBucket);
    },
  );

  it('returns partial official stats when cached MAX snapshot is missing and fallback request fails', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-07T12:00:00.000Z'));

    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      entityType: 'CHANNEL',
    });
    prisma.$queryRaw
      .mockResolvedValueOnce([
        {
          posts_with_buttons: '1',
          comments: '0',
          suggestions: '1',
          comment_authors: '0',
          suggestion_authors: '1',
          suggestions_delivered: '0',
          suggestions_failed: '1',
          last_bot_activity_at: new Date('2026-03-07T09:30:00.000Z'),
        },
      ])
      .mockResolvedValueOnce([
        { created_at: new Date('2026-03-07T09:30:00.000Z'), event_type: 'user_added' },
      ]);
    prisma.channelAudienceSnapshot.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    prisma.channelStatsSyncState.findUnique.mockResolvedValue({
      id: 'sync-1',
      chatId: 'channel-1',
      viewsCoverageFrom: new Date('2026-03-06T12:00:00.000Z'),
      membershipCoverageFrom: null,
      lastAudienceSyncAt: null,
      lastViewsSyncAt: new Date('2026-03-07T09:00:00.000Z'),
      lastOpportunisticSyncAt: null,
      createdAt: new Date('2026-03-06T12:00:00.000Z'),
      updatedAt: new Date('2026-03-07T09:00:00.000Z'),
    });
    prisma.channelPost.findMany.mockResolvedValue([
      {
        publishedAt: new Date('2026-03-07T09:00:00.000Z'),
        latestViews: 44,
        latestReactionsTotal: 0,
        latestReactions: null,
      },
    ]);
    prisma.channelPost.findFirst.mockResolvedValue({ id: 'post-1' });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getChatSnapshot: jest.fn().mockRejectedValue(new Error('MAX unavailable')),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const result = await service.getChannelStats(
      'channel-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      { range: '24h' },
    );

    expect(result.channel).toEqual({
      id: 'channel-1',
      title: 'Новости MAX',
      participantsCount: null,
      status: null,
      isPublic: null,
      link: null,
      lastEventAt: null,
    });
    expect(result.official.audience).toEqual({
      joined: 1,
      left: 0,
      net: 1,
    });
    expect(result.official.content).toEqual({
      posts: 1,
      views: 44,
      reactions: 0,
      topReactions: [],
      lastPublishedAt: '2026-03-07T09:00:00.000Z',
    });
    expect(result.secondary.suggestionsFailed).toBe(1);
    expect(result.secondary.lastBotActivityAt).toBe('2026-03-07T09:30:00.000Z');
    expect(result.meta.maxSnapshotAvailable).toBe(false);
    expect(result.meta.churnAvailable).toBe(false);
  });
});

describe('AdminService domain allowlist normalization', () => {
  it('returns deduplicated domain-only allowlist', async () => {
    const prisma = createPrismaMock();
    prisma.domainAllowlist.findMany.mockResolvedValue([
      { domain: 'max.ru/news', removeAfterAt: null },
      { domain: 'https://max.ru/another?x=1', removeAfterAt: null },
      { domain: 'example.org', removeAfterAt: null },
    ]);

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const result = await service.getDomainAllowlist('chat-1', {
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatTitle: null,
    });

    expect(result).toEqual(['example.org', 'max.ru']);
  });

  it('canonicalizes legacy domain rows with path when adding domain', async () => {
    const prisma = createPrismaMock();
    prisma.domainAllowlist.findMany.mockResolvedValueOnce([
      { domain: 'max.ru/old/path' },
      { domain: 'another.org' },
    ]);

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };
    const chatContextCache = {
      invalidate: jest.fn().mockResolvedValue(undefined),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await service.addDomain(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        domain: 'https://max.ru/new/path',
      },
    );

    expect(prisma.domainAllowlist.upsert).toHaveBeenCalledWith({
      where: {
        chatId_domain: {
          chatId: 'chat-1',
          domain: 'max.ru',
        },
      },
      create: {
        chatId: 'chat-1',
        domain: 'max.ru',
      },
      update: {
        removeAfterAt: null,
      },
    });
    expect(prisma.domainAllowlist.deleteMany).toHaveBeenCalledWith({
      where: {
        chatId: 'chat-1',
        domain: {
          in: ['max.ru/old/path'],
        },
      },
    });
  });

  it('removes canonical and legacy rows by normalized domain', async () => {
    const prisma = createPrismaMock();
    prisma.domainAllowlist.findMany.mockResolvedValue([
      { domain: 'https://max.ru/news' },
      { domain: 'max.ru' },
      { domain: 'example.org' },
    ]);

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };
    const chatContextCache = {
      invalidate: jest.fn().mockResolvedValue(undefined),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await service.removeDomain(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      'https://max.ru/another/path?x=1',
    );

    expect(prisma.domainAllowlist.deleteMany).toHaveBeenCalledWith({
      where: {
        chatId: 'chat-1',
        domain: {
          in: ['https://max.ru/news', 'max.ru'],
        },
      },
    });
  });
});

describe('AdminService.sendBroadcast', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('schedules image broadcast with delayed send', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-03T10:00:00.000Z'));

    const prisma = createPrismaMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      uploadImage: jest.fn().mockResolvedValue({ token: 'upload-token-1' }),
      sendMessage: jest.fn().mockResolvedValue(undefined),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const result = await service.sendBroadcast(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        text: '',
        applyToAllChats: false,
        buttonEnabled: false,
        buttonUrl: '',
        buttonText: 'Открыть',
        imageEnabled: true,
        imageBase64: Buffer.from('test-image').toString('base64'),
        imageMimeType: 'image/jpeg',
        imageFileName: 'photo.jpg',
        sendAt: '2026-03-03T11:00:00.000Z',
        cycleEnabled: false,
        cycleEveryDays: 1,
        cycleCount: 1,
      },
    );

    expect(maxClient.uploadImage).toHaveBeenCalledTimes(1);
    expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
    expect(maxClient.sendMessage).toHaveBeenCalledWith(
      'chat-1',
      ' ',
      { imagePayload: { token: 'upload-token-1' } },
      { delayMs: 3_600_000 },
    );
    expect(result.sendAt).toBe('2026-03-03T11:00:00.000Z');
    expect(result.sentChats).toBe(1);
    expect(result.failedChats).toBe(0);
  });
});

describe('AdminService chat rules', () => {
  it('returns persisted chat rules draft with published metadata', async () => {
    const prisma = createPrismaMock();
    prisma.chatRules.upsert.mockResolvedValue({
      id: 'rules-1',
      chatId: 'chat-1',
      text: 'Пишите по теме.',
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
      publishedMessageId: 'mid-rules-1',
      publishedUrl: 'https://max.ru/chats/chat-1/message/123',
      publishedAt: new Date('2026-03-09T10:00:00.000Z'),
      createdAt: new Date('2026-03-09T09:00:00.000Z'),
      updatedAt: new Date('2026-03-09T10:00:00.000Z'),
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const result = await service.getRules('chat-1', {
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatTitle: null,
    });

    expect(result).toEqual({
      text: 'Пишите по теме.',
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
      publishedMessageId: 'mid-rules-1',
      publishedUrl: 'https://max.ru/chats/chat-1/message/123',
      publishedAt: '2026-03-09T10:00:00.000Z',
    });
  });

  it('saves draft and publishes new rules post with persisted link', async () => {
    const prisma = createPrismaMock();
    prisma.chatRules.upsert
      .mockResolvedValueOnce({
        id: 'rules-1',
        chatId: 'chat-1',
        text: 'Опубликуйте только по теме.',
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        publishedMessageId: null,
        publishedUrl: null,
        publishedAt: null,
        createdAt: new Date('2026-03-09T09:00:00.000Z'),
        updatedAt: new Date('2026-03-09T09:00:00.000Z'),
      })
      .mockResolvedValueOnce({
        id: 'rules-1',
        chatId: 'chat-1',
        text: 'Опубликуйте только по теме.',
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        publishedMessageId: null,
        publishedUrl: null,
        publishedAt: null,
        createdAt: new Date('2026-03-09T09:00:00.000Z'),
        updatedAt: new Date('2026-03-09T09:05:00.000Z'),
      });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithResolvedLink: jest.fn().mockResolvedValue({
        messageId: 'mid-rules-2',
        url: 'https://max.ru/chats/chat-1/message/456',
      }),
      uploadImage: jest.fn(),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const savedDraft = await service.updateRules(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        text: 'Опубликуйте только по теме.',
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
      },
    );

    expect(savedDraft.text).toBe('Опубликуйте только по теме.');
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'chat-1',
        action: 'UPDATE_CHAT_RULES',
      }),
    });

    const published = await service.publishRules('chat-1', {
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatTitle: null,
    });

    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledWith(
      'chat-1',
      'Опубликуйте только по теме.',
      undefined,
    );
    expect(prisma.chatRules.update).toHaveBeenCalledWith({
      where: { chatId: 'chat-1' },
      data: expect.objectContaining({
        publishedMessageId: 'mid-rules-2',
        publishedUrl: 'https://max.ru/chats/chat-1/message/456',
        publishedAt: expect.any(Date),
      }),
    });
    expect(published).toEqual({
      chatId: 'chat-1',
      messageId: 'mid-rules-2',
      url: 'https://max.ru/chats/chat-1/message/456',
      publishedAt: expect.any(String),
    });
    expect(chatContextCache.invalidate).toHaveBeenCalledWith('chat-1');
  });

  it('publishes rules even when MAX does not return a direct post link', async () => {
    const prisma = createPrismaMock();
    prisma.chatRules.upsert.mockResolvedValue({
      id: 'rules-1',
      chatId: 'chat-1',
      text: 'Правила без прямой ссылки.',
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
      publishedMessageId: null,
      publishedUrl: null,
      publishedAt: null,
      createdAt: new Date('2026-03-09T09:00:00.000Z'),
      updatedAt: new Date('2026-03-09T09:05:00.000Z'),
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithResolvedLink: jest.fn().mockResolvedValue({
        messageId: 'mid-rules-3',
        url: null,
      }),
      uploadImage: jest.fn(),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const published = await service.publishRules('chat-1', {
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatTitle: null,
    });

    expect(prisma.chatRules.update).toHaveBeenCalledWith({
      where: { chatId: 'chat-1' },
      data: expect.objectContaining({
        publishedMessageId: 'mid-rules-3',
        publishedUrl: null,
        publishedAt: expect.any(Date),
      }),
    });
    expect(published).toEqual({
      chatId: 'chat-1',
      messageId: 'mid-rules-3',
      url: null,
      publishedAt: expect.any(String),
    });
  });
});

describe('AdminService.publishChannelEngagementMessage', () => {
  it('publishes channel buttons as MAX deep links with a dedicated post thread', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      entityType: 'CHANNEL',
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessage: jest.fn().mockResolvedValue(undefined),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await service.publishChannelEngagementMessage(
      'channel-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        text: 'Нажмите кнопку ниже.',
        commentsButtonText: 'Комментарии',
        suggestButtonText: 'Предложить пост',
      },
    );

    expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
    const [, , options, dispatchOptions] = maxClient.sendMessage.mock.calls[0] ?? [];
    const commentsButton = options.buttons?.[0]?.[0];
    const suggestButton = options.buttons?.[1]?.[0];

    expect(dispatchOptions).toEqual({ immediate: true });
    expect(options.buttons).toHaveLength(2);
    expect(options.buttons?.[0]).toHaveLength(1);
    expect(options.buttons?.[1]).toHaveLength(1);
    expect(commentsButton).toMatchObject({
      type: 'link',
      text: 'Комментарии',
    });
    expect(suggestButton).toMatchObject({
      type: 'link',
      text: 'Предложить пост',
    });
    expect(commentsButton.url).toContain('https://max.ru/777000_bot?startapp=');
    expect(suggestButton.url).toContain('https://max.ru/777000_bot?startapp=');

    const commentsUrl = new URL(commentsButton.url);
    const commentsStartParam = commentsUrl.searchParams.get('startapp');
    const suggestUrl = new URL(suggestButton.url);
    const suggestStartParam = suggestUrl.searchParams.get('startapp');

    expect(commentsStartParam).toMatch(/^cd-/u);
    expect(suggestStartParam).toMatch(/^cd-/u);

    const commentsLaunch = decodeBase64UrlJson<{ c: string; m: string; t: string }>(
      commentsStartParam!.slice(3),
    );
    const suggestLaunch = decodeBase64UrlJson<{ c: string; m: string; t: string }>(
      suggestStartParam!.slice(3),
    );
    const commentsToken = decodeBase64UrlJson<{ d: string; s: string }>(commentsLaunch.t.slice(4));
    const suggestToken = decodeBase64UrlJson<{ d: string; s: string }>(suggestLaunch.t.slice(4));

    expect(commentsLaunch).toMatchObject({
      c: 'channel-1',
      m: 'comments',
    });
    expect(suggestLaunch).toMatchObject({
      c: 'channel-1',
      m: 'suggest',
    });
    expect(commentsLaunch.t).toMatch(/^cdt-/u);
    expect(suggestLaunch.t).toMatch(/^cdt-/u);
    expect(commentsToken.d).toBe(suggestToken.d);
    expect(commentsToken.s).not.toBe(suggestToken.s);

    const publishAuditPayload = prisma.auditLog.create.mock.calls[0]?.[0]?.data?.payload as {
      threadId?: unknown;
    };
    expect(publishAuditPayload.threadId).toBe(commentsToken.d);
  });

  it('publishes only the selected engagement button rows', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      entityType: 'CHANNEL',
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessage: jest.fn().mockResolvedValue(undefined),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await service.publishChannelEngagementMessage(
      'channel-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        text: 'Нажмите кнопку ниже.',
        commentsButtonText: 'Комментарии',
        suggestButtonText: 'Предложить пост',
        includeCommentsButton: false,
        includeSuggestButton: true,
      },
    );

    const [, , options] = maxClient.sendMessage.mock.calls[0] ?? [];
    expect(options.buttons).toHaveLength(1);
    expect(options.buttons?.[0]).toHaveLength(1);
    expect(options.buttons?.[0]?.[0]).toMatchObject({
      type: 'link',
      text: 'Предложить пост',
    });
  });

  it('rejects publishing when all engagement buttons are disabled', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      entityType: 'CHANNEL',
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessage: jest.fn().mockResolvedValue(undefined),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await expect(
      service.publishChannelEngagementMessage(
        'channel-1',
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        {
          text: 'Нажмите кнопку ниже.',
          commentsButtonText: 'Комментарии',
          suggestButtonText: 'Предложить пост',
          includeCommentsButton: false,
          includeSuggestButton: false,
        },
      ),
    ).rejects.toThrow();

    expect(maxClient.sendMessage).not.toHaveBeenCalled();
  });

  it('stores and queries dialog messages inside the thread encoded in the button token', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      entityType: 'CHANNEL',
    });
    prisma.auditLog.create.mockResolvedValueOnce(undefined).mockResolvedValueOnce({
      id: 'message-1',
      actorUserId: 'user-1',
      payload: {},
      createdAt: new Date('2026-03-06T08:00:00.000Z'),
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessage: jest.fn().mockResolvedValue(undefined),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await service.publishChannelEngagementMessage(
      'channel-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        text: 'Нажмите кнопку ниже.',
        commentsButtonText: 'Комментарии',
        suggestButtonText: 'Предложить пост',
      },
    );

    const [, , options] = maxClient.sendMessage.mock.calls[0] ?? [];
    const commentsButton = options.buttons?.[0]?.[0];
    const commentsStartParam = new URL(commentsButton.url).searchParams.get('startapp');
    const commentsLaunch = decodeBase64UrlJson<{ t: string }>(commentsStartParam!.slice(3));
    const commentsToken = commentsLaunch.t;
    const commentsTokenPayload = decodeBase64UrlJson<{ d: string }>(commentsToken.slice(4));

    await service.createChannelDialogMessage(
      'channel-1',
      {
        userId: 'user-1',
        username: 'user1',
        displayName: 'Пользователь',
        chatTitle: null,
      },
      'comments',
      {
        token: commentsToken,
        text: 'Первый комментарий',
      },
    );

    await service.getChannelDialog(
      'channel-1',
      {
        userId: 'user-1',
        username: 'user1',
        displayName: 'Пользователь',
        chatTitle: null,
      },
      'comments',
      commentsToken,
    );

    const commentAuditPayload = prisma.auditLog.create.mock.calls[1]?.[0]?.data?.payload as {
      threadId?: unknown;
    };
    expect(commentAuditPayload.threadId).toBe(commentsTokenPayload.d);
    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          chatId: 'channel-1',
          action: 'CHANNEL_DIALOG_COMMENT',
          payload: {
            path: ['threadId'],
            equals: commentsTokenPayload.d,
          },
        }),
      }),
    );
  });
});
