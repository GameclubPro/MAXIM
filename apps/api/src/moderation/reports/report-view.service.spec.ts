import { BadRequestException } from '@nestjs/common';
import { ReportViewService } from './report-view.service';

describe('report journal cursor validation', () => {
  it.each([null, 1, false, ['case'], { gt: '' }, { length: 0 }, 'x'.repeat(201)])(
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
    const prisma = { chatReportCase: { findMany: jest.fn().mockResolvedValue([]) } };
    const service = new ReportViewService(prisma as never, {} as never);
    await expect(service.list('chat')).resolves.toEqual({ items: [], nextCursor: null });
    expect(prisma.chatReportCase.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { chatId: 'chat' }, take: 21 }),
    );
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
    const prisma = {
      chatReportCase: {
        findMany: jest
          .fn()
          .mockResolvedValue(Array.from({ length: 20 }, (_, n) => ({ ...row, id: `case-${n}` }))),
      },
      $queryRaw: jest
        .fn()
        .mockResolvedValue([{ case_id: 'case-0', total: 4n, deleted: 1n, absent: 1n, failed: 1n }]),
      chatReportVote: {
        groupBy: jest
          .fn()
          .mockResolvedValue([{ caseId: 'case-0', contentVersion: 2, _count: { _all: 3 } }]),
      },
    };
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
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.chatReportVote.groupBy).toHaveBeenCalledTimes(1);
    expect(prisma.chatReportVote.groupBy.mock.calls[0]![0].where.OR).toHaveLength(20);
  });
});
