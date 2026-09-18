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
});
