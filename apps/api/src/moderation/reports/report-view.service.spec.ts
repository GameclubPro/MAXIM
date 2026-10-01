import { BadRequestException } from '@nestjs/common';
import { ReportViewService } from './report-view.service';

describe('report journal cursor validation', () => {
  function transactional<T extends Record<string, unknown>>(
    prisma: T,
    counts: unknown[] = [],
    ids: string[] = [],
  ) {
    const database = {
      ...prisma,
      $queryRaw: jest.fn(async (query) =>
        Array.isArray(query) && query[0].includes('CURRENT_TIMESTAMP')
          ? [{ observed_at: new Date('2026-10-01T12:00:00Z') }]
          : query.sql.includes('AS journal_page')
            ? ids.map((id) => ({ id }))
            : counts,
      ),
    };
    return { ...database, $transaction: jest.fn(async (operation) => operation(database)) };
  }
  it.each([null, 1, false, ['case'], { gt: '' }, { length: 0 }, 'x'.repeat(2049)])(
    'rejects invalid HTTP cursor %j before querying Prisma',
    async (cursor) => {
      const prisma = { chatReportCase: { findFirst: jest.fn(), findMany: jest.fn() } };
      const service = new ReportViewService(prisma as never, {} as never);
      await expect(service.list('chat', cursor)).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.chatReportCase.findFirst).not.toHaveBeenCalled();
      expect(prisma.chatReportCase.findMany).not.toHaveBeenCalled();
    },
  );
  it('accepts an omitted cursor and keeps a bounded chat-scoped page', async () => {
    const prisma = transactional({ chatReportCase: { findMany: jest.fn().mockResolvedValue([]) } });
    const service = new ReportViewService(prisma as never, {} as never);
    await expect(service.list('chat')).resolves.toMatchObject({ items: [], nextCursor: null });
    expect(prisma.chatReportCase.findMany).not.toHaveBeenCalled();
    expect(prisma.$queryRaw.mock.calls[1]![0].sql).toContain('LIMIT 21');
    expect(prisma.$queryRaw.mock.calls[1]![0].values).toContain('chat');
  });

  it('aggregates a whole page in two bounded queries and separates absence from deletion', async () => {
    const createdAt = new Date();
    const row = {
      id: 'case',
      messageId: 'message',
      authorId: 'author',
      status: 'PARTIAL',
      contentVersion: 2,
      threshold: 3,
      deleteMode: 'MESSAGE',
      muteHours: null,
      muteEventId: null,
      createdAt,
      expiresAt: createdAt,
      lastError: null,
    };
    const prisma = transactional(
      {
        chatReportCase: {
          findMany: jest
            .fn()
            .mockResolvedValue(Array.from({ length: 20 }, (_, n) => ({ ...row, id: `case-${n}` }))),
        },
        chatReportVote: {
          groupBy: jest
            .fn()
            .mockResolvedValue([{ caseId: 'case-0', contentVersion: 2, _count: { _all: 3 } }]),
        },
      },
      [{ case_id: 'case-0', total: 4n, deleted: 1n, absent: 1n, failed: 1n }],
      Array.from({ length: 20 }, (_, n) => `case-${n}`),
    );
    const page = await new ReportViewService(prisma as never, {} as never).list('chat');
    expect(page.items).toHaveLength(20);
    expect(page.items[0]).toMatchObject({
      candidates: 4,
      deleted: 1,
      absent: 1,
      failed: 1,
      pending: 1,
      votes: 3,
    });
    expect(page.items[1]).toMatchObject({
      candidates: 0,
      deleted: 0,
      absent: 0,
      pending: 0,
      votes: 0,
    });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(3);
    expect(prisma.chatReportVote.groupBy).toHaveBeenCalledTimes(1);
    expect(prisma.chatReportVote.groupBy.mock.calls[0]![0].where.OR).toHaveLength(20);
  });

  it.each([
    { status: ['ACTIVE'] },
    { status: 'unknown' },
    { authorId: {} },
    { from: '2026-10-02T00:00:00Z', to: '2026-10-01T00:00:00Z' },
  ])(
    'rejects malformed HTTP filters before entering a database transaction: %j',
    async (filters) => {
      const prisma = { $transaction: jest.fn() };
      await expect(
        new ReportViewService(prisma as never, {} as never).list('chat', undefined, filters),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    },
  );
  it('binds pagination to the exact chat and normalized filter', async () => {
    const at = new Date('2026-10-01T00:00:00Z');
    const row = {
      id: 'case',
      createdAt: at,
      expiresAt: at,
      messageId: 'target',
      authorId: 'author',
      status: 'COLLECTING',
      contentVersion: 1,
      threshold: 3,
      deleteMode: 'MESSAGE',
      muteHours: null,
      muteEventId: null,
      lastError: null,
    };
    const cases = {
      findMany: jest
        .fn()
        .mockResolvedValue(Array.from({ length: 21 }, (_, n) => ({ ...row, id: `case-${n}` }))),
      findFirst: jest.fn().mockResolvedValue({ ...row, id: 'case-19' }),
    };
    const prisma = transactional(
      {
        chatReportCase: cases,
        chatReportVote: { groupBy: jest.fn().mockResolvedValue([]) },
      },
      [],
      Array.from({ length: 21 }, (_, n) => `case-${n}`),
    );
    const view = new ReportViewService(prisma as never, {} as never);
    const first = await view.list('chat', undefined, { status: 'ACTIVE', authorId: 'author' });
    expect(cases.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { chatId: 'chat', id: { in: Array.from({ length: 21 }, (_, n) => `case-${n}`) } },
      }),
    );
    const sql = prisma.$queryRaw.mock.calls[1]![0];
    expect(sql.values).toEqual(
      expect.arrayContaining(['chat', 'author', 'COLLECTING', 'PENDING', 'RUNNING']),
    );
    expect(sql.sql.match(/LIMIT 21/g)).toHaveLength(4);
    await expect(
      view.list('chat', first.nextCursor, { status: 'ALL', authorId: 'author' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      view.list('other-chat', first.nextCursor, { status: 'ACTIVE', authorId: 'author' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await view.list('chat', first.nextCursor, { status: 'ACTIVE', authorId: 'author' });
    expect(prisma.$transaction).toHaveBeenLastCalledWith(expect.any(Function), {
      isolationLevel: 'RepeatableRead',
    });
  });
  it('advances freshness when only an independent deletion receipt changes', async () => {
    const at = new Date('2026-10-01T00:00:00Z');
    const report = {
      id: 'case',
      createdAt: at,
      updatedAt: at,
      expiresAt: at,
      messageId: 'target',
      authorId: 'author',
      status: 'RUNNING',
      contentVersion: 1,
      threshold: 3,
      deleteMode: 'MESSAGE',
      muteHours: null,
      muteEventId: null,
      lastError: null,
    };
    const counts = {
      case_id: 'case',
      total: 1n,
      deleted: 0n,
      absent: 0n,
      failed: 0n,
      changed_at: at,
    };
    const prisma = {
      $queryRaw: jest.fn(async () => [{ ...counts }]),
      chatReportVote: { groupBy: jest.fn().mockResolvedValue([]) },
    };
    const view = new ReportViewService(prisma as never, {} as never);
    const before = await view.summary(report as never);
    counts.deleted = 1n;
    counts.changed_at = new Date(at.getTime() + 1);
    const after = await view.summary(report as never);
    expect(after.updatedAt).toBe(counts.changed_at.toISOString());
    expect(after.snapshotVersion).not.toBe(before.snapshotVersion);
    expect(after.pending).toBe(0);
  });
  it('returns frozen archived totals without querying removed details', async () => {
    const at = new Date();
    const prisma = { $queryRaw: jest.fn(), chatReportVote: { groupBy: jest.fn() } };
    const report = {
      id: 'case',
      createdAt: at,
      updatedAt: at,
      expiresAt: at,
      detailsArchivedAt: at,
      retainedVotes: 3,
      retainedCandidates: 5,
      retainedDeleted: 2,
      retainedAbsent: 2,
      retainedFailed: 1,
      messageId: 'target',
      authorId: 'author',
      status: 'PARTIAL',
      contentVersion: 1,
      threshold: 3,
      deleteMode: 'MESSAGE',
      muteHours: null,
      muteEventId: null,
      lastError: null,
    };
    expect(
      await new ReportViewService(prisma as never, {} as never).summary(report as never),
    ).toMatchObject({
      detailsArchived: true,
      votes: 3,
      candidates: 5,
      deleted: 2,
      absent: 2,
      failed: 1,
      pending: 0,
    });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.chatReportVote.groupBy).not.toHaveBeenCalled();
  });
  it('reads light availability without journal queries', () => {
    const state = { enabled: jest.fn().mockReturnValue(false) };
    expect(new ReportViewService({} as never, state as never).availability('chat')).toMatchObject({
      reportsAvailable: false,
    });
    expect(state.enabled).toHaveBeenCalledWith('chat');
  });
});
