import { ManagedEntityCandidateSyncService } from './managed-entity-candidate-sync.service';

type QueryRawMock = jest.Mock<Promise<unknown[]>, unknown[]>;

function createPrismaMock(...results: unknown[][]) {
  const $queryRaw: QueryRawMock = jest
    .fn()
    .mockImplementation(() => Promise.resolve(results.shift() ?? []));
  return { $queryRaw };
}

describe('ManagedEntityCandidateSyncService', () => {
  const now = new Date('2026-06-20T12:00:00.000Z');

  it('returns bounded candidates from local activity rows and filters private direct chats', async () => {
    const service = new ManagedEntityCandidateSyncService();
    const prisma = createPrismaMock([
      {
        chat_id: '-100',
        chat_title: 'Рабочий чат',
        chat_type: 'chat',
        created_at: new Date('2026-06-20T11:59:00.000Z'),
      },
      {
        chat_id: '12345',
        chat_title: 'Личный диалог',
        chat_type: 'chat',
        created_at: new Date('2026-06-20T11:58:00.000Z'),
      },
      {
        chat_id: '-200',
        chat_title: 'Рабочий канал',
        chat_type: 'channel',
        created_at: new Date('2026-06-20T11:57:00.000Z'),
      },
      {
        chat_id: '-300',
        chat_title: 'Лишний чат',
        chat_type: 'chat',
        created_at: new Date('2026-06-20T11:56:00.000Z'),
      },
    ]);

    await expect(
      service.loadLocalDiscoverySnapshot(prisma as never, ' admin-1 ', 'all', {
        limit: 3,
        now,
      }),
    ).resolves.toEqual([
      {
        chatId: '-100',
        title: 'Рабочий чат',
        lastEventTime: Date.parse('2026-06-20T11:59:00.000Z'),
        entityType: 'chat',
        link: null,
        avatarUrl: null,
      },
      {
        chatId: '-200',
        title: 'Рабочий канал',
        lastEventTime: Date.parse('2026-06-20T11:57:00.000Z'),
        entityType: 'channel',
        link: null,
        avatarUrl: null,
      },
    ]);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('filters candidates by requested entity type', async () => {
    const service = new ManagedEntityCandidateSyncService();
    const prisma = createPrismaMock([
      {
        chat_id: '-100',
        chat_title: 'Рабочий чат',
        chat_type: 'chat',
        created_at: now,
      },
      {
        chat_id: '-200',
        chat_title: 'Рабочий канал',
        chat_type: 'channel',
        created_at: now,
      },
    ]);

    await expect(
      service.loadLocalDiscoverySnapshot(prisma as never, 'admin-1', 'channel', {
        limit: 10,
        now,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        chatId: '-200',
        title: 'Рабочий канал',
        entityType: 'channel',
      }),
    ]);
  });

  it('pushes requested entity type filtering into local activity SQL before limiting', async () => {
    const service = new ManagedEntityCandidateSyncService();
    const prisma = createPrismaMock([
      {
        chat_id: '-200',
        chat_title: 'Рабочий канал',
        chat_type: 'channel',
        created_at: now,
      },
    ]);

    await expect(
      service.loadLocalDiscoverySnapshot(prisma as never, 'admin-1', 'channel', {
        limit: 1,
        now,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        chatId: '-200',
        entityType: 'channel',
      }),
    ]);
    expect(readSqlValues(prisma.$queryRaw.mock.calls[0]?.[0])).toContain('CHANNEL');
  });

  it('falls back to webhook events when local activity has no rows', async () => {
    const service = new ManagedEntityCandidateSyncService();
    const prisma = createPrismaMock(
      [],
      [
        {
          chat_id: '-500',
          chat_title: 'Из webhook',
          chat_type: 'chat',
          created_at: new Date('2026-06-20T10:00:00.000Z'),
        },
      ],
    );

    await expect(
      service.loadLocalDiscoverySnapshot(prisma as never, 'admin-1', 'all', {
        limit: 50,
        now,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        chatId: '-500',
        title: 'Из webhook',
        entityType: 'chat',
      }),
    ]);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it('pushes requested entity type filtering into webhook fallback SQL before limiting', async () => {
    const service = new ManagedEntityCandidateSyncService();
    const prisma = createPrismaMock(
      [],
      [
        {
          chat_id: '-500',
          chat_title: 'Канал из webhook',
          chat_type: 'channel',
          created_at: new Date('2026-06-20T10:00:00.000Z'),
        },
      ],
    );

    await expect(
      service.loadLocalDiscoverySnapshot(prisma as never, 'admin-1', 'channel', {
        limit: 1,
        now,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        chatId: '-500',
        entityType: 'channel',
      }),
    ]);
    expect(readSqlValues(prisma.$queryRaw.mock.calls[1]?.[0])).toContain('channel');
  });

  it('allows webhook fallback channels resolved from stored chat metadata', async () => {
    const service = new ManagedEntityCandidateSyncService();
    const prisma = createPrismaMock(
      [],
      [
        {
          chat_id: '-501',
          chat_title: 'Канал из chats',
          chat_type: 'channel',
          created_at: new Date('2026-06-20T10:01:00.000Z'),
        },
      ],
    );

    await expect(
      service.loadLocalDiscoverySnapshot(prisma as never, 'admin-1', 'channel', {
        limit: 1,
        now,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        chatId: '-501',
        title: 'Канал из chats',
        entityType: 'channel',
      }),
    ]);
    expect(readSqlValues(prisma.$queryRaw.mock.calls[1]?.[0])).toEqual(
      expect.arrayContaining(['channel', 'CHANNEL']),
    );
  });

  it('returns an empty snapshot for blank user ids without querying', async () => {
    const service = new ManagedEntityCandidateSyncService();
    const prisma = createPrismaMock([]);

    await expect(
      service.loadLocalDiscoverySnapshot(prisma as never, '   ', 'all', {
        limit: 50,
        now,
      }),
    ).resolves.toEqual([]);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });
});

function readSqlValues(value: unknown): unknown[] {
  return value && typeof value === 'object' && Array.isArray((value as { values?: unknown[] }).values)
    ? (value as { values: unknown[] }).values
    : [];
}
