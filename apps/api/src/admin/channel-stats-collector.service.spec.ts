import { ChannelStatsCollectorService } from './channel-stats-collector.service';

jest.mock('ioredis', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => {
    const store = new Map<string, string>();
    return {
      set: jest.fn().mockImplementation(async (key: string, value: string, mode?: string) => {
        if (mode === 'PX') {
          if (store.has(key)) {
            return null;
          }
          store.set(key, String(value));
          return 'OK';
        }

        store.set(key, String(value));
        return 'OK';
      }),
      get: jest.fn().mockImplementation(async (key: string) => store.get(key) ?? null),
      del: jest.fn().mockImplementation(async (...keys: string[]) => {
        let deleted = 0;
        for (const key of keys) {
          if (store.delete(key)) {
            deleted += 1;
          }
        }
        return deleted;
      }),
      eval: jest.fn().mockImplementation(async (_script: string, _keyCount: number, key: string) => {
        if (store.has(key)) {
          store.delete(key);
          return 1;
        }
        return 0;
      }),
      quit: jest.fn().mockResolvedValue(undefined),
    };
  }),
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

function createConfigMock() {
  return {
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
    const syncSpy = jest.spyOn(service, 'syncChannel').mockResolvedValue(undefined);

    await service.syncChannelIfStale('channel-1');

    expect(syncSpy).not.toHaveBeenCalled();
    await service.onModuleDestroy();
  });

  it('backs off repeated audience snapshot sync when MAX reports chat.not.found', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-07T12:00:00.000Z'));

    const prisma = createPrismaMock();
    const maxClient = {
      getChatSnapshot: jest.fn().mockRejectedValue({
        response: {
          status: 404,
          data: {
            code: 'chat.not.found',
            message: 'Chat channel-404 not found',
          },
        },
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
      createConfigMock() as never,
    );

    await service.syncChannel('channel-404', { reason: 'manual' });
    await service.syncChannel('channel-404', { reason: 'manual' });

    expect(maxClient.getChatSnapshot).toHaveBeenCalledTimes(1);
    expect(maxClient.listMessageSnapshots).toHaveBeenCalledTimes(2);
    expect(prisma.channelAudienceSnapshot.create).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });
});
