import { createHash } from 'node:crypto';
import { BadRequestException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import {
  reportJournalFiltersSchema,
  reportSummarySchema,
  type ReportSummary,
} from '@maxim/contracts';
import { z } from 'zod';
import { Prisma, type ChatReportCase } from '../../prisma/prisma-client';
import { PrismaService } from '../../prisma/prisma.service';
import { ReportStateService } from './report-state.service';
import { ReportTelemetryService } from './report-telemetry.service';
import { reportJournalPageQuery } from './report-journal-query.util';

const reportCursorSchema = z.string().max(2048).optional();
const cursorPayloadSchema = z
  .object({
    v: z.literal(1),
    chatId: z.string(),
    filter: z.string().length(64),
    id: z.string().min(1).max(128),
    createdAt: z.string().datetime(),
  })
  .strict();

@Injectable()
export class ReportViewService {
  // FLAG: Deleted report details require retained-total readers and closed archive tombstones forever.
  static readonly ARCHIVE_READER_VERSION = 1;
  constructor(
    private readonly prisma: PrismaService,
    private readonly state: ReportStateService,
    @Optional() private readonly telemetry?: ReportTelemetryService,
  ) {}

  available(chatId: string): boolean {
    return this.state.enabled(chatId);
  }

  availability(chatId: string) {
    return { reportsAvailable: this.available(chatId), observedAt: new Date().toISOString() };
  }

  async summary(
    report: ChatReportCase,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<ReportSummary> {
    return (await this.summaries([report], db))[0]!;
  }

  private async summaries(
    reports: readonly ChatReportCase[],
    db: Prisma.TransactionClient,
  ): Promise<ReportSummary[]> {
    if (reports.length === 0) return [];
    const live = reports.filter((report) => !report.detailsArchivedAt);
    const counts = live.length
      ? await db.$queryRaw<
          Array<{
            case_id: string;
            total: bigint;
            deleted: bigint;
            absent: bigint;
            failed: bigint;
            changed_at: Date | null;
          }>
        >(Prisma.sql`
      SELECT action.case_id, COUNT(*) AS total,
        COUNT(*) FILTER (WHERE COALESCE(intent.status::text, action.receipt_status) = 'SUCCEEDED') AS deleted,
        COUNT(*) FILTER (WHERE COALESCE(intent.status::text, action.receipt_status) = 'ALREADY_ABSENT') AS absent,
        COUNT(*) FILTER (WHERE COALESCE(intent.status::text, action.receipt_status) IN ('EXPIRED', 'FAILED_TERMINAL')) AS failed,
        MAX(GREATEST(intent.updated_at, action.receipt_updated_at, action.created_at)) AS changed_at
      FROM chat_report_actions action
      LEFT JOIN moderation_delete_intents intent ON intent.id = action.intent_id
      WHERE action.case_id IN (${Prisma.join(live.map((report) => report.id))})
      GROUP BY action.case_id
    `)
      : [];
    const voteCounts = live.length
      ? await db.chatReportVote.groupBy({
          by: ['caseId', 'contentVersion'],
          where: {
            OR: live.map((report) => ({
              caseId: report.id,
              contentVersion: report.contentVersion,
            })),
          },
          _count: { _all: true },
          _max: { createdAt: true },
        })
      : [];
    const actionsByCase = new Map(counts.map((count) => [count.case_id, count]));
    const votesByCase = new Map(voteCounts.map((count) => [count.caseId, count]));
    return reports.map((report) => {
      const count = actionsByCase.get(report.id);
      const votesRow = votesByCase.get(report.id);
      const archived = Boolean(report.detailsArchivedAt);
      const candidates = archived ? report.retainedCandidates : Number(count?.total ?? 0);
      const deleted = archived ? report.retainedDeleted : Number(count?.deleted ?? 0);
      const absent = archived ? report.retainedAbsent : Number(count?.absent ?? 0);
      const failed = archived ? report.retainedFailed : Number(count?.failed ?? 0);
      const votes = archived ? report.retainedVotes : (votesRow?._count._all ?? 0);
      // FLAG: Deletion receipts advance independently of the case row and participate in freshness.
      const updatedAt = new Date(
        Math.max(
          (report.updatedAt ?? report.createdAt).getTime(),
          count?.changed_at?.getTime() ?? 0,
          votesRow?._max?.createdAt?.getTime() ?? 0,
          report.detailsArchivedAt?.getTime() ?? 0,
        ),
      ).toISOString();
      const result = {
        ...report,
        votes,
        candidates,
        deleted,
        absent,
        failed,
        pending: candidates - deleted - absent - failed,
        muteApplied: Boolean(report.muteEventId),
        detailsArchived: archived,
        updatedAt,
        contentVersion: report.contentVersion,
        createdAt: report.createdAt.toISOString(),
        expiresAt: report.expiresAt.toISOString(),
      };
      const snapshotVersion = createHash('sha256')
        .update(
          JSON.stringify({
            status: report.status,
            version: report.contentVersion,
            policy: report.policyRevision,
            votes,
            candidates,
            deleted,
            absent,
            failed,
            mute: result.muteApplied,
            error: report.lastError,
            archived,
            updatedAt,
          }),
        )
        .digest('hex');
      return reportSummarySchema.parse({ ...result, snapshotVersion });
    });
  }

  async list(chatId: string, cursorInput?: unknown, filtersInput: unknown = {}) {
    const parsed = reportCursorSchema.safeParse(cursorInput);
    const parsedFilters = reportJournalFiltersSchema.safeParse(filtersInput);
    if (!parsed.success || !parsedFilters.success)
      throw new BadRequestException('Некорректные фильтры или курсор.');
    const filters = {
      ...parsedFilters.data,
      ...(parsedFilters.data.from ? { from: new Date(parsedFilters.data.from).toISOString() } : {}),
      ...(parsedFilters.data.to ? { to: new Date(parsedFilters.data.to).toISOString() } : {}),
    };
    const filter = createHash('sha256').update(JSON.stringify(filters)).digest('hex');
    let cursor: z.infer<typeof cursorPayloadSchema> | undefined;
    if (parsed.data) {
      try {
        cursor = cursorPayloadSchema.parse(
          JSON.parse(Buffer.from(parsed.data, 'base64url').toString('utf8')),
        );
        if (cursor.chatId !== chatId || cursor.filter !== filter) throw new Error('binding');
      } catch {
        throw new BadRequestException('Курсор не соответствует фильтрам журнала.');
      }
    }
    const startedAt = Date.now();
    const page = await this.prisma.$transaction(
      async (db) => {
        const observedAt = await this.observedAt(db);
        const anchor = cursor
          ? await db.chatReportCase.findFirst({
              where: { id: cursor.id, chatId, createdAt: new Date(cursor.createdAt) },
            })
          : null;
        if (cursor && !anchor) throw new BadRequestException('Некорректный курсор.');
        const ids = await db.$queryRaw<Array<{ id: string }>>(
          reportJournalPageQuery(chatId, filters, anchor),
        );
        const rows = ids.length
          ? await db.chatReportCase.findMany({
              where: {
                chatId,
                id: { in: ids.map((row) => row.id) },
              },
              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
              take: 21,
            })
          : [];
        const visible = rows.slice(0, 20);
        const last = visible.at(-1);
        return {
          items: await this.summaries(visible, db),
          observedAt,
          nextCursor:
            rows.length > 20 && last
              ? Buffer.from(
                  JSON.stringify({
                    v: 1,
                    chatId,
                    filter,
                    id: last.id,
                    createdAt: last.createdAt.toISOString(),
                  }),
                ).toString('base64url')
              : null,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    this.telemetry?.record('journalPage', Date.now() - startedAt);
    return page;
  }

  async detail(chatId: string, id: string) {
    const startedAt = Date.now();
    const detail = await this.prisma.$transaction(
      async (db) => {
        const observedAt = await this.observedAt(db);
        const report = await this.find(chatId, id, db);
        const reporters = report.detailsArchivedAt
          ? []
          : await db.chatReportVote.findMany({
              where: { caseId: id, contentVersion: report.contentVersion },
              orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
              select: { reporterId: true, createdAt: true },
              take: 6,
            });
        const names = await db.chatUserDisplayName.findMany({
          where: {
            chatId,
            userId: { in: [report.authorId, ...reporters.map((vote) => vote.reporterId)] },
          },
          select: { userId: true, displayName: true },
        });
        const namesById = new Map(names.map((row) => [row.userId, row.displayName]));
        return {
          ...(await this.summary(report, db)),
          observedAt,
          authorName: namesById.get(report.authorId) ?? null,
          reporters: reporters.map((vote) => ({
            userId: vote.reporterId,
            displayName: namesById.get(vote.reporterId) ?? null,
            createdAt: vote.createdAt.toISOString(),
          })),
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    this.telemetry?.record('journalDetail', Date.now() - startedAt);
    return detail;
  }

  async dismiss(chatId: string, id: string, actorUserId: string) {
    await this.state.transaction(chatId, async (db) => {
      const report = await db.chatReportCase.findFirst({ where: { id, chatId } });
      if (!report) throw new NotFoundException('Жалоба не найдена.');
      if (report.status === 'DISMISSED') return;
      if (report.detailsArchivedAt || !['COLLECTING', 'PENDING'].includes(report.status))
        throw new BadRequestException('Сбор уже закрыт.');
      await db.chatReportCase.update({
        where: { id },
        data: { status: 'DISMISSED', dueAt: new Date() },
      });
      await db.auditLog.create({
        data: { chatId, actorUserId, action: 'REPORT_DISMISSED', payload: { reportCaseId: id } },
      });
    });
    return this.detail(chatId, id);
  }

  private async observedAt(db: Prisma.TransactionClient): Promise<string> {
    const [row] = await db.$queryRaw<
      Array<{ observed_at: Date }>
    >`SELECT CURRENT_TIMESTAMP AS observed_at`;
    return row!.observed_at.toISOString();
  }

  private async find(chatId: string, id: string, db: Prisma.TransactionClient) {
    const report = await db.chatReportCase.findFirst({ where: { id, chatId } });
    if (!report) throw new NotFoundException('Жалоба не найдена.');
    return report;
  }
}
