import { MAX_API_SOURCE_TAGS, type MaxChannelMessageSnapshot } from '../max/max-client.service';
import { MAX_BASE_REQUIRED_WEBHOOK_UPDATE_TYPES } from '../max/max-webhook-subscription.constants';
import { ChannelStatsCollectorService } from './channel-stats-collector.service';

jest.mock('ioredis', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    eval: jest.fn().mockResolvedValue(1),
    quit: jest.fn().mockResolvedValue(undefined),
  })),
}));

function createPrismaMock() {
  return {
    chat: {
      update: jest.fn().mockResolvedValue(undefined),
      findMany: jest.fn().mockResolvedValue([]),
    },
    channelAudienceSnapshot: {
      create: jest.fn().mockResolvedValue(undefined),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    channelPost: {
      findMany: jest.fn().mockResolvedValue([]),
      upsert: jest.fn().mockResolvedValue({ id: 'post-1', viewSnapshots: [] }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    channelPostViewSnapshot: {
      create: jest.fn().mockResolvedValue(undefined),
    },
    channelStatsSyncState: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue(undefined),
    },
    $transaction: jest.fn((items: unknown[]) => Promise.all(items as Promise<unknown>[])),
  };
}

function createConfigMock(
  options: {
    startupSyncEnabled?: boolean;
    startupSyncMaxChannels?: number;
    startupSyncStaleMs?: number;
    startupDelayMs?: number;
    startupJitterMs?: number;
    startupMaxPages?: number;
    endpointMaxPages?: number;
    extendedLifecycleMode?: 'off' | 'shadow' | 'canary' | 'on';
  } = {},
) {
  return {
    get: jest.fn((key: string, fallback?: unknown) => {
      if (key === 'CHANNEL_STATS_STARTUP_SYNC_ENABLED') {
        return options.startupSyncEnabled ?? fallback;
      }
      if (key === 'CHANNEL_STATS_STARTUP_MAX_CHANNELS') {
        return options.startupSyncMaxChannels ?? fallback;
      }
      if (key === 'CHANNEL_STATS_STARTUP_STALE_MS') {
        return options.startupSyncStaleMs ?? fallback;
      }
      if (key === 'CHANNEL_STATS_STARTUP_DELAY_MS') {
        return options.startupDelayMs ?? fallback;
      }
      if (key === 'CHANNEL_STATS_STARTUP_JITTER_MS') {
        return options.startupJitterMs ?? fallback;
      }
      if (key === 'CHANNEL_STATS_STARTUP_MAX_PAGES') {
        return options.startupMaxPages ?? fallback;
      }
      if (key === 'CHANNEL_STATS_ENDPOINT_MAX_PAGES') {
        return options.endpointMaxPages ?? fallback;
      }
      if (key === 'MAX_EXTENDED_WEBHOOK_LIFECYCLE_MODE') {
        return options.extendedLifecycleMode ?? fallback;
      }
      return fallback;
    }),
    getOrThrow: jest.fn((key: string) => {
      if (key === 'REDIS_URL') {
        return 'redis://localhost:6379/0';
      }
      throw new Error(`Missing key ${key}`);
    }),
  };
}

function createScheduledChannelCandidate(params: {
  id: string;
  latestAudienceSnapshotAt?: Date | null;
  lastAudienceSyncAt?: Date | null;
  lastViewsSyncAt?: Date | null;
  lastViewsDiscoveryAt?: Date | null;
  lastViewsAttemptAt?: Date | null;
  syncStateMissing?: boolean;
}) {
  return {
    id: params.id,
    channelStatsSyncState: params.syncStateMissing
      ? null
      : {
          lastAudienceSyncAt: params.lastAudienceSyncAt ?? null,
          lastViewsSyncAt: params.lastViewsSyncAt ?? null,
          lastViewsDiscoveryAt: params.lastViewsDiscoveryAt ?? null,
          lastViewsAttemptAt: params.lastViewsAttemptAt ?? null,
        },
    channelAudienceSnapshots: params.latestAudienceSnapshotAt
      ? [{ capturedAt: params.latestAudienceSnapshotAt }]
      : [],
  };
}

function createPostSnapshot(params: {
  messageId: string;
  publishedAt: string;
  views: number | null;
}): MaxChannelMessageSnapshot {
  return {
    chatId: 'channel-1',
    messageId: params.messageId,
    publishedAt: params.publishedAt,
    publishedAtMs: Date.parse(params.publishedAt),
    url: `https://max.ru/news/${params.messageId}`,
    previewUrl: null,
    views: params.views,
    reactionsTotal: null,
    reactions: [],
  };
}

async function upsertPostSnapshots(
  service: ChannelStatsCollectorService,
  messages: MaxChannelMessageSnapshot[],
  capturedAt: Date,
) {
  await (
    service as unknown as {
      upsertOfficialMessages: (
        chatId: string,
        snapshots: MaxChannelMessageSnapshot[],
        capturedAt: Date,
      ) => Promise<void>;
    }
  ).upsertOfficialMessages('channel-1', messages, capturedAt);
}

describe('ChannelStatsCollectorService', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('imports official snapshots, posts and views for a channel', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-07T12:00:00.000Z'));

    const prisma = createPrismaMock();
    const maxClient = {
      getChatSnapshot: jest.fn().mockResolvedValue({
        chatId: 'channel-1',
        title: 'Новости MAX',
        participantsCount: 1240,
        status: 'active',
        isPublic: true,
        link: 'https://max.ru/news',
        lastEventAt: '2026-03-07T11:55:00.000Z',
        entityType: 'channel',
      }),
      listMessageSnapshots: jest.fn().mockResolvedValue([
        {
          chatId: 'channel-1',
          messageId: 'mid-1',
          publishedAt: '2026-03-06T09:00:00.000Z',
          publishedAtMs: 1772749200000,
          url: 'https://max.ru/news/post-1',
          previewUrl: null,
          views: 120,
          reactionsTotal: 6,
          reactions: [
            { emoji: '🔥', count: 4 },
            { emoji: '👍', count: 2 },
          ],
        },
        {
          chatId: 'channel-1',
          messageId: 'mid-2',
          publishedAt: '2026-03-07T09:00:00.000Z',
          publishedAtMs: 1772835600000,
          url: 'https://max.ru/news/post-2',
          previewUrl: 'https://cdn.max.ru/news/post-2.jpg',
          views: 260,
          reactionsTotal: null,
          reactions: [{ emoji: '❤️', count: 6 }],
        },
      ]),
      ensureWebhookSubscription: jest.fn().mockResolvedValue({
        url: 'https://major-maksimov.ru/api/webhook/max/test/secret',
        updateTypes: ['message_created', 'user_added', 'user_removed'],
      }),
    };

    const service = new ChannelStatsCollectorService(
      prisma as never,
      maxClient as never,
      createConfigMock() as never,
    );

    await service.syncChannel('channel-1', {
      reason: 'manual',
      markOpportunistic: true,
    });

    expect(maxClient.ensureWebhookSubscription).toHaveBeenCalledWith(
      [...MAX_BASE_REQUIRED_WEBHOOK_UPDATE_TYPES],
      expect.objectContaining({
        trafficClass: 'background',
        sourceTag: MAX_API_SOURCE_TAGS.CHANNEL_STATS_SYNC,
      }),
    );
    expect(maxClient.getChatSnapshot).toHaveBeenCalledWith(
      'channel-1',
      expect.objectContaining({
        trafficClass: 'background',
        sourceTag: MAX_API_SOURCE_TAGS.CHANNEL_STATS_SYNC,
      }),
    );
    expect(maxClient.listMessageSnapshots).toHaveBeenCalledWith(
      'channel-1',
      expect.objectContaining({
        trafficClass: 'background',
        sourceTag: MAX_API_SOURCE_TAGS.CHANNEL_STATS_SYNC,
      }),
    );
    expect(prisma.chat.update).toHaveBeenCalledWith({
      where: { id: 'channel-1' },
      data: {
        title: 'Новости MAX',
        entityType: 'CHANNEL',
      },
    });
    expect(prisma.channelAudienceSnapshot.create).toHaveBeenCalledWith({
      data: {
        chatId: 'channel-1',
        participantsCount: 1240,
        status: 'active',
        isPublic: true,
        link: 'https://max.ru/news',
        lastEventAt: new Date('2026-03-07T11:55:00.000Z'),
        capturedAt: new Date('2026-03-07T12:00:00.000Z'),
      },
    });
    expect(prisma.channelPost.upsert).toHaveBeenCalledTimes(2);
    expect(prisma.channelPost.upsert).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        create: expect.objectContaining({
          latestReactionsTotal: 6,
          previewUrl: null,
          latestReactions: [
            { emoji: '🔥', count: 4 },
            { emoji: '👍', count: 2 },
          ],
        }),
        update: expect.objectContaining({
          latestReactionsTotal: 6,
          previewUrl: null,
          latestReactions: [
            { emoji: '🔥', count: 4 },
            { emoji: '👍', count: 2 },
          ],
        }),
      }),
    );
    expect(prisma.channelPostViewSnapshot.create).toHaveBeenCalledTimes(2);
    expect(prisma.channelPostViewSnapshot.create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: expect.objectContaining({
          views: 120,
          reactionsTotal: 6,
        }),
      }),
    );
    expect(prisma.channelStatsSyncState.upsert).toHaveBeenCalledWith({
      where: { chatId: 'channel-1' },
      create: expect.objectContaining({
        chatId: 'channel-1',
        viewsCoverageFrom: new Date('2026-02-05T12:00:00.000Z'),
        lastAudienceSyncAt: new Date('2026-03-07T12:00:00.000Z'),
        lastViewsSyncAt: new Date('2026-03-07T12:00:00.000Z'),
        lastOpportunisticSyncAt: new Date('2026-03-07T12:00:00.000Z'),
      }),
      update: expect.objectContaining({
        lastAudienceSyncAt: new Date('2026-03-07T12:00:00.000Z'),
        lastViewsSyncAt: new Date('2026-03-07T12:00:00.000Z'),
      }),
    });

    await service.onModuleDestroy();
  });

  it('preserves the last known view state when MAX omits post views', async () => {
    const prisma = createPrismaMock();
    const service = new ChannelStatsCollectorService(
      prisma as never,
      {} as never,
      createConfigMock() as never,
    );

    await upsertPostSnapshots(
      service,
      [
        createPostSnapshot({
          messageId: 'mid-without-views',
          publishedAt: '2026-03-06T12:00:00.000Z',
          views: null,
        }),
      ],
      new Date('2026-03-07T12:00:00.000Z'),
    );

    const upsert = prisma.channelPost.upsert.mock.calls[0]?.[0];
    expect(upsert.create).not.toHaveProperty('latestViews');
    expect(upsert.create).not.toHaveProperty('latestSnapshotAt');
    expect(upsert.update).not.toHaveProperty('latestViews');
    expect(upsert.update).not.toHaveProperty('latestSnapshotAt');
    expect(prisma.channelPostViewSnapshot.create).not.toHaveBeenCalled();
    expect(prisma.channelPost.updateMany).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('does not store another raw snapshot when the confirmed view count is unchanged', async () => {
    const prisma = createPrismaMock();
    prisma.channelPost.upsert.mockResolvedValue({
      id: 'post-1',
      viewSnapshots: [{ views: 240 }],
    });
    const service = new ChannelStatsCollectorService(
      prisma as never,
      {} as never,
      createConfigMock() as never,
    );

    await upsertPostSnapshots(
      service,
      [
        createPostSnapshot({
          messageId: 'mid-unchanged',
          publishedAt: '2026-03-06T12:00:00.000Z',
          views: 240,
        }),
      ],
      new Date('2026-03-07T12:00:00.000Z'),
    );

    expect(prisma.channelPostViewSnapshot.create).not.toHaveBeenCalled();
    expect(prisma.channelPost.updateMany).toHaveBeenCalledWith({
      where: { id: 'post-1', viewsAt24h: null },
      data: {
        viewsAt24h: 240,
        viewsAt24hCapturedAt: new Date('2026-03-07T12:00:00.000Z'),
      },
    });

    await service.onModuleDestroy();
  });

  it.each([
    {
      label: '24-hour lower boundary, including a confirmed zero',
      publishedAt: '2026-03-06T12:00:00.000Z',
      views: 0,
      where: { id: 'post-1', viewsAt24h: null },
      data: {
        viewsAt24h: 0,
        viewsAt24hCapturedAt: new Date('2026-03-07T12:00:00.000Z'),
      },
    },
    {
      label: '48-hour upper boundary',
      publishedAt: '2026-03-05T09:00:00.000Z',
      views: 480,
      where: { id: 'post-1', viewsAt48h: null },
      data: {
        viewsAt48h: 480,
        viewsAt48hCapturedAt: new Date('2026-03-07T12:00:00.000Z'),
      },
    },
  ])('materializes the $label milestone only once', async ({ publishedAt, views, where, data }) => {
    const prisma = createPrismaMock();
    const service = new ChannelStatsCollectorService(
      prisma as never,
      {} as never,
      createConfigMock() as never,
    );
    const capturedAt = new Date('2026-03-07T12:00:00.000Z');

    await upsertPostSnapshots(
      service,
      [createPostSnapshot({ messageId: 'mid-milestone', publishedAt, views })],
      capturedAt,
    );

    expect(prisma.channelPostViewSnapshot.create).toHaveBeenCalledWith({
      data: {
        channelPostId: 'post-1',
        views,
        reactionsTotal: 0,
        capturedAt,
      },
    });
    expect(prisma.channelPost.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.channelPost.updateMany).toHaveBeenCalledWith({ where, data });

    await service.onModuleDestroy();
  });

  it('does not backfill milestones outside their three-hour capture windows', async () => {
    const prisma = createPrismaMock();
    const service = new ChannelStatsCollectorService(
      prisma as never,
      {} as never,
      createConfigMock() as never,
    );

    await upsertPostSnapshots(
      service,
      [
        createPostSnapshot({
          messageId: 'mid-before-24h',
          publishedAt: '2026-03-06T12:00:00.001Z',
          views: 240,
        }),
        createPostSnapshot({
          messageId: 'mid-after-27h',
          publishedAt: '2026-03-06T08:59:59.999Z',
          views: 270,
        }),
      ],
      new Date('2026-03-07T12:00:00.000Z'),
    );

    expect(prisma.channelPostViewSnapshot.create).toHaveBeenCalledTimes(2);
    expect(prisma.channelPost.updateMany).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('prioritizes due milestones with exact message lookups and the capability bot', async () => {
    const now = new Date('2026-03-07T12:00:00.000Z');
    const prisma = createPrismaMock();
    prisma.channelPost.findMany.mockResolvedValue([
      { id: 'mid-due-48h', chatId: 'channel-1', messageId: 'mid-due-48h' },
      { id: 'mid-due-24h', chatId: 'channel-1', messageId: 'mid-due-24h' },
    ]);
    prisma.channelPost.upsert.mockImplementation(
      ({ where }: { where: { chatId_messageId: { messageId: string } } }) =>
        Promise.resolve({ id: where.chatId_messageId.messageId, viewSnapshots: [] }),
    );
    const snapshots = new Map([
      [
        'mid-due-48h',
        createPostSnapshot({
          messageId: 'mid-due-48h',
          publishedAt: '2026-03-05T11:00:00.000Z',
          views: 480,
        }),
      ],
      [
        'mid-due-24h',
        createPostSnapshot({
          messageId: 'mid-due-24h',
          publishedAt: '2026-03-06T11:00:00.000Z',
          views: 240,
        }),
      ],
    ]);
    const maxClient = {
      getMessageSnapshot: jest.fn((_chatId: string, messageId: string) =>
        Promise.resolve(snapshots.get(messageId) ?? null),
      ),
    };
    const maxBotLinkService = {
      resolveBotRoute: jest.fn().mockResolvedValue({
        purpose: 'capability',
        chatId: 'channel-1',
        primaryBotId: 'primary-bot',
        botId: 'stats-bot',
        candidateBotIds: ['stats-bot'],
        reason: 'alternate_confirmed',
        capability: 'channel_stats',
      }),
    };
    const service = new ChannelStatsCollectorService(
      prisma as never,
      maxClient as never,
      createConfigMock() as never,
      undefined,
      maxBotLinkService as never,
    );

    const throttled = await (
      service as unknown as {
        syncDuePostViewMilestones: (capturedAt: Date) => Promise<boolean>;
      }
    ).syncDuePostViewMilestones(now);

    expect(throttled).toBe(false);
    expect(prisma.channelPost.findMany).toHaveBeenCalledWith({
      where: {
        AND: [
          {
            OR: [
              { viewMilestoneLastAttemptAt: null },
              {
                viewMilestoneLastAttemptAt: {
                  lte: new Date('2026-03-07T11:45:00.000Z'),
                },
              },
            ],
          },
          {
            OR: [
              {
                viewsAt24h: null,
                publishedAt: {
                  gte: new Date('2026-03-06T09:00:00.000Z'),
                  lte: new Date('2026-03-06T12:00:00.000Z'),
                },
              },
              {
                viewsAt48h: null,
                publishedAt: {
                  gte: new Date('2026-03-05T09:00:00.000Z'),
                  lte: new Date('2026-03-05T12:00:00.000Z'),
                },
              },
            ],
          },
        ],
      },
      orderBy: [
        { viewMilestoneLastAttemptAt: { sort: 'asc', nulls: 'first' } },
        { publishedAt: 'asc' },
        { id: 'asc' },
      ],
      take: 200,
      select: { id: true, chatId: true, messageId: true },
    });
    expect(maxClient.getMessageSnapshot).toHaveBeenCalledTimes(2);
    expect(maxClient.getMessageSnapshot).toHaveBeenCalledWith(
      'channel-1',
      'mid-due-48h',
      expect.objectContaining({
        botId: 'stats-bot',
        trafficClass: 'background',
        sourceTag: MAX_API_SOURCE_TAGS.CHANNEL_STATS_SYNC,
      }),
    );
    expect(prisma.channelPost.updateMany).toHaveBeenCalledWith({
      where: { id: 'mid-due-48h', viewsAt48h: null },
      data: { viewsAt48h: 480, viewsAt48hCapturedAt: now },
    });
    expect(prisma.channelPost.updateMany).toHaveBeenCalledWith({
      where: { id: 'mid-due-24h', viewsAt24h: null },
      data: { viewsAt24h: 240, viewsAt24hCapturedAt: now },
    });
    expect(prisma.channelPost.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['mid-due-48h', 'mid-due-24h'] } },
      data: { viewMilestoneLastAttemptAt: now },
    });

    await service.onModuleDestroy();
  });

  it('keeps never-attempted milestones ahead after older failures leave cooldown', async () => {
    const now = new Date('2026-03-07T12:00:00.000Z');
    const passTimes = [
      now,
      new Date('2026-03-07T12:05:00.000Z'),
      new Date('2026-03-07T12:10:00.000Z'),
      new Date('2026-03-07T12:15:00.000Z'),
    ];
    const unavailablePosts = Array.from({ length: 60 }, (_, index) => ({
      id: `post-unavailable-${index + 1}`,
      chatId: 'channel-1',
      messageId: `mid-unavailable-${index + 1}`,
    }));
    const validPost = {
      id: 'post-valid-61',
      chatId: 'channel-1',
      messageId: 'mid-valid-61',
    };
    const prisma = createPrismaMock();
    prisma.channelPost.findMany
      .mockResolvedValueOnce(unavailablePosts.slice(0, 20))
      .mockResolvedValueOnce(unavailablePosts.slice(20, 40))
      .mockResolvedValueOnce(unavailablePosts.slice(40, 60))
      .mockResolvedValueOnce([validPost]);
    const maxClient = {
      getMessageSnapshot: jest.fn((_chatId: string, messageId: string) =>
        Promise.resolve(
          messageId === validPost.messageId
            ? createPostSnapshot({
                messageId,
                publishedAt: '2026-03-06T11:00:00.000Z',
                views: 240,
              })
            : null,
        ),
      ),
    };
    const service = new ChannelStatsCollectorService(
      prisma as never,
      maxClient as never,
      createConfigMock() as never,
    );
    const syncMilestones = (
      service as unknown as {
        syncDuePostViewMilestones: (capturedAt: Date, maxPosts: number) => Promise<boolean>;
      }
    ).syncDuePostViewMilestones.bind(service);

    for (const passAt of passTimes) {
      await syncMilestones(passAt, 20);
    }

    expect(maxClient.getMessageSnapshot).toHaveBeenCalledTimes(61);
    expect(maxClient.getMessageSnapshot).toHaveBeenLastCalledWith(
      'channel-1',
      validPost.messageId,
      expect.objectContaining({ sourceTag: MAX_API_SOURCE_TAGS.CHANNEL_STATS_SYNC }),
    );
    expect(prisma.channelPost.updateMany).toHaveBeenCalledWith({
      where: { id: { in: unavailablePosts.slice(0, 20).map((post) => post.id) } },
      data: { viewMilestoneLastAttemptAt: now },
    });
    expect(prisma.channelPost.findMany).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({
        orderBy: [
          { viewMilestoneLastAttemptAt: { sort: 'asc', nulls: 'first' } },
          { publishedAt: 'asc' },
          { id: 'asc' },
        ],
        where: expect.objectContaining({
          AND: expect.arrayContaining([
            {
              OR: [
                { viewMilestoneLastAttemptAt: null },
                {
                  viewMilestoneLastAttemptAt: {
                    lte: now,
                  },
                },
              ],
            },
          ]),
        }),
      }),
    );

    await service.onModuleDestroy();
  });

  it('continues milestone capture after one channel route lookup fails', async () => {
    const now = new Date('2026-03-07T12:00:00.000Z');
    const prisma = createPrismaMock();
    prisma.channelPost.findMany.mockResolvedValue([
      { id: 'post-route-failed', chatId: 'channel-a', messageId: 'mid-route-failed' },
      { id: 'post-valid', chatId: 'channel-b', messageId: 'mid-valid' },
    ]);
    const maxClient = {
      getMessageSnapshot: jest.fn().mockResolvedValue(
        createPostSnapshot({
          messageId: 'mid-valid',
          publishedAt: '2026-03-06T11:00:00.000Z',
          views: 240,
        }),
      ),
    };
    const maxBotLinkService = {
      resolveBotRoute: jest
        .fn()
        .mockRejectedValueOnce(new Error('route cache unavailable'))
        .mockResolvedValueOnce({ botId: 'stats-bot' }),
    };
    const service = new ChannelStatsCollectorService(
      prisma as never,
      maxClient as never,
      createConfigMock() as never,
      undefined,
      maxBotLinkService as never,
    );

    const throttled = await (
      service as unknown as {
        syncDuePostViewMilestones: (capturedAt: Date) => Promise<boolean>;
      }
    ).syncDuePostViewMilestones(now);

    expect(throttled).toBe(false);
    expect(maxClient.getMessageSnapshot).toHaveBeenCalledTimes(1);
    expect(maxClient.getMessageSnapshot).toHaveBeenCalledWith(
      'channel-b',
      'mid-valid',
      expect.objectContaining({ botId: 'stats-bot' }),
    );
    expect(prisma.channelPost.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['post-route-failed'] } },
      data: { viewMilestoneLastAttemptAt: now },
    });

    await service.onModuleDestroy();
  });

  it('records unavailable audience snapshots after MAX 404', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-07T12:00:00.000Z'));

    const prisma = createPrismaMock();
    const maxClient = {
      getChatSnapshot: jest
        .fn()
        .mockRejectedValue(Object.assign(new Error('not found'), { response: { status: 404 } })),
      ensureWebhookSubscription: jest.fn(),
    };
    const service = new ChannelStatsCollectorService(
      prisma as never,
      maxClient as never,
      createConfigMock() as never,
    );

    const result = await service.syncAudienceSnapshotIfStale('channel-missing', {
      reason: 'scheduled',
    });

    expect(result).toEqual({
      audienceSynced: true,
      throttled: false,
      syncedAt: new Date('2026-03-07T12:00:00.000Z'),
      unavailable: true,
    });
    expect(prisma.channelAudienceSnapshot.create).toHaveBeenCalledWith({
      data: {
        chatId: 'channel-missing',
        participantsCount: null,
        status: 'not_found',
        isPublic: null,
        link: null,
        lastEventAt: null,
        capturedAt: new Date('2026-03-07T12:00:00.000Z'),
      },
    });
    expect(prisma.channelStatsSyncState.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          chatId: 'channel-missing',
          lastAudienceSyncAt: new Date('2026-03-07T12:00:00.000Z'),
        }),
        update: expect.objectContaining({
          lastAudienceSyncAt: new Date('2026-03-07T12:00:00.000Z'),
        }),
      }),
    );

    await service.onModuleDestroy();
  });

  it('skips views sync after a MAX 404 audience snapshot', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-07T12:00:00.000Z'));

    const prisma = createPrismaMock();
    const maxClient = {
      getChatSnapshot: jest
        .fn()
        .mockRejectedValue(Object.assign(new Error('not found'), { response: { status: 404 } })),
      listMessageSnapshots: jest.fn(),
      ensureWebhookSubscription: jest.fn().mockResolvedValue({
        url: 'https://major-maksimov.ru/api/webhook/max/test/secret',
        updateTypes: ['message_created', 'user_added', 'user_removed'],
      }),
    };
    const service = new ChannelStatsCollectorService(
      prisma as never,
      maxClient as never,
      createConfigMock() as never,
    );

    await service.syncChannel('channel-missing', { reason: 'scheduled' });

    expect(maxClient.listMessageSnapshots).not.toHaveBeenCalled();
    expect(prisma.channelStatsSyncState.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          chatId: 'channel-missing',
          lastAudienceSyncAt: new Date('2026-03-07T12:00:00.000Z'),
          lastViewsSyncAt: null,
        }),
        update: expect.objectContaining({
          lastAudienceSyncAt: new Date('2026-03-07T12:00:00.000Z'),
        }),
      }),
    );

    await service.onModuleDestroy();
  });

  it('uses the unified capability route for channel stats sync when available', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-07T12:01:00.000Z'));

    const prisma = createPrismaMock();
    const maxClient = {
      getChatSnapshot: jest.fn().mockResolvedValue({
        chatId: 'channel-route-1',
        title: 'Новости MAX',
        participantsCount: 1240,
        status: 'active',
        isPublic: true,
        link: 'https://max.ru/news',
        lastEventAt: '2026-03-07T11:55:00.000Z',
        entityType: 'channel',
      }),
      listMessageSnapshots: jest.fn().mockResolvedValue([]),
      ensureWebhookSubscription: jest.fn().mockResolvedValue({
        url: 'https://major-maksimov.ru/api/webhook/max/test/secret',
        updateTypes: ['message_created', 'user_added', 'user_removed'],
      }),
    };
    const maxBotLinkService = {
      resolveBotRoute: jest.fn().mockResolvedValue({
        purpose: 'capability',
        chatId: 'channel-route-1',
        primaryBotId: 'id613002203036_bot',
        botId: 'id613002203036_4_bot',
        candidateBotIds: ['id613002203036_4_bot'],
        reason: 'alternate_confirmed',
        capability: 'channel_stats',
      }),
      resolveBotIdForCapability: jest.fn(),
    };

    const service = new ChannelStatsCollectorService(
      prisma as never,
      maxClient as never,
      createConfigMock() as never,
      undefined,
      maxBotLinkService as never,
    );

    await service.syncChannel('channel-route-1', {
      reason: 'manual',
    });

    expect(maxBotLinkService.resolveBotRoute).toHaveBeenCalledWith({
      purpose: 'capability',
      chatId: 'channel-route-1',
      capability: 'channel_stats',
      fallbackToPrimary: true,
    });
    expect(maxBotLinkService.resolveBotIdForCapability).not.toHaveBeenCalled();
    expect(maxClient.getChatSnapshot).toHaveBeenCalledWith(
      'channel-route-1',
      expect.objectContaining({
        botId: 'id613002203036_4_bot',
        trafficClass: 'background',
        sourceTag: MAX_API_SOURCE_TAGS.CHANNEL_STATS_SYNC,
      }),
    );

    await service.onModuleDestroy();
  });

  it('does not reuse cached webhook coverage as a new channel membership baseline', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-07T12:00:00.000Z'));

    const prisma = createPrismaMock();
    const maxClient = {
      getChatSnapshot: jest.fn((chatId: string) =>
        Promise.resolve({
          chatId,
          title: `Канал ${chatId}`,
          participantsCount: 250,
          status: 'active',
          isPublic: true,
          link: null,
          lastEventAt: '2026-03-07T11:55:00.000Z',
          entityType: 'channel',
        }),
      ),
      listMessageSnapshots: jest.fn().mockResolvedValue([]),
      ensureWebhookSubscription: jest.fn().mockResolvedValue({
        url: 'https://major-maksimov.ru/api/webhook/max/test/secret',
        updateTypes: ['message_created', 'user_added', 'user_removed'],
      }),
    };

    const service = new ChannelStatsCollectorService(
      prisma as never,
      maxClient as never,
      createConfigMock() as never,
    );

    await service.syncChannel('channel-1', { reason: 'manual' });
    jest.setSystemTime(new Date('2026-03-07T12:10:00.000Z'));
    await service.syncChannel('channel-2', { reason: 'manual' });

    expect(maxClient.ensureWebhookSubscription).toHaveBeenCalledTimes(1);
    expect(prisma.channelStatsSyncState.upsert).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        create: expect.objectContaining({
          chatId: 'channel-1',
          membershipCoverageFrom: new Date('2026-03-07T12:00:00.000Z'),
        }),
      }),
    );
    expect(prisma.channelStatsSyncState.upsert).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        create: expect.objectContaining({
          chatId: 'channel-2',
          membershipCoverageFrom: new Date('2026-03-07T12:10:00.000Z'),
        }),
      }),
    );

    await service.onModuleDestroy();
  });

  it('skips opportunistic sync when snapshots are still fresh', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-07T12:00:00.000Z'));

    const prisma = createPrismaMock();
    prisma.channelAudienceSnapshot.findFirst.mockResolvedValue({
      capturedAt: new Date('2026-03-07T11:30:00.000Z'),
    });
    prisma.channelStatsSyncState.findUnique.mockResolvedValue({
      lastAudienceSyncAt: new Date('2026-03-07T11:30:00.000Z'),
      lastViewsSyncAt: new Date('2026-03-07T11:30:00.000Z'),
    });

    const maxClient = {
      getChatSnapshot: jest.fn(),
      listMessageSnapshots: jest.fn(),
      ensureWebhookSubscription: jest.fn(),
    };

    const service = new ChannelStatsCollectorService(
      prisma as never,
      maxClient as never,
      createConfigMock() as never,
    );
    const syncSpy = jest.spyOn(service, 'syncChannel').mockResolvedValue({
      audienceSynced: false,
      viewsSynced: false,
      throttled: false,
    });

    await service.syncChannelIfStale('channel-1');

    expect(syncSpy).not.toHaveBeenCalled();
    await service.onModuleDestroy();
  });

  it('uses a smaller MAX page budget for stats endpoint refreshes', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-07T12:00:00.000Z'));

    const prisma = createPrismaMock();
    const maxClient = {
      getChatSnapshot: jest.fn().mockResolvedValue({
        chatId: 'channel-1',
        title: 'Новости MAX',
        participantsCount: 1240,
        status: 'active',
        isPublic: true,
        link: 'https://max.ru/news',
        lastEventAt: '2026-03-07T11:55:00.000Z',
        entityType: 'channel',
      }),
      listMessageSnapshots: jest.fn().mockResolvedValue(
        Array.from({ length: 100 }, (_, index) =>
          createPostSnapshot({
            messageId: `mid-endpoint-${index + 1}`,
            publishedAt: '2026-03-07T10:00:00.000Z',
            views: 100 + index,
          }),
        ),
      ),
      ensureWebhookSubscription: jest.fn().mockResolvedValue({
        url: 'https://major-maksimov.ru/api/webhook/max/test/secret',
        updateTypes: ['message_created', 'user_added', 'user_removed'],
      }),
    };

    const service = new ChannelStatsCollectorService(
      prisma as never,
      maxClient as never,
      createConfigMock({
        endpointMaxPages: 5,
      }) as never,
    );

    await service.syncChannelIfStale('channel-1', {
      reason: 'stats_endpoint',
    });

    expect(maxClient.listMessageSnapshots).toHaveBeenCalledWith(
      'channel-1',
      expect.objectContaining({
        count: 100,
        maxPages: 5,
        trafficClass: 'background',
        sourceTag: MAX_API_SOURCE_TAGS.CHANNEL_STATS_SYNC,
      }),
    );
    expect(prisma.channelStatsSyncState.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          viewsCoverageFrom: null,
          lastViewsSyncAt: null,
          lastViewsDiscoveryAt: new Date('2026-03-07T12:00:00.000Z'),
          lastViewsAttemptAt: new Date('2026-03-07T12:00:00.000Z'),
        }),
        update: expect.not.objectContaining({
          viewsCoverageFrom: expect.anything(),
          lastViewsSyncAt: expect.anything(),
        }),
      }),
    );

    await service.onModuleDestroy();
  });

  it('keeps audience first and limits stats endpoint views under MAX capacity pressure', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-07T12:00:00.000Z'));

    const calls: string[] = [];
    const prisma = createPrismaMock();
    const maxClient = {
      getChatSnapshot: jest.fn().mockImplementation(async () => {
        calls.push('audience');
        return {
          chatId: 'channel-1',
          title: 'Новости MAX',
          participantsCount: 1240,
          status: 'active',
          isPublic: true,
          link: 'https://max.ru/news',
          lastEventAt: '2026-03-07T11:55:00.000Z',
          entityType: 'channel',
        };
      }),
      listMessageSnapshots: jest.fn().mockImplementation(async () => {
        calls.push('views');
        return [];
      }),
      ensureWebhookSubscription: jest.fn().mockResolvedValue({
        url: 'https://major-maksimov.ru/api/webhook/max/test/secret',
        updateTypes: ['message_created', 'user_added', 'user_removed'],
      }),
    };
    const backgroundRuntimeGovernorService = {
      decide: jest.fn().mockResolvedValue({
        action: 'slow',
        reason: 'MAX API stack load 80.0%',
        retryAfterMs: 60_000,
      }),
    };
    const service = new ChannelStatsCollectorService(
      prisma as never,
      maxClient as never,
      createConfigMock({ endpointMaxPages: 5 }) as never,
      undefined,
      undefined,
      backgroundRuntimeGovernorService as never,
    );

    await service.syncChannelIfStale('channel-1', {
      reason: 'stats_endpoint',
    });

    expect(calls).toEqual(['audience', 'views']);
    expect(backgroundRuntimeGovernorService.decide).toHaveBeenCalledWith({
      component: 'channel-stats',
      sourceTag: MAX_API_SOURCE_TAGS.CHANNEL_STATS_SYNC,
      allowMaxApiCapacitySlowPath: true,
    });
    expect(maxClient.listMessageSnapshots).toHaveBeenCalledWith(
      'channel-1',
      expect.objectContaining({
        count: 100,
        maxPages: 1,
        trafficClass: 'background',
        sourceTag: MAX_API_SOURCE_TAGS.CHANNEL_STATS_SYNC,
      }),
    );

    await service.onModuleDestroy();
  });

  it('refreshes stale audience for stats endpoint while heavy stats work is paused', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-07T12:00:00.000Z'));

    const prisma = createPrismaMock();
    const maxClient = {
      getChatSnapshot: jest.fn().mockResolvedValue({
        chatId: 'channel-1',
        title: 'Новости MAX',
        participantsCount: 4096,
        status: 'active',
        isPublic: true,
        link: 'https://max.ru/news',
        lastEventAt: '2026-03-07T11:55:00.000Z',
        entityType: 'channel',
      }),
      listMessageSnapshots: jest.fn(),
      ensureWebhookSubscription: jest.fn(),
    };
    const systemModeService = {
      getEffectiveSnapshot: jest.fn().mockResolvedValue({
        mode: 'degrade',
        source: 'auto',
        reason: 'queue lag 24.0s',
        updatedAt: new Date().toISOString(),
        manualMode: null,
        queueLagSec: 24,
        action: {
          windowSec: 60,
          total: 200,
          success: 190,
          failure: 10,
          critical: 0,
          errorRate: 0.05,
          criticalRate: 0,
        },
      }),
    };

    const service = new ChannelStatsCollectorService(
      prisma as never,
      maxClient as never,
      createConfigMock() as never,
      systemModeService as never,
    );

    await service.syncChannelIfStale('channel-1', {
      reason: 'stats_endpoint',
    });

    expect(systemModeService.getEffectiveSnapshot).toHaveBeenCalled();
    expect(maxClient.getChatSnapshot).toHaveBeenCalledWith(
      'channel-1',
      expect.objectContaining({
        trafficClass: 'background',
        sourceTag: MAX_API_SOURCE_TAGS.CHANNEL_STATS_SYNC,
        bypassCache: true,
      }),
    );
    expect(prisma.channelAudienceSnapshot.create).toHaveBeenCalledWith({
      data: {
        chatId: 'channel-1',
        participantsCount: 4096,
        status: 'active',
        isPublic: true,
        link: 'https://max.ru/news',
        lastEventAt: new Date('2026-03-07T11:55:00.000Z'),
        capturedAt: new Date('2026-03-07T12:00:00.000Z'),
      },
    });
    expect(prisma.channelStatsSyncState.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          chatId: 'channel-1',
          lastAudienceSyncAt: new Date('2026-03-07T12:00:00.000Z'),
          lastOpportunisticSyncAt: new Date('2026-03-07T12:00:00.000Z'),
        }),
        update: expect.objectContaining({
          lastAudienceSyncAt: new Date('2026-03-07T12:00:00.000Z'),
          lastOpportunisticSyncAt: new Date('2026-03-07T12:00:00.000Z'),
        }),
      }),
    );
    expect(maxClient.listMessageSnapshots).not.toHaveBeenCalled();
    expect(maxClient.ensureWebhookSubscription).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('backs off background startup sync after MAX API throttling', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-07T12:00:00.000Z'));

    const prisma = createPrismaMock();
    prisma.chat.findMany.mockResolvedValue([{ id: 'channel-1' }]);
    const maxClient = {
      ensureWebhookSubscription: jest.fn().mockResolvedValue({
        url: 'https://major-maksimov.ru/api/webhook/max/test/secret',
        updateTypes: ['message_created', 'user_added', 'user_removed'],
      }),
    };

    const service = new ChannelStatsCollectorService(
      prisma as never,
      maxClient as never,
      createConfigMock() as never,
    );
    const syncSpy = jest
      .spyOn(service, 'syncChannel')
      .mockResolvedValueOnce({
        audienceSynced: false,
        viewsSynced: false,
        throttled: true,
      })
      .mockResolvedValueOnce({
        audienceSynced: true,
        viewsSynced: true,
        throttled: false,
      });

    await service.syncAllChannels('startup');
    expect(syncSpy).toHaveBeenCalledTimes(1);

    await service.syncAllChannels('startup');
    expect(syncSpy).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(60_001);

    await service.syncAllChannels('startup');
    expect(syncSpy).toHaveBeenCalledTimes(2);
    expect(syncSpy).toHaveBeenNthCalledWith(2, 'channel-1', { reason: 'startup' });

    await service.onModuleDestroy();
  });

  it('limits startup sync to stale channels when warmup is enabled', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-07T12:00:00.000Z'));

    const prisma = createPrismaMock();
    prisma.chat.findMany.mockResolvedValue([
      {
        id: 'channel-stale',
        channelStatsSyncState: {
          lastAudienceSyncAt: new Date('2026-03-07T03:00:00.000Z'),
          lastViewsSyncAt: new Date('2026-03-07T03:30:00.000Z'),
        },
      },
      {
        id: 'channel-fresh',
        channelStatsSyncState: {
          lastAudienceSyncAt: new Date('2026-03-07T11:45:00.000Z'),
          lastViewsSyncAt: new Date('2026-03-07T11:40:00.000Z'),
        },
      },
      {
        id: 'channel-missing',
        channelStatsSyncState: null,
      },
    ]);
    const maxClient = {
      ensureWebhookSubscription: jest.fn().mockResolvedValue({
        url: 'https://major-maksimov.ru/api/webhook/max/test/secret',
        updateTypes: ['message_created', 'user_added', 'user_removed'],
      }),
    };

    const service = new ChannelStatsCollectorService(
      prisma as never,
      maxClient as never,
      createConfigMock({
        startupSyncEnabled: true,
        startupSyncMaxChannels: 2,
        startupSyncStaleMs: 2 * 60 * 60 * 1_000,
      }) as never,
    );
    const syncSpy = jest.spyOn(service, 'syncChannel').mockResolvedValue({
      audienceSynced: true,
      viewsSynced: true,
      throttled: false,
    });

    const startupSync = (
      service as unknown as { syncStartupChannels: () => Promise<void> }
    ).syncStartupChannels();
    await jest.runAllTimersAsync();
    await startupSync;

    expect(syncSpy).toHaveBeenCalledTimes(2);
    expect(syncSpy).toHaveBeenNthCalledWith(1, 'channel-missing', { reason: 'startup' });
    expect(syncSpy).toHaveBeenNthCalledWith(2, 'channel-stale', { reason: 'startup' });

    await service.onModuleDestroy();
  });

  it('delays startup sync with a configurable warmup window', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-07T12:00:00.000Z'));

    const prisma = createPrismaMock();
    const maxClient = {
      ensureWebhookSubscription: jest.fn(),
    };
    const service = new ChannelStatsCollectorService(
      prisma as never,
      maxClient as never,
      createConfigMock({
        startupSyncEnabled: true,
        startupSyncMaxChannels: 2,
        startupDelayMs: 45_000,
        startupJitterMs: 0,
      }) as never,
    );
    const startupSpy = jest
      .spyOn(
        service as unknown as { syncStartupChannels: () => Promise<void> },
        'syncStartupChannels',
      )
      .mockResolvedValue(undefined);

    service.onModuleInit();
    expect(startupSpy).not.toHaveBeenCalled();

    jest.advanceTimersByTime(44_999);
    await Promise.resolve();
    expect(startupSpy).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    await Promise.resolve();
    expect(startupSpy).toHaveBeenCalledTimes(1);

    await service.onModuleDestroy();
  });

  it('schedules a delayed lightweight catch-up pass on startup', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-07T12:00:00.000Z'));

    const prisma = createPrismaMock();
    const maxClient = {
      ensureWebhookSubscription: jest.fn(),
    };
    const service = new ChannelStatsCollectorService(
      prisma as never,
      maxClient as never,
      createConfigMock() as never,
    );
    const catchUpSpy = jest
      .spyOn(
        service as unknown as {
          syncScheduledAudienceCatchUpOnly: (reason: 'scheduled') => Promise<void>;
        },
        'syncScheduledAudienceCatchUpOnly',
      )
      .mockResolvedValue(undefined);

    service.onModuleInit();
    expect(catchUpSpy).not.toHaveBeenCalled();

    jest.advanceTimersByTime(89_999);
    await Promise.resolve();
    expect(catchUpSpy).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    await Promise.resolve();
    expect(catchUpSpy).toHaveBeenCalledWith('scheduled');

    jest.advanceTimersByTime(210_000);
    await Promise.resolve();
    expect(catchUpSpy).toHaveBeenCalledTimes(2);

    await service.onModuleDestroy();
  });

  it('uses a lighter MAX page budget for startup channel stats sync', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-07T12:00:00.000Z'));

    const prisma = createPrismaMock();
    const maxClient = {
      getChatSnapshot: jest.fn().mockResolvedValue({
        chatId: 'channel-1',
        title: 'Новости MAX',
        participantsCount: 1240,
        status: 'active',
        isPublic: true,
        link: 'https://max.ru/news',
        lastEventAt: '2026-03-07T11:55:00.000Z',
        entityType: 'channel',
      }),
      listMessageSnapshots: jest.fn().mockResolvedValue([]),
      ensureWebhookSubscription: jest.fn().mockResolvedValue({
        url: 'https://major-maksimov.ru/api/webhook/max/test/secret',
        updateTypes: ['message_created', 'user_added', 'user_removed'],
      }),
    };

    const service = new ChannelStatsCollectorService(
      prisma as never,
      maxClient as never,
      createConfigMock({
        startupMaxPages: 12,
      }) as never,
    );

    await service.syncChannel('channel-1', {
      reason: 'startup',
    });

    expect(maxClient.listMessageSnapshots).toHaveBeenCalledWith(
      'channel-1',
      expect.objectContaining({
        count: 100,
        maxPages: 12,
        trafficClass: 'background',
        sourceTag: MAX_API_SOURCE_TAGS.CHANNEL_STATS_SYNC,
      }),
    );

    await service.onModuleDestroy();
  });

  it('runs scheduled audience catch-up before the separate views sync', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-07T12:00:00.000Z'));

    const prisma = createPrismaMock();
    prisma.chat.findMany.mockResolvedValue([
      createScheduledChannelCandidate({
        id: 'channel-fresh',
        latestAudienceSnapshotAt: new Date('2026-03-07T11:45:00.000Z'),
        lastAudienceSyncAt: new Date('2026-03-07T11:45:00.000Z'),
        lastViewsSyncAt: new Date('2026-03-07T11:45:00.000Z'),
      }),
      createScheduledChannelCandidate({
        id: 'channel-audience-stale',
        latestAudienceSnapshotAt: new Date('2026-03-07T09:30:00.000Z'),
        lastAudienceSyncAt: new Date('2026-03-07T09:30:00.000Z'),
        lastViewsSyncAt: new Date('2026-03-07T11:45:00.000Z'),
      }),
      createScheduledChannelCandidate({
        id: 'channel-views-stale',
        latestAudienceSnapshotAt: new Date('2026-03-07T11:45:00.000Z'),
        lastAudienceSyncAt: new Date('2026-03-07T11:45:00.000Z'),
        lastViewsSyncAt: new Date('2026-03-07T09:30:00.000Z'),
      }),
    ]);
    const maxClient = {
      getChatSnapshot: jest.fn(),
      listMessageSnapshots: jest.fn(),
      ensureWebhookSubscription: jest.fn(),
    };

    const service = new ChannelStatsCollectorService(
      prisma as never,
      maxClient as never,
      createConfigMock() as never,
    );
    const calls: string[] = [];
    const audienceSpy = jest
      .spyOn(service, 'syncAudienceSnapshotIfStale')
      .mockImplementation(async (chatId: string) => {
        calls.push(`audience:${chatId}`);
        return {
          audienceSynced: true,
          throttled: false,
          syncedAt: new Date('2026-03-07T12:00:00.000Z'),
        };
      });
    const syncSpy = jest.spyOn(service, 'syncChannel').mockImplementation(async (chatId) => {
      calls.push(`views:${chatId}`);
      return {
        audienceSynced: false,
        viewsSynced: true,
        throttled: false,
      };
    });

    await service.syncAllChannels('scheduled');

    expect(calls).toEqual(['audience:channel-audience-stale', 'views:channel-views-stale']);
    expect(audienceSpy).toHaveBeenCalledWith(
      'channel-audience-stale',
      expect.objectContaining({
        reason: 'scheduled',
        staleMs: 2 * 60 * 60 * 1000,
      }),
    );
    expect(syncSpy).toHaveBeenCalledWith('channel-views-stale', {
      reason: 'scheduled',
      skipAudience: true,
    });
    expect(maxClient.listMessageSnapshots).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('does not run scheduled views for stale-audience channels that failed catch-up', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-07T12:00:00.000Z'));

    const prisma = createPrismaMock();
    prisma.chat.findMany.mockResolvedValue([
      createScheduledChannelCandidate({
        id: 'channel-stale-audience-and-views',
        latestAudienceSnapshotAt: new Date('2026-03-07T09:30:00.000Z'),
        lastAudienceSyncAt: new Date('2026-03-07T09:30:00.000Z'),
        lastViewsSyncAt: new Date('2026-03-07T09:30:00.000Z'),
      }),
    ]);
    const maxClient = {
      getChatSnapshot: jest.fn(),
      listMessageSnapshots: jest.fn(),
      ensureWebhookSubscription: jest.fn(),
    };

    const service = new ChannelStatsCollectorService(
      prisma as never,
      maxClient as never,
      createConfigMock() as never,
    );
    const audienceSpy = jest.spyOn(service, 'syncAudienceSnapshotIfStale').mockResolvedValue({
      audienceSynced: false,
      throttled: false,
      syncedAt: null,
    });
    const syncSpy = jest.spyOn(service, 'syncChannel').mockResolvedValue({
      audienceSynced: false,
      viewsSynced: true,
      throttled: false,
    });

    await service.syncAllChannels('scheduled');

    expect(audienceSpy).toHaveBeenCalledWith(
      'channel-stale-audience-and-views',
      expect.objectContaining({
        reason: 'scheduled',
      }),
    );
    expect(syncSpy).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('runs bounded recent views discovery before recurring audience catch-up', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-07T12:00:00.000Z'));

    const prisma = createPrismaMock();
    prisma.chat.findMany.mockResolvedValue([
      createScheduledChannelCandidate({
        id: 'channel-stale-audience-and-views',
        latestAudienceSnapshotAt: null,
        lastAudienceSyncAt: null,
        lastViewsSyncAt: new Date('2026-03-07T09:00:00.000Z'),
      }),
    ]);
    const maxClient = {
      getChatSnapshot: jest.fn(),
      listMessageSnapshots: jest.fn(),
      ensureWebhookSubscription: jest.fn(),
    };

    const service = new ChannelStatsCollectorService(
      prisma as never,
      maxClient as never,
      createConfigMock() as never,
    );
    const audienceSpy = jest.spyOn(service, 'syncAudienceSnapshotIfStale').mockResolvedValue({
      audienceSynced: true,
      throttled: false,
      syncedAt: new Date('2026-03-07T12:00:00.000Z'),
    });
    const syncSpy = jest.spyOn(service, 'syncChannel').mockResolvedValue({
      audienceSynced: false,
      viewsSynced: true,
      throttled: false,
    });

    await (
      service as unknown as {
        syncScheduledAudienceCatchUpOnly: (reason: 'scheduled') => Promise<void>;
      }
    ).syncScheduledAudienceCatchUpOnly('scheduled');

    expect(audienceSpy).toHaveBeenCalledWith(
      'channel-stale-audience-and-views',
      expect.objectContaining({
        reason: 'scheduled',
      }),
    );
    expect(syncSpy).toHaveBeenCalledWith('channel-stale-audience-and-views', {
      reason: 'scheduled',
      skipAudience: true,
      maxPages: 2,
      viewsMode: 'discovery',
    });
    expect(prisma.channelPost.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 20 }));

    await service.onModuleDestroy();
  });

  it('requests a bounded slow path for recurring views under MAX capacity pressure', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-07T12:00:00.000Z'));

    const prisma = createPrismaMock();
    prisma.chat.findMany.mockResolvedValue(
      Array.from({ length: 837 }, (_, index) =>
        createScheduledChannelCandidate({
          id: `channel-stale-${String(index + 1).padStart(3, '0')}`,
          latestAudienceSnapshotAt: null,
          lastAudienceSyncAt: null,
          lastViewsSyncAt: new Date('2026-03-07T09:00:00.000Z'),
        }),
      ),
    );
    const maxClient = {
      ensureWebhookSubscription: jest.fn(),
    };
    const backgroundRuntimeGovernorService = {
      decide: jest.fn().mockResolvedValue({
        action: 'slow',
        reason: 'MAX API bot load 80.0%',
        retryAfterMs: 60_000,
      }),
    };
    const service = new ChannelStatsCollectorService(
      prisma as never,
      maxClient as never,
      createConfigMock() as never,
      undefined,
      undefined,
      backgroundRuntimeGovernorService as never,
    );
    jest
      .spyOn(
        service as unknown as {
          resolveInterChannelDelayMs: (reason: 'startup' | 'scheduled') => number;
        },
        'resolveInterChannelDelayMs',
      )
      .mockReturnValue(0);
    const audienceSpy = jest.spyOn(service, 'syncAudienceSnapshotIfStale').mockResolvedValue({
      audienceSynced: true,
      throttled: false,
      syncedAt: new Date('2026-03-07T12:00:00.000Z'),
    });
    const syncSpy = jest.spyOn(service, 'syncChannel').mockResolvedValue({
      audienceSynced: false,
      viewsSynced: true,
      throttled: false,
    });

    await (
      service as unknown as {
        syncScheduledAudienceCatchUpOnly: (reason: 'scheduled') => Promise<void>;
      }
    ).syncScheduledAudienceCatchUpOnly('scheduled');

    expect(backgroundRuntimeGovernorService.decide).toHaveBeenCalledWith({
      component: 'channel-stats',
      sourceTag: MAX_API_SOURCE_TAGS.CHANNEL_STATS_SYNC,
      allowMaxApiCapacitySlowPath: true,
    });
    expect(prisma.channelPost.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 20 }));
    expect(syncSpy.mock.calls.map(([chatId]) => chatId)).toEqual([
      'channel-stale-001',
      'channel-stale-002',
      'channel-stale-003',
      'channel-stale-004',
      'channel-stale-005',
      'channel-stale-006',
    ]);
    for (const [, options] of syncSpy.mock.calls) {
      expect(options).toEqual({
        reason: 'scheduled',
        skipAudience: true,
        maxPages: 2,
        viewsMode: 'discovery',
      });
    }
    expect(audienceSpy.mock.calls.map(([chatId]) => chatId)).toEqual([
      'channel-stale-001',
      'channel-stale-002',
    ]);

    await service.onModuleDestroy();
  });

  it('sizes recurring discovery for a twelve-hour fleet cycle with a hard cap', async () => {
    const service = new ChannelStatsCollectorService(
      createPrismaMock() as never,
      {} as never,
      createConfigMock() as never,
    );
    const resolveLimit = (
      service as unknown as {
        resolvePriorityViewsMaxChannels: (channelCount: number) => number;
      }
    ).resolvePriorityViewsMaxChannels.bind(service);

    expect(resolveLimit(1)).toBe(4);
    expect(resolveLimit(837)).toBe(6);
    expect(resolveLimit(1_728)).toBe(12);
    expect(resolveLimit(2_000)).toBe(12);

    await service.onModuleDestroy();
  });

  it('backs off recurring discovery after MAX throttling and skips audience work', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-07T12:00:00.000Z'));

    const prisma = createPrismaMock();
    prisma.chat.findMany.mockResolvedValue([
      createScheduledChannelCandidate({
        id: 'channel-throttled',
        latestAudienceSnapshotAt: null,
        lastAudienceSyncAt: null,
        lastViewsSyncAt: null,
      }),
    ]);
    const backgroundRuntimeGovernorService = {
      decide: jest.fn().mockResolvedValue({
        action: 'slow',
        reason: 'MAX API stack load 80.0%',
        retryAfterMs: 60_000,
      }),
    };
    const service = new ChannelStatsCollectorService(
      prisma as never,
      {} as never,
      createConfigMock() as never,
      undefined,
      undefined,
      backgroundRuntimeGovernorService as never,
    );
    const syncSpy = jest.spyOn(service, 'syncChannel').mockResolvedValue({
      audienceSynced: false,
      viewsSynced: false,
      throttled: true,
    });
    const audienceSpy = jest.spyOn(service, 'syncAudienceSnapshotIfStale');
    const runPriorityPass = () =>
      (
        service as unknown as {
          syncScheduledAudienceCatchUpOnly: (reason: 'scheduled') => Promise<void>;
        }
      ).syncScheduledAudienceCatchUpOnly('scheduled');

    await runPriorityPass();
    await runPriorityPass();

    expect(syncSpy).toHaveBeenCalledTimes(1);
    expect(audienceSpy).not.toHaveBeenCalled();
    expect(prisma.chat.findMany).toHaveBeenCalledTimes(1);

    await service.onModuleDestroy();
  });

  it('continues recurring discovery after one channel fails before its MAX list call', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-07T12:00:00.000Z'));

    const audienceAt = new Date('2026-03-07T11:45:00.000Z');
    const prisma = createPrismaMock();
    prisma.chat.findMany.mockResolvedValue([
      createScheduledChannelCandidate({
        id: 'channel-a-route-failed',
        latestAudienceSnapshotAt: audienceAt,
        lastAudienceSyncAt: audienceAt,
        lastViewsSyncAt: null,
      }),
      createScheduledChannelCandidate({
        id: 'channel-b-valid',
        latestAudienceSnapshotAt: audienceAt,
        lastAudienceSyncAt: audienceAt,
        lastViewsSyncAt: null,
      }),
    ]);
    const service = new ChannelStatsCollectorService(
      prisma as never,
      {} as never,
      createConfigMock() as never,
    );
    jest
      .spyOn(
        service as unknown as {
          resolveInterChannelDelayMs: (reason: 'startup' | 'scheduled') => number;
        },
        'resolveInterChannelDelayMs',
      )
      .mockReturnValue(0);
    const syncSpy = jest
      .spyOn(service, 'syncChannel')
      .mockRejectedValueOnce(new Error('route cache unavailable'))
      .mockResolvedValueOnce({
        audienceSynced: false,
        viewsSynced: true,
        throttled: false,
      });

    await (
      service as unknown as {
        syncScheduledAudienceCatchUpOnly: (reason: 'scheduled') => Promise<void>;
      }
    ).syncScheduledAudienceCatchUpOnly('scheduled');

    expect(syncSpy.mock.calls.map(([chatId]) => chatId)).toEqual([
      'channel-a-route-failed',
      'channel-b-valid',
    ]);
    expect(prisma.channelStatsSyncState.upsert).toHaveBeenCalledWith({
      where: { chatId: 'channel-a-route-failed' },
      create: {
        chatId: 'channel-a-route-failed',
        lastViewsAttemptAt: new Date('2026-03-07T12:00:00.000Z'),
      },
      update: { lastViewsAttemptAt: new Date('2026-03-07T12:00:00.000Z') },
    });

    await service.onModuleDestroy();
  });

  it('rotates recurring views after failed attempts using the durable attempt cursor', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-07T12:00:00.000Z'));

    const audienceAt = new Date('2026-03-07T11:45:00.000Z');
    const prisma = createPrismaMock();
    prisma.chat.findMany.mockResolvedValue([
      createScheduledChannelCandidate({
        id: 'channel-a-recent-failure',
        latestAudienceSnapshotAt: audienceAt,
        lastAudienceSyncAt: audienceAt,
        lastViewsSyncAt: new Date('2026-03-07T09:00:00.000Z'),
        lastViewsAttemptAt: new Date('2026-03-07T11:59:00.000Z'),
      }),
      ...Array.from({ length: 4 }, (_, index) =>
        createScheduledChannelCandidate({
          id: `channel-${String.fromCharCode(98 + index)}-older-failure`,
          latestAudienceSnapshotAt: audienceAt,
          lastAudienceSyncAt: audienceAt,
          lastViewsSyncAt: new Date('2026-03-07T09:00:00.000Z'),
          lastViewsAttemptAt: new Date(`2026-03-07T11:5${index}:00.000Z`),
        }),
      ),
    ]);
    const service = new ChannelStatsCollectorService(
      prisma as never,
      {} as never,
      createConfigMock() as never,
    );
    jest
      .spyOn(
        service as unknown as {
          resolveInterChannelDelayMs: (reason: 'startup' | 'scheduled') => number;
        },
        'resolveInterChannelDelayMs',
      )
      .mockReturnValue(0);
    const syncSpy = jest.spyOn(service, 'syncChannel').mockResolvedValue({
      audienceSynced: false,
      viewsSynced: false,
      throttled: false,
    });

    await (
      service as unknown as {
        syncScheduledAudienceCatchUpOnly: (reason: 'scheduled') => Promise<void>;
      }
    ).syncScheduledAudienceCatchUpOnly('scheduled');

    expect(syncSpy.mock.calls.map(([chatId]) => chatId)).toEqual([
      'channel-b-older-failure',
      'channel-c-older-failure',
      'channel-d-older-failure',
      'channel-e-older-failure',
    ]);
    expect(syncSpy).not.toHaveBeenCalledWith('channel-a-recent-failure', expect.anything());

    await service.onModuleDestroy();
  });

  it('keeps recurring views paused for non-capacity governor pressure', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findMany.mockResolvedValue([
      createScheduledChannelCandidate({
        id: 'channel-1',
        latestAudienceSnapshotAt: null,
        lastAudienceSyncAt: null,
        lastViewsSyncAt: null,
      }),
    ]);
    const backgroundRuntimeGovernorService = {
      decide: jest.fn().mockResolvedValue({
        action: 'pause',
        reason: 'user-facing queue lag 12.0s',
        retryAfterMs: 60_000,
      }),
    };
    const service = new ChannelStatsCollectorService(
      prisma as never,
      {} as never,
      createConfigMock() as never,
      undefined,
      undefined,
      backgroundRuntimeGovernorService as never,
    );
    const syncSpy = jest.spyOn(service, 'syncChannel');

    await (
      service as unknown as {
        syncScheduledAudienceCatchUpOnly: (reason: 'scheduled') => Promise<void>;
      }
    ).syncScheduledAudienceCatchUpOnly('scheduled');

    expect(backgroundRuntimeGovernorService.decide).toHaveBeenCalledWith({
      component: 'channel-stats',
      sourceTag: MAX_API_SOURCE_TAGS.CHANNEL_STATS_SYNC,
      allowMaxApiCapacitySlowPath: true,
    });
    expect(prisma.channelPost.findMany).not.toHaveBeenCalled();
    expect(prisma.chat.findMany).not.toHaveBeenCalled();
    expect(syncSpy).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('limits scheduled heavy views work independently from audience catch-up', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-07T12:00:00.000Z'));

    const freshAt = new Date('2026-03-07T11:45:00.000Z');
    const prisma = createPrismaMock();
    prisma.chat.findMany.mockResolvedValue([
      createScheduledChannelCandidate({
        id: 'audience-missing-1',
        latestAudienceSnapshotAt: null,
        lastAudienceSyncAt: null,
        lastViewsSyncAt: freshAt,
      }),
      createScheduledChannelCandidate({
        id: 'audience-missing-2',
        latestAudienceSnapshotAt: null,
        lastAudienceSyncAt: null,
        lastViewsSyncAt: freshAt,
      }),
      ...Array.from({ length: 7 }, (_, index) =>
        createScheduledChannelCandidate({
          id: `views-missing-${index + 1}`,
          latestAudienceSnapshotAt: freshAt,
          lastAudienceSyncAt: freshAt,
          lastViewsSyncAt: null,
        }),
      ),
    ]);
    const maxClient = {
      getChatSnapshot: jest.fn(),
      listMessageSnapshots: jest.fn(),
      ensureWebhookSubscription: jest.fn(),
    };

    const service = new ChannelStatsCollectorService(
      prisma as never,
      maxClient as never,
      createConfigMock() as never,
    );
    jest
      .spyOn(
        service as unknown as {
          resolveInterChannelDelayMs: (reason: 'startup' | 'scheduled') => number;
        },
        'resolveInterChannelDelayMs',
      )
      .mockReturnValue(0);
    const audienceSpy = jest.spyOn(service, 'syncAudienceSnapshotIfStale').mockResolvedValue({
      audienceSynced: true,
      throttled: false,
      syncedAt: new Date('2026-03-07T12:00:00.000Z'),
    });
    const syncSpy = jest.spyOn(service, 'syncChannel').mockResolvedValue({
      audienceSynced: false,
      viewsSynced: true,
      throttled: false,
    });

    await service.syncAllChannels('scheduled');

    expect(audienceSpy).toHaveBeenCalledTimes(2);
    expect(audienceSpy.mock.calls.map(([chatId]) => chatId)).toEqual([
      'audience-missing-1',
      'audience-missing-2',
    ]);
    expect(syncSpy).toHaveBeenCalledTimes(6);
    expect(syncSpy.mock.calls.map(([chatId]) => chatId)).toEqual([
      'views-missing-1',
      'views-missing-2',
      'views-missing-3',
      'views-missing-4',
      'views-missing-5',
      'views-missing-6',
    ]);
    for (const [, options] of syncSpy.mock.calls) {
      expect(options).toEqual({
        reason: 'scheduled',
        skipAudience: true,
      });
    }

    await service.onModuleDestroy();
  });

  it('pauses scheduled background sync while the shared system mode is degraded', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findMany.mockResolvedValue([{ id: 'channel-1' }]);
    const maxClient = {
      ensureWebhookSubscription: jest.fn(),
    };
    const systemModeService = {
      getEffectiveSnapshot: jest.fn().mockResolvedValue({
        mode: 'degrade',
        source: 'auto',
        reason: 'queue lag 22.0s',
        updatedAt: new Date().toISOString(),
        manualMode: null,
        queueLagSec: 22,
        action: {
          windowSec: 60,
          total: 200,
          success: 190,
          failure: 10,
          critical: 0,
          errorRate: 0.05,
          criticalRate: 0,
        },
      }),
    };

    const service = new ChannelStatsCollectorService(
      prisma as never,
      maxClient as never,
      createConfigMock() as never,
      systemModeService as never,
    );
    const syncSpy = jest.spyOn(service, 'syncChannel');

    await service.syncAllChannels('scheduled');

    expect(systemModeService.getEffectiveSnapshot).toHaveBeenCalled();
    expect(prisma.chat.findMany).not.toHaveBeenCalled();
    expect(syncSpy).not.toHaveBeenCalled();
    expect(maxClient.ensureWebhookSubscription).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('does not pause scheduled background sync during the recovery window', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findMany.mockResolvedValue([]);
    const maxClient = {
      ensureWebhookSubscription: jest.fn(),
    };
    const systemModeService = {
      getEffectiveSnapshot: jest.fn().mockResolvedValue({
        mode: 'degrade',
        source: 'auto',
        reason: 'recovery window in progress',
        updatedAt: new Date().toISOString(),
        manualMode: null,
        queueLagSec: 0,
        action: {
          windowSec: 60,
          total: 20,
          success: 20,
          failure: 0,
          critical: 0,
          errorRate: 0,
          criticalRate: 0,
        },
      }),
    };

    const service = new ChannelStatsCollectorService(
      prisma as never,
      maxClient as never,
      createConfigMock() as never,
      systemModeService as never,
    );
    const syncSpy = jest.spyOn(service, 'syncChannel');

    await service.syncAllChannels('scheduled');

    expect(systemModeService.getEffectiveSnapshot).toHaveBeenCalled();
    expect(prisma.chat.findMany).toHaveBeenCalled();
    expect(syncSpy).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('runs limited audience-only catch-up when the runtime governor asks to slow down', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-07T12:00:00.000Z'));

    const prisma = createPrismaMock();
    prisma.chat.findMany.mockResolvedValue(
      Array.from({ length: 31 }, (_, index) =>
        createScheduledChannelCandidate({
          id: `channel-stale-${String(index + 1).padStart(2, '0')}`,
          latestAudienceSnapshotAt: null,
          lastAudienceSyncAt: null,
          lastViewsSyncAt: null,
        }),
      ),
    );
    const maxClient = {
      ensureWebhookSubscription: jest.fn(),
    };
    const backgroundRuntimeGovernorService = {
      decide: jest.fn().mockResolvedValue({
        action: 'slow',
        reason: 'MAX API bot load 26.7%',
        retryAfterMs: 90_000,
      }),
    };

    const service = new ChannelStatsCollectorService(
      prisma as never,
      maxClient as never,
      createConfigMock() as never,
      undefined,
      undefined,
      backgroundRuntimeGovernorService as never,
    );
    jest
      .spyOn(
        service as unknown as {
          resolveInterChannelDelayMs: (reason: 'startup' | 'scheduled') => number;
        },
        'resolveInterChannelDelayMs',
      )
      .mockReturnValue(0);
    const audienceSpy = jest.spyOn(service, 'syncAudienceSnapshotIfStale').mockResolvedValue({
      audienceSynced: true,
      throttled: false,
      syncedAt: new Date('2026-03-07T12:00:00.000Z'),
    });
    const syncSpy = jest.spyOn(service, 'syncChannel').mockResolvedValue({
      audienceSynced: false,
      viewsSynced: true,
      throttled: false,
    });

    await service.syncAllChannels('scheduled');

    expect(backgroundRuntimeGovernorService.decide).toHaveBeenCalledWith({
      component: 'channel-stats',
      sourceTag: MAX_API_SOURCE_TAGS.CHANNEL_STATS_SYNC,
    });
    expect(audienceSpy).toHaveBeenCalledTimes(30);
    expect(audienceSpy.mock.calls.map(([chatId]) => chatId)).toEqual(
      Array.from(
        { length: 30 },
        (_, index) => `channel-stale-${String(index + 1).padStart(2, '0')}`,
      ),
    );
    expect(syncSpy).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });
});
