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

type Metric = 'AUDIENCE' | 'REACH' | 'PUBLICATION_HOUR';
function fixture(owns: (input: { entityId: string; metrics: Metric[] }) => Promise<boolean>) {
  const prisma = {
    chat: { update: jest.fn().mockResolvedValue(undefined) },
    channelAudienceSnapshot: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue(undefined),
    },
    channelStatsSyncState: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue(undefined),
    },
    channelPost: {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    $transaction: jest.fn((queries: Promise<unknown>[]) => Promise.all(queries)),
  };
  const max = {
    getChatSnapshot: jest.fn().mockResolvedValue({
      title: 'Synthetic channel',
      participantsCount: 25,
      status: 'active',
      isPublic: true,
      link: null,
      lastEventAt: null,
    }),
    listMessageSnapshots: jest.fn().mockResolvedValue([]),
    getMessageSnapshot: jest.fn().mockResolvedValue(null),
    ensureWebhookSubscription: jest.fn().mockResolvedValue({}),
  };
  const owner = { hasHealthyCollectionOwner: jest.fn(owns) };
  const config = {
    get: (_key: string, fallback: unknown) => fallback,
    getOrThrow: () => 'redis://localhost:6379/0',
  };
  const service = new ChannelStatsCollectorService(
    prisma as never,
    max as never,
    config as never,
    undefined,
    undefined,
    undefined,
    owner as never,
  );
  const milestones = (posts = ['post-24', 'post-48']) => {
    prisma.channelPost.findMany.mockResolvedValue(
      posts.map((id) => ({ id, chatId: '-100', messageId: id })),
    );
    return (
      service as unknown as { syncDuePostViewMilestones(now: Date): Promise<boolean> }
    ).syncDuePostViewMilestones(new Date());
  };
  return { prisma, max, owner, service, milestones };
}

describe('ChannelStatsCollectorService shared collection ownership', () => {
  it('skips owned audience/history calls without inventing a native observation or coverage', async () => {
    const f = fixture(async () => true);
    try {
      const result = await f.service.syncChannel('-100');
      expect(result).toEqual({ audienceSynced: false, viewsSynced: false, throttled: false });
      expect(f.max.getChatSnapshot).not.toHaveBeenCalled();
      expect(f.max.listMessageSnapshots).not.toHaveBeenCalled();
      expect(f.prisma.channelAudienceSnapshot.create).not.toHaveBeenCalled();
      expect(f.prisma.channelStatsSyncState.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            lastAudienceSyncAt: null,
            lastViewsSyncAt: null,
            lastViewsDiscoveryAt: null,
            lastViewsAttemptAt: null,
            viewsCoverageFrom: null,
          }),
          update: expect.not.objectContaining({ lastAudienceSyncAt: expect.anything() }),
        }),
      );
      expect(f.owner.hasHealthyCollectionOwner).toHaveBeenCalledWith({
        entityId: '-100',
        metrics: ['AUDIENCE'],
      });
      expect(f.owner.hasHealthyCollectionOwner).toHaveBeenCalledWith({
        entityId: '-100',
        metrics: ['REACH'],
      });
    } finally {
      await f.service.onModuleDestroy();
    }
  });

  it('audience ownership leaves post history and due milestones on their native paths', async () => {
    const f = fixture(async ({ metrics }) => metrics.every((metric) => metric === 'AUDIENCE'));
    try {
      await f.service.syncChannel('-100');
      await f.milestones();
      expect(f.max.getChatSnapshot).not.toHaveBeenCalled();
      expect(f.max.listMessageSnapshots).toHaveBeenCalledTimes(1);
      expect(f.max.getMessageSnapshot).toHaveBeenCalledTimes(2);
    } finally {
      await f.service.onModuleDestroy();
    }
  });

  it.each(['REACH', 'PUBLICATION_HOUR'] as const)(
    'uses post ownership for %s only when the healthy REACH proof covers the derived history',
    async (metric) => {
      const f = fixture(async ({ metrics }) => metrics.every((item) => item === metric));
      try {
        await f.service.syncChannel('-100');
        await f.milestones();
        expect(f.max.getChatSnapshot).toHaveBeenCalledTimes(1);
        expect(f.max.listMessageSnapshots).toHaveBeenCalledTimes(metric === 'REACH' ? 0 : 1);
        expect(f.max.getMessageSnapshot).toHaveBeenCalledTimes(metric === 'REACH' ? 0 : 2);
        if (metric === 'REACH') expect(f.prisma.channelPost.updateMany).not.toHaveBeenCalled();
      } finally {
        await f.service.onModuleDestroy();
      }
    },
  );

  it('opportunistic audience refresh also honors a healthy owner without marking a synthetic refresh', async () => {
    const f = fixture(async () => true);
    try {
      const result = await f.service.syncAudienceSnapshotIfStale('-100', {
        reason: 'stats_endpoint',
        markOpportunistic: true,
      });
      expect(result.audienceSynced).toBe(false);
      expect(result.syncedAt).toBeNull();
      expect(f.max.getChatSnapshot).not.toHaveBeenCalled();
      expect(f.prisma.channelStatsSyncState.upsert).not.toHaveBeenCalled();
    } finally {
      await f.service.onModuleDestroy();
    }
  });

  it('resumes the previous paths after owner expiry and never suppresses a different entity', async () => {
    let healthy = true;
    const f = fixture(async ({ entityId }) => healthy && entityId === '-100');
    try {
      await f.service.syncChannel('-100');
      await f.service.syncChannel('-200');
      expect(f.max.getChatSnapshot).toHaveBeenCalledTimes(1);
      expect(f.max.getChatSnapshot).toHaveBeenLastCalledWith('-200', expect.anything());
      expect(f.max.listMessageSnapshots).toHaveBeenCalledTimes(1);
      healthy = false;
      await f.service.syncChannel('-100');
      await f.milestones();
      expect(f.max.getChatSnapshot).toHaveBeenCalledTimes(2);
      expect(f.max.listMessageSnapshots).toHaveBeenCalledTimes(2);
      expect(f.max.getMessageSnapshot).toHaveBeenCalledTimes(2);
    } finally {
      await f.service.onModuleDestroy();
    }
  });

  it('an unavailable ownership proof cannot disable the previous collector', async () => {
    const f = fixture(async () => {
      throw new Error('Synthetic proof outage');
    });
    try {
      await f.service.syncChannel('-100');
      await f.milestones();
      expect(f.max.getChatSnapshot).toHaveBeenCalledTimes(1);
      expect(f.max.listMessageSnapshots).toHaveBeenCalledTimes(1);
      expect(f.max.getMessageSnapshot).toHaveBeenCalledTimes(2);
    } finally {
      await f.service.onModuleDestroy();
    }
  });

  it('checks ownership again before each milestone request and does not mark delegated posts as attempted', async () => {
    let checks = 0;
    const f = fixture(async () => ++checks >= 3);
    try {
      await f.milestones();
      expect(f.max.getMessageSnapshot).toHaveBeenCalledTimes(1);
      expect(f.max.getMessageSnapshot).toHaveBeenCalledWith('-100', 'post-24', expect.anything());
      expect(f.prisma.channelPost.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['post-24'] } },
        data: { viewMilestoneLastAttemptAt: expect.any(Date) },
      });
    } finally {
      await f.service.onModuleDestroy();
    }
  });
});
