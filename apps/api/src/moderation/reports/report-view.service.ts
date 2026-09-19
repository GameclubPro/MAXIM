import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { reportSummarySchema, type ReportSummary } from '@maxim/contracts';
import { z } from 'zod';
import type { ChatReportCase } from '../../prisma/prisma-client';
import { PrismaService } from '../../prisma/prisma.service';
import { ReportStateService } from './report-state.service';

const reportCursorSchema = z.string().max(200).optional();

@Injectable()
export class ReportViewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly state: ReportStateService,
  ) {}

  async summary(report: ChatReportCase): Promise<ReportSummary> {
    const counts = await this.prisma.$queryRaw<
      Array<{ total: bigint; deleted: bigint; failed: bigint }>
    >`
      SELECT COUNT(*) AS total,
        COUNT(*) FILTER (WHERE COALESCE(intent.status::text, action.receipt_status) IN ('SUCCEEDED', 'ALREADY_ABSENT')) AS deleted,
        COUNT(*) FILTER (WHERE COALESCE(intent.status::text, action.receipt_status) IN ('EXPIRED', 'FAILED_TERMINAL')) AS failed
      FROM chat_report_actions action
      LEFT JOIN moderation_delete_intents intent ON intent.id = action.intent_id
      WHERE action.case_id = ${report.id}
    `;
    const count = counts[0];
    const candidates = Number(count?.total ?? 0);
    const deleted = Number(count?.deleted ?? 0);
    const failed = Number(count?.failed ?? 0);
    const votes = await this.prisma.chatReportVote.count({
      where: { caseId: report.id, contentVersion: report.contentVersion },
    });
    return reportSummarySchema.parse({
      ...report,
      votes,
      candidates,
      deleted,
      failed,
      pending: candidates - deleted - failed,
      muteApplied: Boolean(report.muteEventId),
      createdAt: report.createdAt.toISOString(),
      expiresAt: report.expiresAt.toISOString(),
    });
  }

  async list(chatId: string, cursorInput?: unknown) {
    const parsed = reportCursorSchema.safeParse(cursorInput);
    if (!parsed.success) throw new BadRequestException('Некорректный курсор.');
    const cursor = parsed.data;
    const anchor = cursor
      ? await this.prisma.chatReportCase.findFirst({ where: { id: cursor, chatId } })
      : null;
    if (cursor && !anchor) throw new BadRequestException('Некорректный курсор.');
    const rows = await this.prisma.chatReportCase.findMany({
      where: {
        chatId,
        ...(anchor
          ? {
              OR: [
                { createdAt: { lt: anchor.createdAt } },
                { createdAt: anchor.createdAt, id: { lt: anchor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 21,
    });
    const page = rows.slice(0, 20);
    return {
      items: await Promise.all(page.map((row) => this.summary(row))),
      nextCursor: rows.length > 20 ? page.at(-1)!.id : null,
    };
  }

  async detail(chatId: string, id: string) {
    const report = await this.find(chatId, id);
    const reporters = await this.prisma.chatReportVote.findMany({
      where: { caseId: id, contentVersion: report.contentVersion },
      orderBy: { createdAt: 'asc' },
      select: { reporterId: true, createdAt: true },
    });
    const names = await this.prisma.chatUserDisplayName.findMany({
      where: {
        chatId,
        userId: { in: [report.authorId, ...reporters.map((v) => v.reporterId)] },
      },
      select: { userId: true, displayName: true },
    });
    const namesById = new Map(names.map((row) => [row.userId, row.displayName]));
    return {
      ...(await this.summary(report)),
      authorName: namesById.get(report.authorId) ?? null,
      reporters: reporters.map((v) => ({
        userId: v.reporterId,
        displayName: namesById.get(v.reporterId) ?? null,
        createdAt: v.createdAt.toISOString(),
      })),
    };
  }

  async dismiss(chatId: string, id: string, actorUserId: string) {
    await this.state.transaction(chatId, async (tx) => {
      const report = await tx.chatReportCase.findFirst({ where: { id, chatId } });
      if (!report) throw new NotFoundException('Жалоба не найдена.');
      if (report.status === 'DISMISSED') return;
      if (!['COLLECTING', 'PENDING'].includes(report.status))
        throw new BadRequestException('Сбор уже закрыт.');
      await tx.chatReportCase.update({
        where: { id },
        data: { status: 'DISMISSED', dueAt: new Date() },
      });
      await tx.auditLog.create({
        data: { chatId, actorUserId, action: 'REPORT_DISMISSED', payload: { reportCaseId: id } },
      });
    });
    return this.detail(chatId, id);
  }

  private async find(chatId: string, id: string) {
    const report = await this.prisma.chatReportCase.findFirst({ where: { id, chatId } });
    if (!report) throw new NotFoundException('Жалоба не найдена.');
    return report;
  }
}
