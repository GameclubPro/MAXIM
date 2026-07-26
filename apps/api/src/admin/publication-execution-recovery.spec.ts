import { ManagedBroadcastDeliveryStatus } from '../prisma/prisma-client';
import { deferPublicationDeliveryAfterPreDispatchThrottle } from './publication-execution-recovery';

describe('publication execution recovery', () => {
  function createOptions(error: unknown) {
    return {
      context: {
        prisma: {
          managedBroadcastDelivery: {
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          },
        },
        logger: { warn: jest.fn() },
      },
      row: { id: 'broadcast-1', publicationOccurrenceId: 'occurrence-1' as string | null },
      delivery: { id: 'delivery-1', targetChatId: 'chat-1' },
      reason: 'deadline' as const,
      occurrenceIndex: 1,
      deliveryLockToken: 'delivery-lock-1',
      error,
    };
  }

  it('returns a deadline delivery to pending when capacity rejected it before dispatch', async () => {
    const options = createOptions(
      Object.assign(new Error('MAX API background rate limit exceeded'), {
        code: 'MAX_API_INTERNAL_RATE_LIMIT',
        managedBroadcastSendStarted: false,
      }),
    );

    await expect(deferPublicationDeliveryAfterPreDispatchThrottle(options as never)).resolves.toBe(
      true,
    );
    expect(options.context.prisma.managedBroadcastDelivery.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: 'delivery-1',
        status: ManagedBroadcastDeliveryStatus.SENDING,
        lockToken: 'delivery-lock-1',
      }),
      data: expect.objectContaining({
        status: ManagedBroadcastDeliveryStatus.PENDING,
        attemptCount: { decrement: 1 },
        botId: null,
        lockedAt: null,
        lockToken: null,
        lastError: null,
      }),
    });
  });

  it.each([
    { label: 'dispatch started', marker: true, publicationOccurrenceId: 'occurrence-1' },
    { label: 'not a Publication envelope', marker: false, publicationOccurrenceId: null },
  ])('does not defer when $label', async ({ marker, publicationOccurrenceId }) => {
    const options = createOptions(
      Object.assign(new Error('MAX API background rate limit exceeded'), {
        managedBroadcastSendStarted: marker,
      }),
    );
    options.row.publicationOccurrenceId = publicationOccurrenceId;

    await expect(deferPublicationDeliveryAfterPreDispatchThrottle(options as never)).resolves.toBe(
      false,
    );
    expect(options.context.prisma.managedBroadcastDelivery.updateMany).not.toHaveBeenCalled();
  });
});
