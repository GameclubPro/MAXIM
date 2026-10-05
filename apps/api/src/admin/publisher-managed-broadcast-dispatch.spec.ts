import {
  PublisherDeliveryDeferredError,
  PublisherManagedBroadcastDispatch,
} from './publisher-managed-broadcast-dispatch';

describe('Publisher pre-dispatch claim deferral', () => {
  it('keeps shared blocker cleanup fenced by the exact envelope lease', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 0 });
    const executeRaw = jest.fn();
    const service = new PublisherManagedBroadcastDispatch(
      {
        prisma: {
          $transaction: async (run: (tx: unknown) => unknown) =>
            run({
              managedBroadcast: { updateMany },
              $executeRaw: executeRaw,
            }),
        },
      } as never,
      {} as never,
    );
    const lease = { lockedAt: new Date(), lockToken: 'old-lease' };
    expect(
      await service.clearResolvedRecipientBlocker(
        { id: 'broadcast', publicationOccurrenceId: 'occurrence', requiredBotId: 'publik' },
        lease,
      ),
    ).toBe(false);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'broadcast',
          lockedAt: lease.lockedAt,
          lockToken: lease.lockToken,
        }),
      }),
    );
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it('rechecks author authority at the final send boundary after a valid bot route', async () => {
    const requestActorAccessRefresh = jest.fn().mockResolvedValue(undefined);
    const findMany = jest.fn().mockResolvedValue([]);
    const service = new PublisherManagedBroadcastDispatch(
      {
        prisma: { managedEntityAccessEdge: { findMany } },
        publisherRuntimeBoundaryService: { assertDispatchEnabled: jest.fn() },
        publisherDispatchHealthService: { assertDispatchAllowed: jest.fn() },
        publisherReadinessService: {
          assertEntityReady: jest.fn().mockResolvedValue({
            requiredBotId: 'publik',
            entityType: 'channel',
          }),
          requestActorAccessRefresh,
        },
      } as never,
      {} as never,
    );
    await expect(service.assertDeliveryReady('chat', 'publik', 'actor')).rejects.toBeInstanceOf(
      PublisherDeliveryDeferredError,
    );
    expect(findMany.mock.calls[0][0].where).toMatchObject({
      chatId: { in: ['chat'] },
      userId: 'actor',
      botId: 'publik',
      entityType: 'CHANNEL',
      state: 'GRANTED',
      userRole: { in: ['OWNER', 'ADMIN'] },
      checkedAt: { gt: expect.any(Date) },
    });
    expect(requestActorAccessRefresh).toHaveBeenCalledWith(
      [{ chatId: 'chat', entityType: 'channel' }],
      'actor',
      'publik',
    );
  });

  it.each([false, true, undefined])(
    'preserves actual attempts with sendAttemptStarted=%s',
    async (sendAttemptStarted) => {
      const updateMany = jest.fn().mockResolvedValue({ count: 1 });
      const service = new PublisherManagedBroadcastDispatch(
        { prisma: { managedBroadcastDelivery: { updateMany } } } as never,
        {} as never,
      );
      await service.deferClaimed({
        row: { id: 'broadcast', publicationOccurrenceId: null, requiredBotId: 'publik' },
        delivery: { id: 'delivery', targetChatId: 'chat', dialogBotId: 'publik' },
        deliveryLockToken: 'exact-lock',
        blockerCode: 'bot_access_expired',
        sendAttemptStarted,
      });
      const write = updateMany.mock.calls[0][0];
      expect(write.where).toMatchObject({
        id: 'delivery',
        status: 'SENDING',
        lockToken: 'exact-lock',
        requiredBotId: 'publik',
      });
      expect(write.data).toMatchObject({ status: 'PENDING', lockToken: null });
      if (sendAttemptStarted === false) {
        expect(write.where.attemptCount).toEqual({ gt: 0 });
        expect(write.data.attemptCount).toEqual({ decrement: 1 });
      } else {
        expect(write.where).not.toHaveProperty('attemptCount');
        expect(write.data).not.toHaveProperty('attemptCount');
      }
    },
  );
});
