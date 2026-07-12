import {
  ManagedBroadcastDeliveryStatus,
  ManagedBroadcastStatus,
  PublicationLifecycle,
  PublicationOccurrenceStatus,
  PublicationScheduleMode,
  PublicationScheduleStatus,
} from '../prisma/prisma-client';
import { AdminManagedBroadcastRuntime } from './admin-managed-broadcast-runtime';

describe('AdminManagedBroadcastRuntime publication execution guard', () => {
  it('delivers exact due NOW envelopes on the immediate lane before a governor pause', async () => {
    const managedBroadcast = {
      findMany: jest.fn().mockResolvedValue([{ id: 'broadcast-now' }]),
    };
    const backgroundRuntimeGovernorService = {
      decide: jest.fn().mockResolvedValue({
        action: 'pause',
        reason: 'MAX API stack load 80.0%',
        retryAfterMs: 60_000,
      }),
    };
    const context = {
      prisma: { managedBroadcast },
      backgroundRuntimeGovernorService,
      logger: { log: jest.fn(), warn: jest.fn() },
      managedBroadcastDegradePauseLogAtMs: 0,
    };
    const runtime = new AdminManagedBroadcastRuntime(context as never);
    const processSpy = jest
      .spyOn(runtime as any, 'processManagedBroadcastOccurrence')
      .mockResolvedValue(undefined);

    await runtime.processDueManagedBroadcasts('scheduled');

    expect(processSpy).toHaveBeenCalledTimes(1);
    expect(processSpy).toHaveBeenCalledWith('broadcast-now', 'immediate', expect.any(Date), [
      ManagedBroadcastStatus.ACTIVE,
    ]);
    expect(backgroundRuntimeGovernorService.decide).toHaveBeenCalledTimes(1);
    expect(processSpy.mock.invocationCallOrder[0]).toBeLessThan(
      backgroundRuntimeGovernorService.decide.mock.invocationCallOrder[0],
    );
    expect(managedBroadcast.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          AND: expect.arrayContaining([
            { status: ManagedBroadcastStatus.ACTIVE },
            {
              publicationOccurrence: {
                is: {
                  schedule: {
                    is: {
                      mode: PublicationScheduleMode.NOW,
                    },
                  },
                },
              },
            },
            {
              deliveries: {
                some: {},
              },
            },
          ]),
        },
      }),
    );
  });

  it('finalizes an ambiguous NOW recovery envelope without dispatching it again', async () => {
    const nextSendAt = new Date('2026-07-12T10:00:00.000Z');
    const row = {
      id: 'broadcast-now',
      sourceChatId: 'chat-1',
      entityType: 'CHAT',
      actorUserId: 'admin-1',
      text: 'Publication',
      textFormat: 'plain',
      applyToAllChats: false,
      targetChatIds: ['chat-1'],
      buttons: [],
      buttonEnabled: false,
      buttonUrl: '',
      buttonText: 'Open',
      imageEnabled: false,
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
      mediaType: null,
      mediaPayload: null,
      mediaMimeType: '',
      mediaFileName: '',
      scheduleMode: 'calendar',
      scheduleTimezone: 'Europe/Moscow',
      nextSendAt,
      cycleEnabled: false,
      cycleEveryHours: 1,
      cycleCount: 1,
      sentCount: 0,
      status: ManagedBroadcastStatus.ACTIVE,
      lastError: null,
      lockedAt: null,
      lockToken: null,
      publicationOccurrenceId: 'occurrence-1',
      publicationContentRevisionId: 'content-1',
    };
    const ambiguousDelivery = {
      id: 'delivery-1',
      broadcastId: row.id,
      occurrenceIndex: 1,
      targetChatId: 'chat-1',
      status: ManagedBroadcastDeliveryStatus.AMBIGUOUS,
      attemptCount: 1,
      remoteMessageId: null,
      lastError: 'timeout',
      sentAt: null,
      lockedAt: null,
      lockToken: null,
    };
    const prisma = {
      managedBroadcast: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn().mockResolvedValue(row),
      },
      managedBroadcastDelivery: {
        findMany: jest.fn().mockResolvedValue([ambiguousDelivery]),
      },
    };
    const runtime = new AdminManagedBroadcastRuntime({ prisma } as never);
    jest
      .spyOn(runtime as any, 'ensureManagedBroadcastPublicationExecutionActive')
      .mockResolvedValue(true);
    jest
      .spyOn(runtime as any, 'reconcileStaleManagedBroadcastDeliveries')
      .mockResolvedValue(undefined);
    jest
      .spyOn(runtime as any, 'deferManagedBroadcastOccurrenceWithFreshSendingDeliveries')
      .mockResolvedValue(false);
    jest.spyOn(runtime as any, 'resolveManagedBroadcastTargetsFromRow').mockReturnValue({
      targetMode: 'selected',
      targetChatIds: ['chat-1'],
    });
    jest
      .spyOn(runtime as any, 'ensureManagedBroadcastDeliveryRows')
      .mockResolvedValue([ambiguousDelivery]);
    jest.spyOn(runtime as any, 'loadManagedBroadcastRequestMedia').mockResolvedValue({});
    const finalizeSpy = jest
      .spyOn(runtime as any, 'finalizeManagedBroadcastOccurrence')
      .mockResolvedValue({
        status: ManagedBroadcastStatus.FAILED,
        currentOccurrence: 1,
        sentChatIds: [],
        failedChatIds: ['chat-1'],
        pendingChatIds: [],
        canRetry: false,
        firstSendError: null,
        nextSendAt,
      });
    const sendSpy = jest
      .spyOn(runtime as any, 'sendManagedBroadcastMessageImmediateWithId')
      .mockResolvedValue({ messageId: 'duplicate', url: null });

    const result = await (runtime as any).processManagedBroadcastOccurrence(
      row.id,
      'immediate',
      new Date('2026-07-12T09:55:00.000Z'),
      [ManagedBroadcastStatus.ACTIVE],
    );

    expect(sendSpy).not.toHaveBeenCalled();
    expect(finalizeSpy).toHaveBeenCalledWith(row, 1, [], [], null, expect.any(Object));
    expect(result).toEqual(expect.objectContaining({ status: ManagedBroadcastStatus.FAILED }));
  });

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

  it.each([
    {
      label: 'all canceled',
      deliveries: [
        { status: ManagedBroadcastDeliveryStatus.CANCELED, targetChatId: 'chat-1' },
        { status: ManagedBroadcastDeliveryStatus.CANCELED, targetChatId: 'chat-2' },
      ],
      expectedStatus: ManagedBroadcastStatus.FAILED,
      expectedSentChatIds: [],
      expectedFailedChatIds: ['chat-1', 'chat-2'],
      expectedCanRetry: false,
    },
    {
      label: 'sent and canceled',
      deliveries: [
        { status: ManagedBroadcastDeliveryStatus.SENT, targetChatId: 'chat-1' },
        { status: ManagedBroadcastDeliveryStatus.CANCELED, targetChatId: 'chat-2' },
      ],
      expectedStatus: ManagedBroadcastStatus.PARTIAL,
      expectedSentChatIds: ['chat-1'],
      expectedFailedChatIds: ['chat-2'],
      expectedCanRetry: false,
    },
    {
      label: 'failed and canceled',
      deliveries: [
        { status: ManagedBroadcastDeliveryStatus.FAILED, targetChatId: 'chat-1' },
        { status: ManagedBroadcastDeliveryStatus.CANCELED, targetChatId: 'chat-2' },
      ],
      expectedStatus: ManagedBroadcastStatus.FAILED,
      expectedSentChatIds: [],
      expectedFailedChatIds: ['chat-1', 'chat-2'],
      expectedCanRetry: true,
    },
  ])(
    'treats $label deliveries as terminal undelivered with retry based only on real failures',
    async ({
      deliveries,
      expectedStatus,
      expectedSentChatIds,
      expectedFailedChatIds,
      expectedCanRetry,
    }) => {
      const prisma = {
        managedBroadcastDelivery: { findMany: jest.fn().mockResolvedValue(deliveries) },
        managedBroadcast: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        managedBroadcastOccurrence: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      };
      const runtime = new AdminManagedBroadcastRuntime({ prisma } as never);
      const row = {
        id: 'broadcast-1',
        scheduleMode: 'calendar',
        nextSendAt: new Date('2026-07-12T10:00:00.000Z'),
        publicationOccurrenceId: 'occurrence-1',
      };

      const result = await (runtime as any).finalizeManagedBroadcastOccurrence(
        row,
        1,
        [],
        [],
        null,
      );

      expect(result).toEqual(
        expect.objectContaining({
          status: expectedStatus,
          sentChatIds: expectedSentChatIds,
          failedChatIds: expectedFailedChatIds,
          pendingChatIds: [],
          canRetry: expectedCanRetry,
        }),
      );
      expect(prisma.managedBroadcast.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: expectedStatus }),
        }),
      );
      expect(prisma.managedBroadcast.updateMany.mock.calls[0]?.[0]?.data).not.toHaveProperty(
        'sentCount',
      );
      expect(prisma.managedBroadcastOccurrence.updateMany).toHaveBeenCalledWith({
        where: { broadcastId: 'broadcast-1', occurrenceIndex: 1 },
        data: { status: expectedStatus },
      });
    },
  );

  it('keeps legacy canceled-target completion semantics while reporting the blocked targets', async () => {
    const prisma = {
      managedBroadcastDelivery: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { status: ManagedBroadcastDeliveryStatus.CANCELED, targetChatId: 'chat-1' },
          ]),
      },
      managedBroadcast: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    const runtime = new AdminManagedBroadcastRuntime({ prisma } as never);

    const result = await (runtime as any).finalizeManagedBroadcastOccurrence(
      {
        id: 'broadcast-legacy',
        scheduleMode: 'legacy',
        nextSendAt: new Date('2026-07-12T10:00:00.000Z'),
        cycleEveryHours: 1,
        cycleCount: 1,
        publicationOccurrenceId: null,
      },
      1,
      [],
      [],
      null,
    );

    expect(result).toEqual(
      expect.objectContaining({
        status: ManagedBroadcastStatus.COMPLETED,
        sentChatIds: [],
        failedChatIds: ['chat-1'],
        canRetry: false,
      }),
    );
    expect(prisma.managedBroadcast.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: ManagedBroadcastStatus.COMPLETED,
          sentCount: 1,
        }),
      }),
    );
  });

  it('does not expose retry after a concurrent broadcast cancellation wins finalization', async () => {
    const runtime = new AdminManagedBroadcastRuntime({
      prisma: {
        managedBroadcast: {
          findUnique: jest.fn().mockResolvedValue({
            status: ManagedBroadcastStatus.CANCELED,
            sentCount: 0,
            cycleCount: 1,
            nextSendAt: null,
          }),
        },
      },
    } as never);

    const result = await (runtime as any).readManagedBroadcastOccurrenceResult(
      'broadcast-1',
      [],
      ['chat-1'],
      [],
      null,
      true,
    );

    expect(result).toEqual(
      expect.objectContaining({
        status: ManagedBroadcastStatus.CANCELED,
        canRetry: false,
      }),
    );
  });
});
