import {
  decodePublicationListCursor,
  encodePublicationListCursor,
  type PublicationDeliveryStats,
} from '@maxim/contracts/publication';
import {
  ManagedBroadcastDeliveryStatus,
  PublicationDispatchProfile,
  PublicationLifecycle,
  PublicationOccurrenceStatus,
  PublicationScheduleMode,
  PublicationScheduleStatus,
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

function extractSqlText(query: unknown): string {
  const strings = (query as { strings?: readonly string[] } | null)?.strings;
  return (Array.isArray(strings) ? strings.join('?') : String(query)).replace(/\s+/gu, ' ').trim();
}

function extractSqlValues(query: unknown): readonly unknown[] {
  return (query as { values?: readonly unknown[] } | null)?.values ?? [];
}

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
    {} as never,
  );
  return { presenter, service };
}

describe('Publication performance and pagination', () => {
  it('loads delivery aggregates once for the whole publication page', async () => {
    const rows = [publicationRow('publication-2'), publicationRow('publication-1')];
    const groupBy = jest.fn();
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([
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
      ])
      .mockResolvedValueOnce([
        {
          publicationId: 'publication-2',
          status: ManagedBroadcastDeliveryStatus.SENT,
          count: 3n,
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

    expect(queryRaw).toHaveBeenCalledTimes(2);
    expect(groupBy).not.toHaveBeenCalled();
    expect(result.items.map((item) => item.delivery)).toEqual([
      { ...EMPTY_DELIVERY_STATS, total: 3, sent: 3 },
      { ...EMPTY_DELIVERY_STATS, total: 2, failed: 2 },
    ]);
    expect(result.items.map((item) => item.actionableDelivery)).toEqual([
      { ...EMPTY_DELIVERY_STATS, total: 3, sent: 3 },
      EMPTY_DELIVERY_STATS,
    ]);
  });

  it('lists one-time publications with other scheduled publications', async () => {
    const prisma = {
      publication: { findMany: jest.fn().mockResolvedValue([]) },
      managedBroadcastDelivery: { groupBy: jest.fn() },
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    const { service } = createPublicationService(prisma);

    await service.list({ userId: 'user-1' } as never, {
      view: 'schedules',
      limit: 30,
    });

    expect(prisma.publication.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          AND: [
            {
              schedule: {
                is: {
                  mode: {
                    in: [
                      PublicationScheduleMode.ONCE,
                      PublicationScheduleMode.SLOTS,
                      PublicationScheduleMode.RECURRENCE,
                    ],
                  },
                },
              },
            },
          ],
        }),
      }),
    );
  });

  it('keeps the current view exclusive to immediate publications', async () => {
    const prisma = {
      publication: { findMany: jest.fn().mockResolvedValue([]) },
      managedBroadcastDelivery: { groupBy: jest.fn() },
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    const { service } = createPublicationService(prisma);

    await service.list({ userId: 'user-1' } as never, {
      view: 'current',
      limit: 30,
    });

    expect(prisma.publication.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          AND: [{ schedule: { is: { mode: PublicationScheduleMode.NOW } } }],
        }),
      }),
    );
  });

  it('scopes list reads to the immutable dispatch profile', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const { service } = createPublicationService({
      publication: { findMany },
      managedBroadcastDelivery: { groupBy: jest.fn() },
      $queryRaw: jest.fn().mockResolvedValue([]),
    });

    await service.list(
      { userId: 'user-1' } as never,
      { view: 'plan', limit: 30 },
      PublicationDispatchProfile.PUBLIK_V1,
    );

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          actorUserId: 'user-1',
          dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
        }),
      }),
    );
  });

  it('hides publication details owned by another dispatch profile', async () => {
    const { presenter, service } = createPublicationService({});
    jest.spyOn(presenter, 'loadPublicationDetailsRow').mockResolvedValue({
      dispatchProfile: PublicationDispatchProfile.LEGACY_ROUTED,
    } as never);
    const mapDetails = jest.spyOn(presenter, 'mapPublicationDetails');

    await expect(
      service.get(
        'publication-legacy',
        { userId: 'user-1' } as never,
        PublicationDispatchProfile.PUBLIK_V1,
      ),
    ).rejects.toThrow('Публикация не найдена.');
    expect(mapDetails).not.toHaveBeenCalled();
  });

  it('uses the same current-revision failure selector for immediate publications', async () => {
    const queryRaw = jest.fn().mockResolvedValue([]);
    const findMany = jest.fn();
    const { service } = createPublicationService({
      publication: { findMany },
      managedBroadcastDelivery: { groupBy: jest.fn() },
      $queryRaw: queryRaw,
    });

    await service.list(
      { userId: 'user-1' } as never,
      {
        view: 'current',
        status: 'failed',
        limit: 30,
      },
      PublicationDispatchProfile.PUBLIK_V1,
    );

    const selectorSql = extractSqlText(queryRaw.mock.calls[0]?.[0]);
    expect(selectorSql).toContain('schedule."mode" = \'NOW\'::"PublicationScheduleMode"');
    expect(selectorSql).toContain('occurrence."schedule_revision" = schedule."revision"');
    expect(selectorSql).toContain(
      'publication."dispatch_profile" = CAST(? AS "PublicationDispatchProfile")',
    );
    expect(extractSqlValues(queryRaw.mock.calls[0]?.[0])).toContain(
      PublicationDispatchProfile.PUBLIK_V1,
    );
    expect(findMany).not.toHaveBeenCalled();
  });

  it('paginates schedule errors and active current-revision failures without obsolete-only rows', async () => {
    const updatedAt = new Date('2026-07-10T09:00:00.000Z');
    const cursorUpdatedAt = new Date('2026-07-10T10:00:00.000Z');
    const row = {
      ...publicationRow('publication-active-recurrence', updatedAt),
      lifecycle: PublicationLifecycle.ACTIVE,
      schedule: {
        id: 'schedule-1',
        mode: PublicationScheduleMode.RECURRENCE,
        timezone: 'Europe/Moscow',
        rule: {
          mode: 'recurrence',
          timezone: 'Europe/Moscow',
          frequency: 'daily',
          interval: 1,
          weekdays: [],
          times: ['10:00'],
          startsAt: null,
          endsAt: null,
          maxOccurrences: null,
          replaceConflicts: false,
        },
        revision: 4,
        status: PublicationScheduleStatus.ACTIVE,
        lastError: null,
      },
      occurrences: [
        {
          id: 'occurrence-future',
          status: PublicationOccurrenceStatus.SCHEDULED,
          scheduledAt: new Date('2026-07-11T10:00:00.000Z'),
        },
      ],
    };
    const scheduleErrorRow = {
      ...publicationRow('publication-schedule-error', new Date('2026-07-10T08:30:00.000Z')),
      lifecycle: PublicationLifecycle.ERROR,
      schedule: {
        ...row.schedule,
        id: 'schedule-error',
        revision: 5,
        status: PublicationScheduleStatus.ERROR,
        lastError: 'Расписание не содержит будущих запусков.',
      },
      occurrences: [],
    };
    const obsoleteOnlyId = 'publication-obsolete-only';
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([
        { id: row.id, updatedAt },
        { id: scheduleErrorRow.id, updatedAt: scheduleErrorRow.updatedAt },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const findMany = jest.fn().mockResolvedValue([row, scheduleErrorRow]);
    const prisma = {
      publication: { findMany },
      managedBroadcastDelivery: { groupBy: jest.fn() },
      $queryRaw: queryRaw,
    };
    const { service } = createPublicationService(prisma);
    const cursor = encodePublicationListCursor({
      v: 1,
      updatedAt: cursorUpdatedAt.toISOString(),
      id: 'publication-z',
      view: 'schedules',
      query: '',
      status: 'failed',
    });

    const result = await service.list({ userId: 'user-1' } as never, {
      view: 'schedules',
      status: 'failed',
      cursor,
      limit: 3,
    });

    expect(result.items.map((item) => item.id)).toEqual([row.id, scheduleErrorRow.id]);
    expect(result.items.map((item) => item.id)).not.toContain(obsoleteOnlyId);
    expect(result.items[0]?.lifecycle).toBe('ACTIVE');
    expect(result.items[0]?.schedule?.nextOccurrenceAt).toBe('2026-07-11T10:00:00.000Z');
    expect(result.items[1]?.lifecycle).toBe('ERROR');
    expect(result.items[1]?.schedule?.lastError).toBe('Расписание не содержит будущих запусков.');
    expect(queryRaw).toHaveBeenCalledTimes(3);
    const selectorSql = extractSqlText(queryRaw.mock.calls[0]?.[0]);
    expect(selectorSql).toContain('occurrence."schedule_revision" = schedule."revision"');
    expect(selectorSql).toContain(
      'publication."lifecycle" = \'ERROR\'::"PublicationLifecycle" OR EXISTS',
    );
    expect(selectorSql).toContain(
      '\'FAILED\'::"PublicationOccurrenceStatus", \'PARTIAL\'::"PublicationOccurrenceStatus", \'AMBIGUOUS\'::"PublicationOccurrenceStatus"',
    );
    expect(selectorSql).toContain('publication."updated_at" < ?');
    expect(selectorSql).toContain('publication."id" < ?');
    expect(selectorSql).toMatch(
      /ORDER BY publication\."updated_at" DESC, publication\."id" DESC LIMIT \?$/u,
    );
    expect(extractSqlValues(queryRaw.mock.calls[0]?.[0]).at(-1)).toBe(4);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          lifecycle: {
            in: [
              PublicationLifecycle.ACTIVE,
              PublicationLifecycle.PAUSED,
              PublicationLifecycle.ERROR,
            ],
          },
          id: { in: [row.id, scheduleErrorRow.id] },
        }),
        take: 4,
      }),
    );
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
    const deliveryRow = (
      id: string,
      targetChatId: string,
      contentRevisionId = 'content-current',
      contentRevision = 2,
    ) => ({
      id,
      targetChatId,
      status: ManagedBroadcastDeliveryStatus.PENDING,
      attemptCount: 0,
      remoteMessageId: null,
      lastError: null,
      sentAt: null,
      createdAt: new Date('2026-07-10T09:00:00.000Z'),
      broadcast: { entityType: 'CHAT' },
      contentRevision: { id: contentRevisionId, revision: contentRevision },
      publicationOccurrence: {
        id: 'occurrence-1',
        publication: { canonicalContentRevisionId: 'content-current' },
      },
    });
    const findMany = jest
      .fn()
      .mockResolvedValueOnce([
        deliveryRow('delivery-3', 'chat-3'),
        deliveryRow('delivery-2', 'chat-2', 'content-old', 1),
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
    expect(
      firstPage.items.map(({ contentRevision, usesLatestContent }) => ({
        contentRevision,
        usesLatestContent,
      })),
    ).toEqual([
      { contentRevision: 2, usesLatestContent: true },
      { contentRevision: 1, usesLatestContent: false },
    ]);
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
        include: {
          broadcast: { select: { entityType: true } },
          contentRevision: { select: { id: true, revision: true } },
          publicationOccurrence: {
            select: {
              id: true,
              publication: { select: { canonicalContentRevisionId: true } },
            },
          },
        },
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
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    const presenter = new PublicationPresenterService(prisma as never);

    const row = await presenter.loadPublicationDetailsRow('publication-1', 'user-1');

    expect(publicationFindFirst.mock.calls[0]?.[0].include.occurrences.include).toEqual({
      contentRevision: { select: { revision: true } },
      _count: { select: { legacyBroadcasts: true } },
    });
    expect(occurrenceFindMany.mock.calls[0]?.[0].include).toEqual({
      contentRevision: { select: { revision: true } },
      _count: { select: { legacyBroadcasts: true } },
    });
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
