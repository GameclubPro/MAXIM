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
      upsert: jest.fn().mockResolvedValue({ id: 'post-1' }),
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
          views: 120,
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
          views: 260,
          reactions: [{ emoji: '❤️', count: 6 }],
        },
      ]),
      ensureWebhookSubscription: jest.fn().mockResolvedValue({
        url: 'https://maxim.play-team.ru/api/webhook/max/test/secret',
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

    expect(maxClient.ensureWebhookSubscription).toHaveBeenCalled();
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
          latestReactions: [
            { emoji: '🔥', count: 4 },
            { emoji: '👍', count: 2 },
          ],
        }),
        update: expect.objectContaining({
          latestReactionsTotal: 6,
          latestReactions: [
            { emoji: '🔥', count: 4 },
            { emoji: '👍', count: 2 },
          ],
        }),
      }),
    );
    expect(prisma.channelPostViewSnapshot.create).toHaveBeenCalledTimes(2);
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

  it('backs off background startup sync after MAX API throttling', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-07T12:00:00.000Z'));

    const prisma = createPrismaMock();
    prisma.chat.findMany.mockResolvedValue([{ id: 'channel-1' }]);
    const maxClient = {
      ensureWebhookSubscription: jest.fn().mockResolvedValue({
        url: 'https://maxim.play-team.ru/api/webhook/max/test/secret',
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
        url: 'https://maxim.play-team.ru/api/webhook/max/test/secret',
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

    const startupSync = (service as unknown as { syncStartupChannels: () => Promise<void> }).syncStartupChannels();
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
      .spyOn(service as unknown as { syncStartupChannels: () => Promise<void> }, 'syncStartupChannels')
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
        url: 'https://maxim.play-team.ru/api/webhook/max/test/secret',
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
      }),
    );

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
});
