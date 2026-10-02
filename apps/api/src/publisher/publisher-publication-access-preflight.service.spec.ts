import { ChatEntityType } from '../prisma/prisma-client';
import { PublisherPublicationAccessPreflightService } from './publisher-publication-access-preflight.service';
import { PublisherBackgroundWorkCoordinatorService } from './publisher-background-work-coordinator.service';

function harness(
  enabled = true,
  paused = false,
  backgroundWork = { runExclusive: (_lane: string, fn: () => Promise<void>) => fn() },
) {
  const now = new Date();
  const occurrence = {
    id: 'occurrence-1',
    publicationId: 'publication-1',
    scheduledAt: new Date(now.getTime() + 120_000),
    publication: { actorUserId: 'author-1' },
    scheduleRevision: 1,
    accessPreflightPosition: null as number | null,
    accessPreflightCycleStartedAt: null as Date | null,
  };
  const prisma = {
    publicationOccurrence: {
      findFirst: jest.fn().mockResolvedValueOnce(occurrence).mockResolvedValue(null),
      updateMany: jest.fn().mockImplementation(async ({ data }) => {
        Object.assign(occurrence, data);
        return { count: 1 };
      }),
    },
    publicationTarget: {
      findMany: jest
        .fn()
        .mockResolvedValue([
          { targetChatId: 'chat-1', entityType: ChatEntityType.CHAT, position: 0 },
        ]),
    },
  };
  const readiness = {
    requestBotAccessRefresh: jest.fn().mockResolvedValue(undefined),
    requestActorAccessRefresh: jest.fn().mockResolvedValue(undefined),
  };
  const queue = { preparationTargetBudget: jest.fn().mockResolvedValue(4) };
  const createService = () =>
    new PublisherPublicationAccessPreflightService(
      prisma as never,
      readiness as never,
      { getBotId: () => 'publik' } as never,
      { dispatchEnabled: enabled } as never,
      { isGloballyPaused: async () => paused } as never,
      backgroundWork as never,
      queue as never,
    );
  return { service: createService(), createService, prisma, readiness, occurrence, queue };
}

describe('PublisherPublicationAccessPreflightService', () => {
  it('does not coalesce preflight with a different binding scheduler operation', async () => {
    const backgroundWork = new PublisherBackgroundWorkCoordinatorService();
    let release!: () => void;
    const binding = backgroundWork.runExclusive(
      'binding_refresh',
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await Promise.resolve();
    const f = harness(true, false, backgroundWork as never);
    const preflight = f.service.runOnce();
    expect(f.readiness.requestBotAccessRefresh).not.toHaveBeenCalled();
    release();
    await Promise.all([binding, preflight]);
    expect(f.readiness.requestBotAccessRefresh).toHaveBeenCalledTimes(1);
    backgroundWork.onModuleDestroy();
  });
  it('nominates exact bot and author checks before the publication deadline without sending', async () => {
    const f = harness();
    await f.service.runOnce();
    expect(f.readiness.requestBotAccessRefresh).toHaveBeenCalledWith(
      [{ chatId: 'chat-1', entityType: 'chat' }],
      'publik',
      expect.any(Date),
      { publicationUrgentAt: expect.any(Date), strictEnqueue: true },
    );
    expect(f.readiness.requestActorAccessRefresh).toHaveBeenCalledWith(
      [{ chatId: 'chat-1', entityType: 'chat' }],
      'author-1',
      'publik',
      { maxAgeMs: expect.any(Number), publicationUrgentAt: expect.any(Date), strictEnqueue: true },
    );
    expect(f.prisma.publicationOccurrence.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          requiredBotId: 'publik',
          status: 'SCHEDULED',
          scheduledAt: { gte: expect.any(Date), lte: expect.any(Date) },
        }),
      }),
    );
  });

  it.each([
    [false, false],
    [true, true],
  ])('avoids all scans with enabled=%s paused=%s', async (enabled, paused) => {
    const f = harness(enabled, paused);
    await f.service.runOnce();
    expect(f.prisma.publicationOccurrence.findFirst).not.toHaveBeenCalled();
    expect(f.readiness.requestBotAccessRefresh).not.toHaveBeenCalled();
  });

  it('continues a large fanout with a bounded target cursor on the next tick', async () => {
    const f = harness();
    f.prisma.publicationOccurrence.findFirst.mockReset().mockResolvedValue(f.occurrence);
    f.prisma.publicationTarget.findMany
      .mockResolvedValueOnce(
        Array.from({ length: 101 }, (_, position) => ({
          targetChatId: `chat-${position}`,
          entityType: ChatEntityType.CHAT,
          position,
        })),
      )
      .mockResolvedValueOnce([]);
    await f.service.runOnce();
    expect(f.readiness.requestBotAccessRefresh.mock.calls[0][0]).toHaveLength(2);
    f.prisma.publicationOccurrence.findFirst
      .mockResolvedValueOnce(f.occurrence)
      .mockResolvedValue(null);
    await f.createService().runOnce();
    expect(f.prisma.publicationTarget.findMany.mock.calls[1][0].where).toEqual({
      publicationId: 'publication-1',
      position: { gt: 1 },
    });
  });

  it('does not overlap nominations when a previous tick is waiting on Redis', async () => {
    const f = harness();
    let release!: () => void;
    f.readiness.requestBotAccessRefresh.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const running = f.service.runOnce();
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    await f.service.runOnce();
    expect(f.readiness.requestBotAccessRefresh).toHaveBeenCalledTimes(1);
    release();
    await running;
  });
  it('does not scan or advance durable progress while reserved queue capacity is exhausted', async () => {
    const f = harness();
    f.queue.preparationTargetBudget.mockResolvedValue(0);
    await f.service.runOnce();
    expect(f.prisma.publicationOccurrence.findFirst).not.toHaveBeenCalled();
    expect(f.prisma.publicationOccurrence.updateMany).not.toHaveBeenCalled();
  });

  it('keeps the same page recoverable if the actor Redis acknowledgement fails', async () => {
    const f = harness();
    f.readiness.requestActorAccessRefresh.mockRejectedValue(new Error('Redis unavailable'));
    await f.service.runOnce();
    expect(f.prisma.publicationOccurrence.updateMany).not.toHaveBeenCalled();
    expect(f.occurrence.accessPreflightPosition).toBeNull();
  });

  it('visits the next author while the first occurrence still has a large audience', async () => {
    const f = harness();
    f.prisma.publicationOccurrence.findFirst
      .mockReset()
      .mockResolvedValueOnce(f.occurrence)
      .mockResolvedValueOnce({
        ...f.occurrence,
        id: 'occurrence-2',
        publicationId: 'publication-2',
        publication: { actorUserId: 'author-2' },
      })
      .mockResolvedValue(null);
    f.prisma.publicationTarget.findMany.mockResolvedValue(
      Array.from({ length: 3 }, (_, position) => ({
        targetChatId: `chat-${position}`,
        entityType: ChatEntityType.CHAT,
        position,
      })),
    );
    await f.service.runOnce();
    expect(f.readiness.requestActorAccessRefresh.mock.calls.map((call) => call[1])).toEqual([
      'author-1',
      'author-2',
    ]);
    expect(f.readiness.requestActorAccessRefresh.mock.calls.map((call) => call[0].length)).toEqual([
      2, 2,
    ]);
  });
});
