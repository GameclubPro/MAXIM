import {
  decodePublicationListCursor,
  type PublicationDeliveryStats,
} from '@maxim/contracts/publication';
import {
  ManagedBroadcastDeliveryStatus,
  PublicationLifecycle,
  PublicationOccurrenceStatus,
} from '../prisma/prisma-client';
import { PublicationPresenterService } from './publication-presenter.service';
import { PublicationService } from './publication.service';

const EMPTY_DELIVERY_STATS: PublicationDeliveryStats = {
  total: 0,
  pending: 0,
  sent: 0,
  failed: 0,
  ambiguous: 0,
  canceled: 0,
};

function publicationRow(id: string, updatedAt = new Date('2026-07-10T09:00:00.000Z')) {
  return {
    id,
    title: `Публикация ${id}`,
    lifecycle: PublicationLifecycle.ACTIVE,
    version: 1,
    audienceSelection: 'SELECTED',
    audienceMode: 'SNAPSHOT',
    canonicalContentRevision: { text: `Текст ${id}`, assets: [] },
    targets: [],
    schedule: null,
    occurrences: [],
    createdAt: new Date('2026-07-10T08:00:00.000Z'),
    updatedAt,
  };
}

function createPublicationService(prisma: Record<string, unknown>) {
  const presenter = new PublicationPresenterService(prisma as never);
  const service = new PublicationService(
    prisma as never,
    {} as never,
    presenter,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { presenter, service };
}

describe('Publication performance and pagination', () => {
  it('loads delivery aggregates once for the whole publication page', async () => {
    const rows = [publicationRow('publication-2'), publicationRow('publication-1')];
    const groupBy = jest.fn();
    const queryRaw = jest.fn().mockResolvedValue([
      {
        publicationId: 'publication-2',
        status: ManagedBroadcastDeliveryStatus.SENT,
        count: 3n,
      },
      {
        publicationId: 'publication-1',
        status: ManagedBroadcastDeliveryStatus.FAILED,
        count: 2n,
      },
    ]);
    const prisma = {
      publication: { findMany: jest.fn().mockResolvedValue(rows) },
      managedBroadcastDelivery: { groupBy },
      $queryRaw: queryRaw,
    };
    const { service } = createPublicationService(prisma);

    const result = await service.list({ userId: 'user-1' } as never, {
      view: 'plan',
      limit: 2,
    });

    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(groupBy).not.toHaveBeenCalled();
    expect(result.items.map((item) => item.delivery)).toEqual([
      { ...EMPTY_DELIVERY_STATS, total: 3, sent: 3 },
      { ...EMPTY_DELIVERY_STATS, total: 2, failed: 2 },
    ]);
  });

  it('binds an opaque cursor to the list filters and applies an explicit keyset predicate', async () => {
    const updatedAt = new Date('2026-07-10T09:00:00.000Z');
    const firstPageRows = [
      publicationRow('publication-z', updatedAt),
      publicationRow('publication-y', updatedAt),
    ];
    const findMany = jest
      .fn()
      .mockResolvedValueOnce(firstPageRows)
      .mockResolvedValueOnce([publicationRow('publication-y', updatedAt)]);
    const prisma = {
      publication: { findMany },
      managedBroadcastDelivery: { groupBy: jest.fn() },
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    const { service } = createPublicationService(prisma);

    const firstPage = await service.list({ userId: 'user-1' } as never, {
      view: 'plan',
      query: 'Текст',
      limit: 1,
    });
    const cursor = firstPage.nextCursor;
    expect(cursor).not.toBe('publication-z');
    expect(cursor && decodePublicationListCursor(cursor)).toEqual({
      v: 1,
      updatedAt: updatedAt.toISOString(),
      id: 'publication-z',
      view: 'plan',
      query: 'Текст',
    });

    await service.list({ userId: 'user-1' } as never, {
      view: 'plan',
      query: 'Текст',
      cursor: cursor ?? undefined,
      limit: 1,
    });

    expect(findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          AND: [
            {
              OR: [
                { title: { contains: 'Текст', mode: 'insensitive' } },
                {
                  canonicalContentRevision: {
                    is: { text: { contains: 'Текст', mode: 'insensitive' } },
                  },
                },
                {
                  targets: {
                    some: { chat: { title: { contains: 'Текст', mode: 'insensitive' } } },
                  },
                },
              ],
            },
            {
              OR: [{ updatedAt: { lt: updatedAt } }, { updatedAt, id: { lt: 'publication-z' } }],
            },
          ],
        }),
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: 2,
      }),
    );
    expect(findMany.mock.calls[1]?.[0]).not.toHaveProperty('cursor');
    expect(findMany.mock.calls[1]?.[0]).not.toHaveProperty('skip');

    await expect(
      service.list({ userId: 'user-1' } as never, {
        view: 'history',
        query: 'Текст',
        cursor: cursor ?? undefined,
        limit: 1,
      }),
    ).rejects.toThrow('Курсор списка публикаций недействителен.');
  });

  it('paginates deliveries with a limit-plus-one query and a Prisma cursor', async () => {
    const deliveryRow = (id: string, targetChatId: string) => ({
      id,
      targetChatId,
      status: ManagedBroadcastDeliveryStatus.PENDING,
      attemptCount: 0,
      remoteMessageId: null,
      lastError: null,
      sentAt: null,
      createdAt: new Date('2026-07-10T09:00:00.000Z'),
      broadcast: { entityType: 'CHAT' },
      publicationOccurrence: { id: 'occurrence-1' },
    });
    const findMany = jest
      .fn()
      .mockResolvedValueOnce([
        deliveryRow('delivery-3', 'chat-3'),
        deliveryRow('delivery-2', 'chat-2'),
        deliveryRow('delivery-1', 'chat-1'),
      ])
      .mockResolvedValueOnce([deliveryRow('delivery-1', 'chat-1')]);
    const prisma = {
      publication: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'publication-1',
          version: 1,
          lifecycle: PublicationLifecycle.ACTIVE,
        }),
      },
      managedBroadcastDelivery: { findMany },
      chat: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'chat-1', title: 'Чат 1' },
          { id: 'chat-2', title: 'Чат 2' },
          { id: 'chat-3', title: 'Чат 3' },
        ]),
      },
    };
    const { service } = createPublicationService(prisma);
    const user = { userId: 'user-1' } as never;
    const query = {
      occurrenceId: 'occurrence-1',
      excludeStatus: ManagedBroadcastDeliveryStatus.AMBIGUOUS,
      limit: 2,
    };

    const firstPage = await service.listDeliveries('publication-1', user, query);

    expect(firstPage.items.map((item) => item.id)).toEqual(['delivery-3', 'delivery-2']);
    expect(firstPage.nextCursor).toBe('delivery-2');
    expect(findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: {
          publicationOccurrence: {
            is: { publicationId: 'publication-1', id: 'occurrence-1' },
          },
          status: { not: ManagedBroadcastDeliveryStatus.AMBIGUOUS },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 3,
      }),
    );
    expect(findMany.mock.calls[0]?.[0]).not.toHaveProperty('cursor');
    expect(findMany.mock.calls[0]?.[0]).not.toHaveProperty('skip');

    const secondPage = await service.listDeliveries('publication-1', user, {
      ...query,
      cursor: firstPage.nextCursor ?? undefined,
    });

    expect(secondPage.items.map((item) => item.id)).toEqual(['delivery-1']);
    expect(secondPage.nextCursor).toBeNull();
    expect(findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 3,
        cursor: { id: 'delivery-2' },
        skip: 1,
      }),
    );
  });

  it('loads occurrence delivery counts as grouped aggregates without nested delivery rows', async () => {
    const occurrence = {
      id: 'occurrence-1',
      publicationId: 'publication-1',
      scheduledAt: new Date('2026-07-10T09:00:00.000Z'),
      status: PublicationOccurrenceStatus.FAILED,
    };
    const publicationFindFirst = jest.fn().mockResolvedValue({
      ...publicationRow('publication-1'),
      occurrences: [occurrence],
    });
    const occurrenceFindMany = jest.fn().mockResolvedValue([occurrence]);
    const groupBy = jest
      .fn()
      .mockResolvedValueOnce([
        { status: ManagedBroadcastDeliveryStatus.FAILED, _count: { _all: 2 } },
      ])
      .mockResolvedValueOnce([
        {
          publicationOccurrenceId: 'occurrence-1',
          status: ManagedBroadcastDeliveryStatus.FAILED,
          _count: { _all: 2 },
        },
      ]);
    const prisma = {
      publication: { findFirst: publicationFindFirst },
      publicationOccurrence: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: occurrenceFindMany,
      },
      managedBroadcastDelivery: { groupBy },
    };
    const presenter = new PublicationPresenterService(prisma as never);

    const row = await presenter.loadPublicationDetailsRow('publication-1', 'user-1');

    expect(publicationFindFirst.mock.calls[0]?.[0].include.occurrences).not.toHaveProperty(
      'include',
    );
    expect(occurrenceFindMany.mock.calls[0]?.[0]).not.toHaveProperty('include');
    expect(groupBy).toHaveBeenCalledTimes(2);
    expect(groupBy).toHaveBeenNthCalledWith(2, {
      by: ['publicationOccurrenceId', 'status'],
      where: { publicationOccurrenceId: { in: ['occurrence-1'] } },
      _count: { _all: true },
    });
    expect(row?.deliveryStats).toEqual({ ...EMPTY_DELIVERY_STATS, total: 2, failed: 2 });
    expect(row?.occurrences[0]?.deliveryStats).toEqual({
      ...EMPTY_DELIVERY_STATS,
      total: 2,
      failed: 2,
    });
  });
});
