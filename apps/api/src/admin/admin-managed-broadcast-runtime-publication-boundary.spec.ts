import {
  ChatEntityType,
  ManagedBroadcastDeliveryStatus,
  PublicationDispatchProfile,
} from '../prisma/prisma-client';
import { AdminManagedBroadcastRuntime } from './admin-managed-broadcast-runtime';

const user = { userId: 'user-1', username: null, displayName: null };

function createRuntime(prisma: Record<string, unknown>) {
  const runtime = new AdminManagedBroadcastRuntime({ prisma } as never);
  jest.spyOn(runtime as any, 'assertManagedEntityReadAccess').mockResolvedValue(undefined);
  jest.spyOn(runtime as any, 'assertManagedEntityAdminAccess').mockResolvedValue(undefined);
  return runtime;
}

describe('AdminManagedBroadcastRuntime publication boundary', () => {
  it.each(['get', 'update', 'cancel', 'retry'] as const)(
    'keeps publication envelopes out of legacy %s',
    async (operation) => {
      const findFirst = jest.fn().mockResolvedValue(null);
      const runtime = createRuntime({ managedBroadcast: { findFirst } });

      const result =
        operation === 'get'
          ? runtime.getManagedBroadcast('chat-1', 'broadcast-1', user)
          : operation === 'update'
            ? runtime.updateManagedBroadcast('chat-1', 'broadcast-1', user, {})
            : operation === 'cancel'
              ? runtime.cancelManagedBroadcast('chat-1', 'broadcast-1', user)
              : runtime.retryManagedBroadcast('chat-1', 'broadcast-1', user);

      await expect(result).rejects.toThrow();
      expect(findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ publicationOccurrenceId: null }),
        }),
      );
    },
  );

  it('filters publication envelopes from legacy list queries', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const runtime = createRuntime({ managedBroadcast: { findMany } });

    await expect(runtime.listManagedBroadcasts('chat-1', user)).resolves.toEqual([]);
    expect(findMany).toHaveBeenCalledTimes(2);
    for (const call of findMany.mock.calls) {
      expect(call[0]).toEqual(
        expect.objectContaining({
          where: expect.objectContaining({ publicationOccurrenceId: null }),
        }),
      );
    }
  });

  it('filters publication envelopes from legacy calendar reservations', async () => {
    const reservationFindMany = jest.fn().mockResolvedValue([]);
    const runtime = createRuntime({
      managedBroadcastCalendarReservation: { findMany: reservationFindMany },
      chat: { findMany: jest.fn().mockResolvedValue([]) },
      managedBotChatCatalog: { findMany: jest.fn().mockResolvedValue([]) },
    });

    await expect(
      runtime.getChannelManagedBroadcastCalendar('channel-1', user, {}),
    ).resolves.toEqual(expect.objectContaining({ slots: [] }));
    expect(reservationFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          broadcast: { is: { publicationOccurrenceId: null } },
        }),
      }),
    );
  });

  it('does not overwrite publication-linked legacy occurrence rows', async () => {
    const occurrenceFindMany = jest.fn().mockResolvedValue([]);
    const runtime = createRuntime({});

    await (runtime as any).overwriteManagedBroadcastCalendarSlots(
      { managedBroadcastOccurrence: { findMany: occurrenceFindMany } },
      {
        sourceChatId: 'chat-1',
        entityType: ChatEntityType.CHAT,
        slots: [new Date('2026-07-12T09:00:00.000Z')],
        excludeBroadcastId: null,
        allowOverwrite: true,
      },
    );

    expect(occurrenceFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          broadcast: { is: { publicationOccurrenceId: null } },
        }),
      }),
    );
  });

  it('returns a controlled conflict instead of overwriting a publication reservation', async () => {
    const slot = new Date('2026-07-12T09:00:00.000Z');
    const createMany = jest.fn();
    const executeRaw = jest.fn().mockResolvedValue(1);
    const runtime = createRuntime({});
    const tx = {
      $executeRaw: executeRaw,
      managedBroadcastOccurrence: {
        findMany: jest.fn().mockResolvedValue([]),
        createMany,
      },
      publicationOccurrence: { findMany: jest.fn().mockResolvedValue([]) },
      managedBroadcastCalendarReservation: {
        findMany: jest.fn().mockResolvedValue([
          {
            broadcastId: 'publication-broadcast',
            scheduledAt: slot,
            targetChatId: 'chat-1',
          },
        ]),
        createMany: jest.fn(),
      },
    };

    await expect(
      (runtime as any).createManagedBroadcastOccurrencesWithOverwrite(tx, {
        broadcastId: 'legacy-broadcast',
        sourceChatId: 'chat-1',
        entityType: ChatEntityType.CHAT,
        fromOccurrenceIndex: 1,
        slots: [slot],
        targetChatIds: ['chat-1'],
        excludeBroadcastId: null,
        allowOverwrite: true,
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'BROADCAST_TARGET_SLOT_CONFLICT' }),
    });
    expect(executeRaw).toHaveBeenCalledTimes(1);
    expect(createMany).not.toHaveBeenCalled();
  });

  it('reserves unmaterialized Publication occurrences against legacy scheduling', async () => {
    const slot = new Date('2026-07-12T09:00:00.000Z');
    const createMany = jest.fn();
    const runtime = createRuntime({});
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      managedBroadcastOccurrence: {
        findMany: jest.fn().mockResolvedValue([]),
        createMany,
      },
      publicationOccurrence: {
        findMany: jest.fn().mockResolvedValue([
          {
            scheduledAt: slot,
            scheduleRevision: 3,
            schedule: { revision: 3 },
            publication: { targets: [{ targetChatId: 'chat-1' }] },
          },
        ]),
      },
      managedBroadcastCalendarReservation: {
        findMany: jest.fn().mockResolvedValue([]),
        createMany: jest.fn(),
      },
    };

    await expect(
      (runtime as any).createManagedBroadcastOccurrencesWithOverwrite(tx, {
        broadcastId: 'legacy-broadcast',
        sourceChatId: 'chat-1',
        entityType: ChatEntityType.CHAT,
        fromOccurrenceIndex: 1,
        slots: [slot],
        targetChatIds: ['chat-1'],
        excludeBroadcastId: null,
        allowOverwrite: true,
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'BROADCAST_TARGET_SLOT_CONFLICT' }),
    });
    expect(createMany).not.toHaveBeenCalled();
  });

  it('separates the Publik transport bot from the main dialog bot in post buttons', async () => {
    const resolveBroadcastButtonContext = jest.fn().mockResolvedValue({
      buttons: [[{ type: 'link', text: 'Комментарии', url: 'https://max.ru/main-bot' }]],
      commentDialogReference: {
        entityType: 'channel',
        threadId: 'thread-1',
        includeCommentsButton: true,
        includeSuggestButton: false,
        suggestButtonText: null,
        customButtons: [],
        suggestionEntryMode: 'BOT',
        botId: 'main-bot',
      },
    });
    const runtime = new AdminManagedBroadcastRuntime({
      prisma: {},
      resolveBroadcastButtonContext,
    } as never);

    const message = await (runtime as any).messageRuntime.buildMessage(
      'channel-1',
      'channel',
      {
        textFormat: 'plain',
        buttons: [],
        buttonEnabled: false,
        buttonText: '',
        buttonUrl: '',
      },
      'Публикация',
      {},
      'publisher-bot',
      'main-bot',
    );

    expect(resolveBroadcastButtonContext).toHaveBeenCalledWith(
      'channel-1',
      'channel',
      expect.any(Object),
      'main-bot',
    );
    expect(message.commentDialogReference).toEqual(
      expect.objectContaining({
        botId: 'publisher-bot',
        dialogBotId: 'main-bot',
      }),
    );
  });

  it('uses the persisted main-signed keyboard without rebuilding it in publisher runtime', async () => {
    const resolveBroadcastButtonContext = jest.fn();
    const runtime = new AdminManagedBroadcastRuntime({
      prisma: {},
      resolveBroadcastButtonContext,
    } as never);
    const signedButton = {
      type: 'link',
      text: 'Комментарии · 0',
      url: 'https://max.ru/main-bot?startapp=signed-main-context',
    };

    const message = await (runtime as any).messageRuntime.buildMessage(
      'channel-1',
      'channel',
      {
        textFormat: 'plain',
        buttons: [],
        buttonEnabled: false,
        buttonText: '',
        buttonUrl: '',
      },
      'Публикация',
      {},
      'publisher-bot',
      'main-bot',
      {
        value: {
          version: 1,
          dialogBotId: 'main-bot',
          buttons: [[signedButton]],
          reference: null,
        },
        required: true,
      },
    );

    expect(resolveBroadcastButtonContext).not.toHaveBeenCalled();
    expect(message.messageOptions?.buttons).toEqual([[signedButton]]);
  });

  it('leaves Publik deliveries pending when the publisher runtime boundary is disabled', async () => {
    const publicationOccurrenceUpdate = jest.fn().mockResolvedValue({ count: 1 });
    const deliveryUpdate = jest.fn().mockResolvedValue({ count: 1 });
    const broadcastUpdate = jest.fn().mockResolvedValue({ count: 1 });
    const tx = {
      publicationOccurrence: { updateMany: publicationOccurrenceUpdate },
      managedBroadcastDelivery: { updateMany: deliveryUpdate },
      managedBroadcast: { updateMany: broadcastUpdate },
    };
    const runtime = new AdminManagedBroadcastRuntime({
      prisma: { $transaction: (callback: (client: typeof tx) => unknown) => callback(tx) },
      publisherRuntimeBoundaryService: {
        assertDispatchEnabled: () => {
          throw new Error('disabled');
        },
      },
      logger: { warn: jest.fn() },
    } as never);

    const result = await (runtime as any).publisherDispatch.ensureRuntimeBoundary(
      {
        id: 'broadcast-publik',
        publicationOccurrenceId: 'occurrence-publik',
      },
      1,
      { lockToken: 'broadcast-lock', lockedAt: new Date(), lastHeartbeatAt: new Date() },
    );

    expect(result).toEqual({ ready: false, retryAt: expect.any(Date) });
    expect(deliveryUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
        }),
        data: expect.objectContaining({
          dispatchBlockerCode: 'PUBLISHER_RUNTIME_UNAVAILABLE',
        }),
      }),
    );
    expect(broadcastUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          lockedAt: null,
          lockToken: null,
        }),
      }),
    );
  });

  it('serializes publisher blocker cleanup writes within the two-connection pool', async () => {
    let releaseOccurrence!: () => void;
    const occurrenceGate = new Promise<{ count: number }>((resolve) => {
      releaseOccurrence = () => resolve({ count: 1 });
    });
    const occurrenceUpdate = jest.fn().mockReturnValue(occurrenceGate);
    const deliveryUpdate = jest.fn().mockResolvedValue({ count: 1 });
    const runtime = new AdminManagedBroadcastRuntime({
      prisma: {
        publicationOccurrence: { updateMany: occurrenceUpdate },
        managedBroadcastDelivery: { updateMany: deliveryUpdate },
      },
      publisherRuntimeBoundaryService: { assertDispatchEnabled: jest.fn() },
    } as never);

    const boundary = (runtime as any).publisherDispatch.ensureRuntimeBoundary(
      { id: 'broadcast-publik', publicationOccurrenceId: 'occurrence-publik' },
      1,
      { lockToken: 'broadcast-lock' },
    );
    while (occurrenceUpdate.mock.calls.length === 0) await Promise.resolve();

    expect(deliveryUpdate).not.toHaveBeenCalled();
    releaseOccurrence();
    await expect(boundary).resolves.toEqual({ ready: true });
    expect(deliveryUpdate).toHaveBeenCalledTimes(1);
  });

  it('serializes claimed-delivery and occurrence deferral writes', async () => {
    let releaseDelivery!: () => void;
    const deliveryGate = new Promise<{ count: number }>((resolve) => {
      releaseDelivery = () => resolve({ count: 1 });
    });
    const deliveryUpdate = jest.fn().mockReturnValue(deliveryGate);
    const occurrenceUpdate = jest.fn().mockResolvedValue({ count: 1 });
    const runtime = new AdminManagedBroadcastRuntime({
      prisma: {
        publicationOccurrence: { updateMany: occurrenceUpdate },
        managedBroadcastDelivery: { updateMany: deliveryUpdate },
      },
    } as never);

    const deferral = (runtime as any).publisherDispatch.deferClaimed({
      row: {
        id: 'broadcast-publik',
        publicationOccurrenceId: 'occurrence-publik',
        requiredBotId: 'publisher-bot',
      },
      delivery: { id: 'delivery-publik', targetChatId: 'chat-1' },
      deliveryLockToken: 'delivery-lock',
      blockerCode: 'PUBLISHER_RUNTIME_UNAVAILABLE',
    });
    while (deliveryUpdate.mock.calls.length === 0) await Promise.resolve();

    expect(occurrenceUpdate).not.toHaveBeenCalled();
    releaseDelivery();
    await expect(deferral).resolves.toBeInstanceOf(Date);
    expect(occurrenceUpdate).toHaveBeenCalledTimes(1);
  });

  it('blocks an individual pending delivery when its policy is toggled off before claim', async () => {
    const deliveryUpdate = jest.fn().mockResolvedValue({ count: 1 });
    const runtime = new AdminManagedBroadcastRuntime({
      prisma: {
        managedBroadcastDelivery: { updateMany: deliveryUpdate },
      },
      publisherRuntimeBoundaryService: { assertDispatchEnabled: jest.fn() },
      publisherDispatchHealthService: {
        assertDispatchAllowed: jest.fn().mockResolvedValue(undefined),
      },
      publisherReadinessService: {
        assertEntityReady: jest
          .fn()
          .mockRejectedValue(
            Object.assign(new Error('disabled'), { blockerCode: 'policy_disabled' }),
          ),
      },
    } as never);

    const retryAt = await (runtime as any).publisherDispatch.deferUnreadyBeforeClaim(
      { id: 'broadcast-publik', publicationOccurrenceId: null },
      { id: 'delivery-publik', targetChatId: 'chat-1' },
      'publisher-bot',
    );

    expect(retryAt).toEqual(expect.any(Date));
    expect(deliveryUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: ManagedBroadcastDeliveryStatus.PENDING,
          requiredBotId: 'publisher-bot',
        }),
        data: {
          dispatchBlockerCode: 'policy_disabled',
          dispatchBlockedAt: expect.any(Date),
        },
      }),
    );
  });
});
