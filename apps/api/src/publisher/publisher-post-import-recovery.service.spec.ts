import { PublisherPostImportStatus } from '../prisma/prisma-client';
import { PublisherPostImportRecoveryService } from './publisher-post-import-recovery.service';

describe('PublisherPostImportRecoveryService', () => {
  it('deletes only expired terminal session rows and leaves durable publications untouched', async () => {
    const publisherPostImportSession = {
      findMany: jest.fn(
        async (args: { where: { status: unknown }; select?: { notificationKind?: boolean } }) => {
          if (args.select?.notificationKind) {
            return [
              {
                id: 'ready-session-notification',
                status: PublisherPostImportStatus.READY,
                privateChatId: '42',
                callbackId: null,
                notificationKind: 'ready',
              },
            ];
          }
          const status = args.where.status;
          if (typeof status === 'object' && status && 'in' in status) {
            return [{ id: 'ready-session-1' }];
          }
          return [];
        },
      ),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    };
    const prisma = {
      publisherPostImportSession,
      publication: { deleteMany: jest.fn() },
    };
    const queue = {
      enqueueProcess: jest.fn(),
      enqueueNotification: jest.fn(),
    };
    const backgroundWork = {
      runExclusive: jest.fn((_lane: string, operation: () => Promise<void>) => operation()),
    };
    const service = new PublisherPostImportRecoveryService(
      prisma as never,
      queue as never,
      backgroundWork as never,
      { dispatchEnabled: true } as never,
    );
    const now = new Date('2026-08-30T12:00:00.000Z');

    await service.recoverOnce(now);

    expect(publisherPostImportSession.deleteMany).toHaveBeenCalledWith({
      where: {
        id: { in: ['ready-session-1'] },
        status: {
          in: [
            PublisherPostImportStatus.READY,
            PublisherPostImportStatus.FAILED,
            PublisherPostImportStatus.CANCELED,
            PublisherPostImportStatus.EXPIRED,
          ],
        },
        expiresAt: { lte: now },
      },
    });
    expect(prisma.publication.deleteMany).not.toHaveBeenCalled();
    expect(queue.enqueueNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'ready-session-notification',
        notification: 'ready',
        privateChatId: '42',
      }),
    );
    expect(publisherPostImportSession.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          notificationPending: true,
          notificationKind: { not: null },
          notificationDispatchStartedAt: null,
        }),
        take: 25,
      }),
    );
  });
});
