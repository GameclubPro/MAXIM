import { buildMaxActionNoExecutableRouteMessage } from '../max/max-action-dispatch-error';
import {
  ManagedBroadcastDeliveryStatus,
  ManagedBroadcastStatus,
  PublicationLifecycle,
  PublicationOccurrenceStatus,
  PublicationScheduleStatus,
} from '../prisma/prisma-client';
import {
  findFullPublicationRouteOutageTarget,
  PUBLICATION_DELIVERY_ACCESS_LOST_ERROR_CODE,
  rollupAndPausePublicationAfterRouteOutage,
  rollupPublicationOccurrenceWithRouteOutageRecovery,
  type PublicationAccessLossOccurrenceSnapshot,
} from './publication-access-loss-recovery';

function extractSqlText(query: unknown): string {
  const strings = (query as { strings?: readonly string[] } | null)?.strings;
  return (Array.isArray(strings) ? strings.join('?') : String(query)).replace(/\s+/gu, ' ').trim();
}

describe('publication access-loss recovery', () => {
  const occurrence: PublicationAccessLossOccurrenceSnapshot = {
    id: 'occurrence-1',
    publicationId: 'publication-1',
    scheduleId: 'schedule-1',
    status: PublicationOccurrenceStatus.IN_PROGRESS,
    updatedAt: new Date('2026-07-27T15:00:00.000Z'),
    scheduleRevision: 4,
    contentRevisionId: 'content-1',
  };

  function createHarness() {
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      publicationOccurrence: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        count: jest.fn().mockResolvedValue(1),
      },
      publicationSchedule: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'schedule-1',
          revision: 4,
          status: PublicationScheduleStatus.ACTIVE,
          nextMaterializeAt: null,
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      publicationTarget: {
        count: jest.fn().mockResolvedValue(1),
      },
      publication: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      managedBroadcast: {
        findMany: jest.fn().mockResolvedValue([]),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    const transaction = jest.fn((callback: (client: typeof tx) => unknown) => callback(tx));
    const prisma = {
      $transaction: transaction,
      publicationOccurrence: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    return { prisma, transaction, tx };
  }

  it('recognizes only a full structured or exact route outage', () => {
    const noRoute = (targetChatId: string) => ({
      status: ManagedBroadcastDeliveryStatus.FAILED,
      targetChatId,
      lastError: buildMaxActionNoExecutableRouteMessage('SEND_MESSAGE', targetChatId),
    });

    expect(findFullPublicationRouteOutageTarget([noRoute('chat-1'), noRoute('chat-2')])).toBe(
      'chat-1',
    );
    expect(
      findFullPublicationRouteOutageTarget([
        {
          status: ManagedBroadcastDeliveryStatus.CANCELED,
          targetChatId: 'chat-1',
          lastErrorCode: PUBLICATION_DELIVERY_ACCESS_LOST_ERROR_CODE,
          lastError: 'chat.denied',
        },
        {
          status: ManagedBroadcastDeliveryStatus.CANCELED,
          targetChatId: 'chat-2',
          lastErrorCode: PUBLICATION_DELIVERY_ACCESS_LOST_ERROR_CODE,
          lastError: 'chat.denied',
        },
      ]),
    ).toBe('chat-1');
    expect(
      findFullPublicationRouteOutageTarget([
        noRoute('chat-1'),
        {
          status: ManagedBroadcastDeliveryStatus.FAILED,
          targetChatId: 'chat-2',
          lastError: 'another terminal delivery failure',
        },
      ]),
    ).toBeNull();
    expect(
      findFullPublicationRouteOutageTarget([
        noRoute('chat-1'),
        {
          status: ManagedBroadcastDeliveryStatus.SENT,
          targetChatId: 'chat-2',
          lastError: null,
        },
      ]),
    ).toBeNull();
  });

  it('uses the ordinary occurrence CAS when at least one delivery route remains healthy', async () => {
    const { prisma, transaction } = createHarness();

    await rollupPublicationOccurrenceWithRouteOutageRecovery(
      prisma as never,
      occurrence,
      PublicationOccurrenceStatus.PARTIAL,
      [
        {
          status: ManagedBroadcastDeliveryStatus.SENT,
          targetChatId: 'chat-1',
          lastError: null,
        },
        {
          status: ManagedBroadcastDeliveryStatus.FAILED,
          targetChatId: 'chat-2',
          lastError: 'another terminal delivery failure',
        },
      ],
    );

    expect(transaction).not.toHaveBeenCalled();
    expect(prisma.publicationOccurrence.updateMany).toHaveBeenCalledWith({
      where: {
        id: occurrence.id,
        status: occurrence.status,
        updatedAt: occurrence.updatedAt,
        scheduleId: occurrence.scheduleId,
        scheduleRevision: occurrence.scheduleRevision,
        contentRevisionId: occurrence.contentRevisionId,
      },
      data: { status: PublicationOccurrenceStatus.PARTIAL },
    });
  });

  it('rolls up and pauses atomically under the publication calendar lock', async () => {
    const { prisma, transaction, tx } = createHarness();
    tx.managedBroadcast.findMany.mockResolvedValue([
      { id: 'future-envelope-1', lockedAt: null, lockToken: null },
    ]);
    tx.managedBroadcast.deleteMany.mockResolvedValue({ count: 1 });

    await rollupAndPausePublicationAfterRouteOutage(
      prisma as never,
      occurrence,
      PublicationOccurrenceStatus.FAILED,
      'chat-1',
    );

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(extractSqlText(tx.$executeRaw.mock.calls[0]?.[0])).toContain(
      "pg_advisory_xact_lock(hashtext('publication-calendar'))",
    );
    expect(tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.publicationOccurrence.updateMany.mock.invocationCallOrder[0]!,
    );
    expect(tx.publicationOccurrence.updateMany).toHaveBeenCalledWith({
      where: {
        id: occurrence.id,
        status: occurrence.status,
        updatedAt: occurrence.updatedAt,
        scheduleId: occurrence.scheduleId,
        scheduleRevision: occurrence.scheduleRevision,
        contentRevisionId: occurrence.contentRevisionId,
      },
      data: { status: PublicationOccurrenceStatus.FAILED },
    });
    expect(tx.publicationOccurrence.count).toHaveBeenCalledWith({
      where: {
        publicationId: occurrence.publicationId,
        scheduleId: occurrence.scheduleId,
        scheduleRevision: occurrence.scheduleRevision,
        id: { not: occurrence.id },
        status: PublicationOccurrenceStatus.SCHEDULED,
      },
    });
    expect(tx.publication.updateMany).toHaveBeenCalledWith({
      where: {
        id: occurrence.publicationId,
        lifecycle: PublicationLifecycle.ACTIVE,
        targets: { some: { targetChatId: 'chat-1' } },
      },
      data: { lifecycle: PublicationLifecycle.PAUSED },
    });
    expect(tx.managedBroadcast.findMany).toHaveBeenCalledWith({
      where: {
        publicationOccurrence: {
          is: {
            publicationId: occurrence.publicationId,
            id: { not: occurrence.id },
            scheduleId: occurrence.scheduleId,
            scheduleRevision: occurrence.scheduleRevision,
          },
        },
        status: ManagedBroadcastStatus.ACTIVE,
        sentCount: 0,
        deliveries: {
          none: {
            OR: [
              { attemptCount: { gt: 0 } },
              { lockedAt: { not: null } },
              {
                status: {
                  in: [
                    ManagedBroadcastDeliveryStatus.SENDING,
                    ManagedBroadcastDeliveryStatus.SENT,
                    ManagedBroadcastDeliveryStatus.AMBIGUOUS,
                  ],
                },
              },
            ],
          },
        },
      },
      select: { id: true, lockedAt: true, lockToken: true },
    });
    expect(tx.managedBroadcast.deleteMany).toHaveBeenCalledWith({
      where: {
        id: { in: ['future-envelope-1'] },
        status: ManagedBroadcastStatus.ACTIVE,
        sentCount: 0,
        lockedAt: null,
        lockToken: null,
        deliveries: {
          none: {
            OR: [
              { attemptCount: { gt: 0 } },
              { lockedAt: { not: null } },
              {
                status: {
                  in: [
                    ManagedBroadcastDeliveryStatus.SENDING,
                    ManagedBroadcastDeliveryStatus.SENT,
                    ManagedBroadcastDeliveryStatus.AMBIGUOUS,
                  ],
                },
              },
            ],
          },
        },
      },
    });
    expect(tx.publicationSchedule.updateMany).toHaveBeenCalledWith({
      where: {
        publicationId: occurrence.publicationId,
        id: occurrence.scheduleId,
        revision: occurrence.scheduleRevision,
        status: PublicationScheduleStatus.ACTIVE,
      },
      data: {
        status: PublicationScheduleStatus.PAUSED,
        nextMaterializeAt: null,
        lastError: expect.stringContaining('права администратора'),
      },
    });
  });

  it('does not pause when no future occurrence or materialization remains', async () => {
    const { prisma, tx } = createHarness();
    tx.publicationOccurrence.count.mockResolvedValue(0);

    await rollupAndPausePublicationAfterRouteOutage(
      prisma as never,
      occurrence,
      PublicationOccurrenceStatus.FAILED,
      'chat-1',
    );

    expect(tx.publicationOccurrence.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.publication.updateMany).not.toHaveBeenCalled();
    expect(tx.managedBroadcast.findMany).not.toHaveBeenCalled();
    expect(tx.publicationSchedule.updateMany).not.toHaveBeenCalled();
  });

  it('pauses when future recurrence materialization remains without a materialized slot', async () => {
    const { prisma, tx } = createHarness();
    tx.publicationOccurrence.count.mockResolvedValue(0);
    tx.publicationSchedule.findUnique.mockResolvedValue({
      id: occurrence.scheduleId,
      revision: occurrence.scheduleRevision,
      status: PublicationScheduleStatus.ACTIVE,
      nextMaterializeAt: new Date('2026-08-01T00:00:00.000Z'),
    });

    await rollupAndPausePublicationAfterRouteOutage(
      prisma as never,
      occurrence,
      PublicationOccurrenceStatus.FAILED,
      'chat-1',
    );

    expect(tx.publication.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.publicationSchedule.updateMany).toHaveBeenCalledTimes(1);
  });

  it('terminalizes a stale occurrence without pausing the admin replacement schedule', async () => {
    const { prisma, tx } = createHarness();
    tx.publicationSchedule.findUnique.mockResolvedValue({
      id: occurrence.scheduleId,
      revision: occurrence.scheduleRevision + 1,
      status: PublicationScheduleStatus.ACTIVE,
      nextMaterializeAt: new Date('2026-08-01T00:00:00.000Z'),
    });

    await rollupAndPausePublicationAfterRouteOutage(
      prisma as never,
      occurrence,
      PublicationOccurrenceStatus.FAILED,
      'chat-1',
    );

    expect(tx.publicationOccurrence.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.publication.updateMany).not.toHaveBeenCalled();
    expect(tx.managedBroadcast.findMany).not.toHaveBeenCalled();
    expect(tx.publicationSchedule.updateMany).not.toHaveBeenCalled();
  });

  it('does not pause when the failed target was removed from the current audience', async () => {
    const { prisma, tx } = createHarness();
    tx.publicationTarget.count.mockResolvedValue(0);

    await rollupAndPausePublicationAfterRouteOutage(
      prisma as never,
      occurrence,
      PublicationOccurrenceStatus.FAILED,
      'chat-1',
    );

    expect(tx.publicationOccurrence.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.publication.updateMany).not.toHaveBeenCalled();
    expect(tx.managedBroadcast.findMany).not.toHaveBeenCalled();
    expect(tx.publicationSchedule.updateMany).not.toHaveBeenCalled();
  });

  it('stops after an occurrence CAS conflict', async () => {
    const { prisma, tx } = createHarness();
    tx.publicationOccurrence.updateMany.mockResolvedValue({ count: 0 });

    await rollupAndPausePublicationAfterRouteOutage(
      prisma as never,
      occurrence,
      PublicationOccurrenceStatus.FAILED,
      'chat-1',
    );

    expect(tx.publicationOccurrence.count).not.toHaveBeenCalled();
    expect(tx.publicationSchedule.findUnique).not.toHaveBeenCalled();
    expect(tx.publication.updateMany).not.toHaveBeenCalled();
  });

  it('forces a transaction rollback when the schedule pause CAS loses', async () => {
    const { prisma, tx } = createHarness();
    tx.publicationSchedule.updateMany.mockResolvedValue({ count: 0 });
    let rolledBack = false;
    prisma.$transaction = jest.fn(async (callback: (client: typeof tx) => unknown) => {
      try {
        return await callback(tx);
      } catch (error: unknown) {
        rolledBack = true;
        throw error;
      }
    });

    await expect(
      rollupAndPausePublicationAfterRouteOutage(
        prisma as never,
        occurrence,
        PublicationOccurrenceStatus.FAILED,
        'chat-1',
      ),
    ).resolves.toBeUndefined();

    expect(tx.publication.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.publicationSchedule.updateMany).toHaveBeenCalledTimes(1);
    expect(rolledBack).toBe(true);
  });

  it('does not absorb unexpected transaction failures', async () => {
    const { prisma, tx } = createHarness();
    tx.managedBroadcast.findMany.mockRejectedValue(new Error('database unavailable'));

    await expect(
      rollupAndPausePublicationAfterRouteOutage(
        prisma as never,
        occurrence,
        PublicationOccurrenceStatus.FAILED,
        'chat-1',
      ),
    ).rejects.toThrow('database unavailable');
  });
});
