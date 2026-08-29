import {
  PublisherAutoReplyAssetUploadStatus,
  PublisherAutoReplyDeliveryStatus,
} from '../prisma/prisma-client';
import { PublisherAutoReplyRecoveryService } from './publisher-auto-reply-recovery.service';

describe('PublisherAutoReplyRecoveryService', () => {
  it('requeues pending/pre-send work and quarantines a stale send fence', async () => {
    const now = new Date('2026-08-29T12:10:00.000Z');
    const prisma = {
      publisherAutoReplyDelivery: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'pending-1',
            status: PublisherAutoReplyDeliveryStatus.PENDING,
            dueAt: new Date('2026-08-29T12:00:00.000Z'),
            lockToken: null,
            dispatchStartedAt: null,
          },
          {
            id: 'preparing-1',
            status: PublisherAutoReplyDeliveryStatus.SENDING,
            dueAt: new Date('2026-08-29T12:00:00.000Z'),
            lockToken: 'stale-lock',
            dispatchStartedAt: null,
          },
          {
            id: 'fenced-1',
            status: PublisherAutoReplyDeliveryStatus.SENDING,
            dueAt: new Date('2026-08-29T12:00:00.000Z'),
            lockToken: 'stale-fence',
            dispatchStartedAt: new Date('2026-08-29T12:01:00.000Z'),
          },
        ]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      publisherAutoReplyAssetUpload: {
        updateMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
    };
    const queue = { ensureDeliveryJob: jest.fn().mockResolvedValue(undefined) };
    const service = new PublisherAutoReplyRecoveryService(
      prisma as never,
      queue as never,
      { dispatchEnabled: true } as never,
      { isGloballyPaused: jest.fn().mockResolvedValue(false) } as never,
      { assertAttested: jest.fn().mockResolvedValue(undefined) } as never,
      { runExclusive: jest.fn((_lane, operation) => operation()) } as never,
    );

    await expect(service.recoverOnce(now)).resolves.toMatchObject({
      scanned: 3,
      enqueued: 2,
      reset: 1,
      ambiguous: 1,
      uploadsReset: 2,
      errors: 0,
    });
    expect(queue.ensureDeliveryJob).toHaveBeenCalledTimes(2);
    expect(prisma.publisherAutoReplyDelivery.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: PublisherAutoReplyDeliveryStatus.AMBIGUOUS,
          failureCode: 'STALE_SEND_FENCE',
        }),
      }),
    );
    expect(prisma.publisherAutoReplyAssetUpload.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: PublisherAutoReplyAssetUploadStatus.UPLOADING,
        }),
      }),
    );
  });
});
