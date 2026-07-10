import { ChatEntityType } from '../prisma/prisma-client';
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
});
