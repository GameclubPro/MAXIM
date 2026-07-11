import {
  PublicationLifecycle,
  PublicationOccurrenceStatus,
  PublicationScheduleStatus,
} from '../prisma/prisma-client';
import { AdminManagedBroadcastRuntime } from './admin-managed-broadcast-runtime';

describe('AdminManagedBroadcastRuntime publication execution guard', () => {
  it('fails closed before the legacy direct broadcast path can run in production', async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const runtime = new AdminManagedBroadcastRuntime({} as never);

    try {
      await expect(
        (runtime as any).sendManagedBroadcastViaQueue(
          'chat-1',
          { userId: 'admin-1' },
          {},
          'chat',
          'miniapp',
        ),
      ).rejects.toThrow('Legacy direct managed broadcast dispatch is disabled in production');
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
    }
  });

  it.each([PublicationLifecycle.PAUSED, PublicationLifecycle.CANCELED])(
    'deletes an unsent envelope when its publication becomes %s',
    async (lifecycle) => {
      const tx = {
        managedBroadcastDelivery: { count: jest.fn().mockResolvedValue(0) },
        managedBroadcast: { deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
      };
      const prisma = {
        publicationOccurrence: {
          findUnique: jest.fn().mockResolvedValue({
            status: PublicationOccurrenceStatus.IN_PROGRESS,
            scheduleRevision: 2,
            contentRevisionId: 'content-1',
            publication: { lifecycle },
            schedule: { revision: 2, status: PublicationScheduleStatus.ACTIVE },
          }),
        },
        $transaction: jest.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
      };
      const runtime = new AdminManagedBroadcastRuntime({ prisma } as never);

      await expect(
        (runtime as any).ensureManagedBroadcastPublicationExecutionActive(
          {
            id: 'broadcast-1',
            publicationOccurrenceId: 'occurrence-1',
            publicationContentRevisionId: 'content-1',
            sentCount: 0,
          },
          1,
        ),
      ).resolves.toBe(false);

      expect(tx.managedBroadcast.deleteMany).toHaveBeenCalledWith({
        where: { id: 'broadcast-1' },
      });
    },
  );

  it('releases a stale worker after content edit without deleting the updated envelope', async () => {
    const tx = {
      managedBroadcastDelivery: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      managedBroadcast: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        deleteMany: jest.fn(),
      },
    };
    const prisma = {
      publicationOccurrence: {
        findUnique: jest.fn().mockResolvedValue({
          status: PublicationOccurrenceStatus.IN_PROGRESS,
          scheduleRevision: 2,
          contentRevisionId: 'content-new',
          publication: { lifecycle: PublicationLifecycle.ACTIVE },
          schedule: { revision: 2, status: PublicationScheduleStatus.ACTIVE },
        }),
      },
      $transaction: jest.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
    };
    const runtime = new AdminManagedBroadcastRuntime({ prisma } as never);

    await expect(
      (runtime as any).ensureManagedBroadcastPublicationExecutionActive(
        {
          id: 'broadcast-1',
          publicationOccurrenceId: 'occurrence-1',
          publicationContentRevisionId: 'content-old',
          sentCount: 0,
          lockToken: 'lease-1',
        },
        1,
      ),
    ).resolves.toBe(false);

    expect(tx.managedBroadcastDelivery.updateMany).toHaveBeenCalledWith({
      where: {
        broadcastId: 'broadcast-1',
        occurrenceIndex: 1,
        status: 'SENDING',
      },
      data: {
        status: 'PENDING',
        lockedAt: null,
        lockToken: null,
        lastError: null,
      },
    });
    expect(tx.managedBroadcast.updateMany).toHaveBeenCalledWith({
      where: { id: 'broadcast-1', lockToken: 'lease-1' },
      data: { lockedAt: null, lockToken: null },
    });
    expect(tx.managedBroadcast.deleteMany).not.toHaveBeenCalled();
  });
});
