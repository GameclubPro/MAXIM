import { VkParsingOwnerProfile } from '../prisma/prisma-client';
import { VkSourceService } from './vk-source.service';

type CleanupQuery = {
  where: Record<string, unknown> & { OR?: Array<Record<string, unknown>> };
  data: Record<string, unknown>;
};

describe('VkSourceService autopublish cleanup', () => {
  function createSource(overrides: Record<string, unknown> = {}) {
    return {
      id: 'source-1',
      chatId: 'channel-1',
      ownerProfile: VkParsingOwnerProfile.PUBLISHER,
      ownerBotId: 'publisher-bot',
      status: 'ACTIVE',
      importEnabled: true,
      autoPublishEnabled: true,
      autoPublishEnabledAt: new Date('2026-09-04T09:00:00.000Z'),
      autoPublishPausedAt: null,
      autoPublishPausedReason: null,
      publishIntervalMinutes: 30,
      dailyLimit: 12,
      minPublishIntervalMinutes: 15,
      publishMode: 'QUEUE',
      priority: 'NORMAL',
      quietHoursStart: null,
      quietHoursEnd: null,
      ...overrides,
    };
  }

  function createFixture() {
    const source = createSource();
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'channel-1' }]),
      $transaction: jest.fn(),
      vkParsingSource: {
        findFirst: jest.fn().mockResolvedValue(source),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue(source),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      vkParsingSettings: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
      vkParsingPost: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      auditLog: {
        create: jest.fn().mockResolvedValue({ id: 'audit-1' }),
      },
    };
    prisma.$transaction.mockImplementation(async (operation: (tx: typeof prisma) => unknown) =>
      operation(prisma),
    );
    const feedService = {
      buildFeed: jest.fn().mockResolvedValue({}),
    };
    const syncQueue = {
      add: jest.fn().mockResolvedValue(undefined),
      getJob: jest.fn().mockResolvedValue(null),
    };
    const configService = {
      get: jest.fn().mockReturnValue(undefined),
    };
    const ownership = {
      getPublisherScope: jest.fn().mockReturnValue({
        ownerProfile: VkParsingOwnerProfile.PUBLISHER,
        ownerBotId: 'publisher-bot',
      }),
    };
    const service = new VkSourceService(
      prisma as never,
      feedService as never,
      {} as never,
      syncQueue as never,
      configService as never,
      ownership as never,
    );

    return { prisma, service };
  }

  function expectCleanupQuery(query: CleanupQuery | undefined, sourceIds: string[]): void {
    expect(query).toBeDefined();
    expect(query?.where).toEqual(
      expect.objectContaining({
        chatId: 'channel-1',
        ownerProfile: VkParsingOwnerProfile.PUBLISHER,
        ownerBotId: 'publisher-bot',
        sourceId: { in: sourceIds },
        status: { in: ['NEW', 'FAILED'] },
        publishLockedAt: null,
        publishAttemptCount: 0,
      }),
    );
    expect(query?.where).not.toHaveProperty('publishReason');
    expect(query?.where.OR).toEqual([
      {
        publishReason: 'autopublish',
        OR: [
          { publishQueuedAt: { not: null } },
          { publishIdempotencyKey: { not: null } },
          { publishScheduledAt: { not: null } },
        ],
      },
      {
        publishScheduleFingerprint: { not: null },
        publishQueuedAt: null,
        publishLockedAt: null,
        publishIdempotencyKey: null,
        publishReason: null,
        publishScheduledAt: null,
        publishCancelledAt: null,
        publishCancelledByUserId: null,
        publishActorUserId: null,
        dispatchBlockerCode: null,
        dispatchBlockedAt: null,
      },
    ]);
    expect(query?.data).toEqual({
      publishQueuedAt: null,
      publishLockedAt: null,
      publishIdempotencyKey: null,
      publishReason: null,
      publishScheduledAt: null,
      publishScheduleFingerprint: null,
    });
  }

  it.each([
    ['disabled Auto', { autoPublishEnabled: false }],
    ['paused imports', { importEnabled: false }],
    ['review mode', { publishMode: 'REVIEW' }],
  ])('clears queued Auto work and unqueued pending markers for %s', async (_label, patch) => {
    const { prisma, service } = createFixture();

    await service.updateSource('channel-1', 'source-1', { userId: 'admin-1' }, patch);

    expectCleanupQuery(prisma.vkParsingPost.updateMany.mock.calls[0]?.[0], ['source-1']);
  });

  it('clears queued Auto work and pending markers for a deduplicated REVIEW preset', async () => {
    const { prisma, service } = createFixture();

    await service.applyBulkPreset(
      'channel-1',
      { userId: 'admin-1' },
      {
        sourceIds: ['source-1', 'source-1', 'source-2'],
        preset: 'REVIEW',
      },
    );

    expectCleanupQuery(prisma.vkParsingPost.updateMany.mock.calls[0]?.[0], [
      'source-1',
      'source-2',
    ]);
  });

  it.each(['NEWS', 'SLOW', 'CLEAN'] as const)(
    'does not clear pending markers for the %s preset',
    async (preset) => {
      const { prisma, service } = createFixture();

      await service.applyBulkPreset(
        'channel-1',
        { userId: 'admin-1' },
        {
          sourceIds: ['source-1'],
          preset,
        },
      );

      expect(prisma.vkParsingPost.updateMany).not.toHaveBeenCalled();
    },
  );

  it('clears queued Auto work and unqueued pending markers when a source is removed', async () => {
    const { prisma, service } = createFixture();

    await service.removeSource('channel-1', 'source-1');

    expectCleanupQuery(prisma.vkParsingPost.updateMany.mock.calls[0]?.[0], ['source-1']);
  });

  it('rejects enabling a source whose quiet window covers the global work window', async () => {
    const { prisma, service } = createFixture();
    prisma.vkParsingSource.findFirst.mockResolvedValue(
      createSource({
        autoPublishEnabled: false,
        autoPublishEnabledAt: null,
        autoPublishPausedAt: new Date('2026-09-04T08:00:00.000Z'),
        autoPublishPausedReason: 'manual',
        quietHoursStart: '09:00',
        quietHoursEnd: '18:00',
      }),
    );
    prisma.vkParsingSettings.findUnique.mockResolvedValue({
      autoPublishEnabled: true,
      schedulerTimezone: 'UTC',
      workHoursStart: '09:00',
      workHoursEnd: '18:00',
      quietHoursStart: null,
      quietHoursEnd: null,
    });

    await expect(
      service.updateSource(
        'channel-1',
        'source-1',
        { userId: 'admin-1' },
        {
          autoPublishEnabled: true,
        },
      ),
    ).rejects.toThrow('Рабочее время полностью перекрыто паузами публикации.');

    expect(prisma.vkParsingSource.update).not.toHaveBeenCalled();
  });

  it('rejects an Auto preset that would activate a source without a valid slot', async () => {
    const { prisma, service } = createFixture();
    prisma.vkParsingSource.findMany.mockResolvedValue([
      createSource({ quietHoursStart: '09:00', quietHoursEnd: '18:00' }),
    ]);
    prisma.vkParsingSettings.findUnique.mockResolvedValue({
      autoPublishEnabled: true,
      schedulerTimezone: 'UTC',
      workHoursStart: '09:00',
      workHoursEnd: '18:00',
      quietHoursStart: null,
      quietHoursEnd: null,
    });

    await expect(
      service.applyBulkPreset(
        'channel-1',
        { userId: 'admin-1' },
        { sourceIds: ['source-1'], preset: 'NEWS' },
      ),
    ).rejects.toThrow('Рабочее время полностью перекрыто паузами публикации.');

    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});
