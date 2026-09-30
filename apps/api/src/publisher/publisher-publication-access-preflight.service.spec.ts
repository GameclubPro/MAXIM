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
  };
  const prisma = {
    publicationOccurrence: {
      findFirst: jest.fn().mockResolvedValueOnce(occurrence).mockResolvedValue(null),
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
  const service = new PublisherPublicationAccessPreflightService(
    prisma as never,
    readiness as never,
    { getBotId: () => 'publik' } as never,
    { dispatchEnabled: enabled } as never,
    { isGloballyPaused: async () => paused } as never,
    backgroundWork as never,
  );
  return { service, prisma, readiness, occurrence };
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
    );
    expect(f.readiness.requestActorAccessRefresh).toHaveBeenCalledWith(
      [{ chatId: 'chat-1', entityType: 'chat' }],
      'author-1',
      'publik',
      { maxAgeMs: expect.any(Number) },
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
    expect(f.readiness.requestBotAccessRefresh.mock.calls[0][0]).toHaveLength(100);
    f.prisma.publicationOccurrence.findFirst
      .mockResolvedValueOnce(f.occurrence)
      .mockResolvedValue(null);
    await f.service.runOnce();
    expect(f.prisma.publicationTarget.findMany.mock.calls[1][0].where).toEqual({
      publicationId: 'publication-1',
      position: { gt: 99 },
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
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    await f.service.runOnce();
    expect(f.readiness.requestBotAccessRefresh).toHaveBeenCalledTimes(1);
    release();
    await running;
  });
});
