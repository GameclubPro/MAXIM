import { PublisherBackgroundWorkCoordinatorClosedError } from '../publisher/publisher-background-work-coordinator.service';
import {
  buildChannelSuggestionPublicationLedgerJobId,
  CHANNEL_SUGGESTION_PUBLICATION_PROTOCOL_V1,
} from './admin-channel-suggestion-publication-protocol';
import { PublisherSuggestionPublicationQueueService } from './publisher-suggestion-publication-queue.service';

describe('PublisherSuggestionPublicationQueueService', () => {
  const originalRole = process.env.APP_ROLE;

  beforeEach(() => {
    process.env.APP_ROLE = 'publisher';
  });

  afterEach(() => {
    if (originalRole === undefined) {
      delete process.env.APP_ROLE;
    } else {
      process.env.APP_ROLE = originalRole;
    }
    jest.useRealTimers();
  });

  function createHarness(dispatchEnabled: boolean, globallyPaused = false) {
    const queue = {
      getJob: jest.fn(),
      add: jest.fn(),
    };
    const prisma = {
      auditLog: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    const dispatchHealth = {
      isGloballyPaused: jest.fn().mockResolvedValue(globallyPaused),
    };
    const backgroundWork = {
      runExclusive: jest.fn((_lane: string, operation: () => Promise<unknown>) => operation()),
    };
    const service = new PublisherSuggestionPublicationQueueService(
      queue as never,
      prisma as never,
      dispatchHealth as never,
      backgroundWork as never,
      { dispatchEnabled } as never,
    );
    return { backgroundWork, dispatchHealth, prisma, queue, service };
  }

  function createClaimRow(index: number) {
    const id = `suggestion-${String(index).padStart(4, '0')}`;
    return {
      id,
      createdAt: new Date(Date.UTC(2026, 7, 26, 10, 0, 0, index)),
      payload: {
        reviewStatus: 'publishing',
        reviewDispatchProfile: 'PUBLIK_V1',
        reviewAction: 'publish',
        reviewPublicationProtocol: CHANNEL_SUGGESTION_PUBLICATION_PROTOCOL_V1,
        reviewPublicationLedgerJobId: buildChannelSuggestionPublicationLedgerJobId(id),
        reviewClaimToken: `claim-${index}`,
        reviewClaimedAt: '2026-08-26T09:55:00.000Z',
        reviewClaimedByUserId: 'admin-1',
      },
    };
  }

  it('does not start suggestion recovery while dispatch is disabled', async () => {
    jest.useFakeTimers();
    const { dispatchHealth, prisma, queue, service } = createHarness(false);

    service.onModuleInit();
    await jest.advanceTimersByTimeAsync(120_000);

    expect(dispatchHealth.isGloballyPaused).not.toHaveBeenCalled();
    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
    expect(queue.getJob).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
    service.onModuleDestroy();
  });

  it('starts bounded suggestion recovery when dispatch is enabled', async () => {
    const { prisma, service } = createHarness(true);

    service.onModuleInit();
    await Promise.resolve();

    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 100 }));
    service.onModuleDestroy();
  });

  it('keeps enabled recovery timers idle before DB or queue work while globally paused', async () => {
    jest.useFakeTimers();
    const { dispatchHealth, prisma, queue, service } = createHarness(true, true);

    service.onModuleInit();
    await jest.advanceTimersByTimeAsync(60_000);

    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
    expect(queue.getJob).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();

    dispatchHealth.isGloballyPaused.mockResolvedValue(false);
    await jest.advanceTimersByTimeAsync(60_000);

    expect(dispatchHealth.isGloballyPaused).toHaveBeenCalledTimes(3);
    expect(prisma.auditLog.findMany).toHaveBeenCalledTimes(1);
    service.onModuleDestroy();
  });

  it('fails recovery closed when the pause lookup fails', async () => {
    const { dispatchHealth, prisma, queue, service } = createHarness(true);
    dispatchHealth.isGloballyPaused.mockRejectedValueOnce(new Error('redis unavailable'));

    service.onModuleInit();
    await Promise.resolve();
    await Promise.resolve();

    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
    expect(queue.getJob).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
    service.onModuleDestroy();
  });

  it('coalesces overlapping recovery ticks before they can duplicate DB work', async () => {
    const { prisma, service } = createHarness(true);
    let resolveRows!: (rows: []) => void;
    prisma.auditLog.findMany.mockReturnValue(
      new Promise<[]>((resolve) => {
        resolveRows = resolve;
      }),
    );

    const first = (service as any).recover() as Promise<void>;
    const second = (service as any).recover() as Promise<void>;
    while (prisma.auditLog.findMany.mock.calls.length === 0) await Promise.resolve();

    expect(prisma.auditLog.findMany).toHaveBeenCalledTimes(1);
    resolveRows([]);
    await Promise.all([first, second]);

    expect(prisma.auditLog.findMany).toHaveBeenCalledTimes(1);
  });

  it('advances a bounded keyset cursor past more than 100 failed claims', async () => {
    const { prisma, queue, service } = createHarness(true);
    const blockedClaims = Array.from({ length: 200 }, (_, index) => createClaimRow(index));
    const readyClaim = createClaimRow(200);
    prisma.auditLog.findMany
      .mockResolvedValueOnce(blockedClaims.slice(0, 100))
      .mockResolvedValueOnce(blockedClaims.slice(100))
      .mockResolvedValueOnce([readyClaim]);
    queue.getJob.mockImplementation(async () => {
      if (queue.getJob.mock.calls.length <= blockedClaims.length) {
        return {
          getState: jest.fn().mockResolvedValue('failed'),
          retry: jest.fn().mockRejectedValue(new Error('permanent blocker')),
        };
      }
      return null;
    });
    const warn = jest.spyOn((service as any).logger, 'warn');

    await (service as any).recover();

    expect(prisma.auditLog.findMany).toHaveBeenCalledTimes(2);
    expect(queue.add).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ failedClaims: 200, err: 'permanent blocker' }),
      'Failed to recover some queued Publik suggestion publications',
    );

    await (service as any).recover();

    expect(prisma.auditLog.findMany).toHaveBeenCalledTimes(3);
    expect(prisma.auditLog.findMany.mock.calls[2]?.[0]).toEqual(
      expect.objectContaining({
        where: expect.objectContaining({
          AND: expect.arrayContaining([
            {
              OR: [
                { createdAt: { gt: blockedClaims[199]!.createdAt } },
                {
                  createdAt: blockedClaims[199]!.createdAt,
                  id: { gt: blockedClaims[199]!.id },
                },
              ],
            },
          ]),
        }),
        select: { id: true, payload: true, createdAt: true },
        take: 100,
      }),
    );
    expect(queue.add).toHaveBeenCalledWith(
      'publish-approved-suggestion',
      expect.objectContaining({
        suggestionId: readyClaim.id,
        claimToken: 'claim-200',
      }),
      expect.objectContaining({
        jobId: expect.stringMatching(/^publik-suggestion-/),
      }),
    );
  });

  it('absorbs coordinator shutdown from its detached timer path', async () => {
    const { backgroundWork, service } = createHarness(true);
    backgroundWork.runExclusive.mockRejectedValue(
      new PublisherBackgroundWorkCoordinatorClosedError(),
    );
    const warn = jest.spyOn((service as any).logger, 'warn');

    (service as any).triggerRecovery();
    await Promise.resolve();
    await Promise.resolve();

    expect(warn).not.toHaveBeenCalled();
  });
});
