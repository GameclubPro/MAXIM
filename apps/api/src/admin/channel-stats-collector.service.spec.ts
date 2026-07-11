import { MAX_API_SOURCE_TAGS } from '../max/max-client.service';
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
  syncStateMissing?: boolean;
}) {
  return {
    id: params.id,
    channelStatsSyncState: params.syncStateMissing
      ? null
      : {
          lastAudienceSyncAt: params.lastAudienceSyncAt ?? null,
          lastViewsSyncAt: params.lastViewsSyncAt ?? null,
        },
    channelAudienceSnapshots: params.latestAudienceSnapshotAt
      ? [{ capturedAt: params.latestAudienceSnapshotAt }]
      : [],
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

  it('runs recurring audience catch-up without heavy views work', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-07T12:00:00.000Z'));

    const prisma = createPrismaMock();
    prisma.chat.findMany.mockResolvedValue([
      createScheduledChannelCandidate({
        id: 'channel-stale-audience-and-views',
        latestAudienceSnapshotAt: null,
        lastAudienceSyncAt: null,
        lastViewsSyncAt: null,
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
