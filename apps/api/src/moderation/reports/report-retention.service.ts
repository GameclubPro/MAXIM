import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '../../prisma/prisma-client';
import { PrismaService } from '../../prisma/prisma.service';
import { ReportStateService } from './report-state.service';
import { ReportViewService } from './report-view.service';
import { ReportTelemetryService } from './report-telemetry.service';
import { REPORT_DAY_MS, REPORT_TERMINAL } from './report.util';
import { RedisCounterService } from '../redis-counter.service';

const TERMINAL_INTENTS = ['SUCCEEDED', 'ALREADY_ABSENT', 'EXPIRED', 'FAILED_TERMINAL'];
const DETAIL_BATCH_SIZE = 200;

@Injectable()
export class ReportRetentionService {
  private nextRunAt = Date.now() + 60_000;
  private archiveCursor: { expiresAt: Date; id: string } | null = null;
  constructor(
    private readonly prisma: PrismaService,
    private readonly state: ReportStateService,
    private readonly views: ReportViewService,
    private readonly config: ConfigService,
    private readonly telemetry: ReportTelemetryService,
    @Optional() private readonly redis?: RedisCounterService,
  ) {}

  async purgeDue(): Promise<number> {
    if (
      this.config.get<boolean>('PARTICIPANT_REPORTS_DETAIL_RETENTION_ENABLED') !== true ||
      Date.now() < this.nextRunAt ||
      !this.redis
    )
      return 0;
    this.nextRunAt = Date.now() + 60_000;
    if (!(await this.redis.setStringIfAbsentWithTtl('reports:detail-archive-budget:v1', '1', 60)))
      return 0;
    return this.archivePage();
  }

  previewPage(now = new Date()): Promise<number> {
    return this.archivePage(now, true);
  }

  async archivePage(now = new Date(), dryRun = false): Promise<number> {
    // FLAG: The migration is additive. Detailed data remains untouched until explicit activation.
    if (
      !dryRun &&
      this.config.get<boolean>('PARTICIPANT_REPORTS_DETAIL_RETENTION_ENABLED') !== true
    )
      return 0;
    const days = this.config.get<number>('PARTICIPANT_REPORTS_DETAIL_RETENTION_DAYS') ?? 30;
    if (![30, 90, 180].includes(days)) throw new Error('Invalid report detail retention period');
    const cutoff = new Date(now.getTime() - days * REPORT_DAY_MS);
    const cursor = !dryRun ? this.archiveCursor : null;
    // Discovery advances over ineligible cases; eligibility is checked under the case lock below.
    const candidates = await this.prisma.$queryRaw<
      Array<{ id: string; chatId: string; expiresAt: Date }>
    >(Prisma.sql`
      SELECT id, chat_id AS "chatId", expires_at AS "expiresAt"
      FROM chat_report_cases
      WHERE details_archive_completed_at IS NULL AND expires_at < ${cutoff}
        ${cursor ? Prisma.sql`AND (expires_at, id) > (${cursor.expiresAt}, ${cursor.id})` : Prisma.empty}
      ORDER BY expires_at, id LIMIT 5
    `);
    let removed = 0;
    for (const candidate of candidates) {
      if (removed >= DETAIL_BATCH_SIZE) break;
      let archived = false;
      removed += await this.state.transaction(candidate.chatId, async (db) => {
        // All restart/dismissal writes take the same chat fence before this row lock.
        await db.$queryRaw`SELECT id FROM chat_report_cases WHERE id = ${candidate.id} FOR UPDATE`;
        const report = await db.chatReportCase.findUnique({ where: { id: candidate.id } });
        if (
          !report ||
          report.detailsArchiveCompletedAt ||
          !REPORT_TERMINAL.includes(report.status) ||
          report.expiresAt >= cutoff ||
          (!report.detailsArchivedAt && report.updatedAt >= cutoff) ||
          (report.leaseExpiresAt && report.leaseExpiresAt > now) ||
          (report.decidedAt && report.decidedAt.getTime() + REPORT_DAY_MS > now.getTime()) ||
          (!report.counterMessageId &&
            report.counterSendStartedAt &&
            report.counterSendStartedAt.getTime() + REPORT_DAY_MS > now.getTime())
        )
          return 0;
        const [binding] = await db.$queryRaw<Array<{ live: boolean }>>(Prisma.sql`
          SELECT EXISTS (
            SELECT 1 FROM moderation_delete_intent_reasons reason
            JOIN moderation_delete_intents intent ON intent.id = reason.intent_id
            WHERE reason.rule_code IN ('PARTICIPANT_REPORT_DELETE', 'PARTICIPANT_REPORT_COMMAND_CLEANUP', 'PARTICIPANT_REPORT_COUNTER_CLEANUP')
              AND reason.metadata->>'reportCaseId' = ${report.id}
              AND (intent.status::text NOT IN (${Prisma.join(TERMINAL_INTENTS)}) OR intent.lease_expires_at > ${now})
          ) OR EXISTS (
            SELECT 1 FROM chat_report_actions action
            JOIN moderation_delete_intents intent ON intent.id = action.intent_id
            WHERE action.case_id = ${report.id}
              AND (intent.status::text NOT IN (${Prisma.join(TERMINAL_INTENTS)}) OR intent.lease_expires_at > ${now})
          ) AS live
        `);
        if (binding?.live) return 0;
        if (!report.detailsArchivedAt) {
          const summary = await this.views.summary(report, db);
          if (summary.pending > 0) return 0;
          // FLAG: Freeze the truthful totals before bounded deletion. Keep the case as a dedupe tombstone.
          if (!dryRun)
            await db.chatReportCase.update({
              where: { id: report.id },
              data: {
                detailsArchivedAt: now,
                retainedVotes: summary.votes,
                retainedCandidates: summary.candidates,
                retainedDeleted: summary.deleted,
                retainedAbsent: summary.absent,
                retainedFailed: summary.failed,
              },
            });
          archived = !dryRun;
        }
        const budget = DETAIL_BATCH_SIZE - removed;
        const votes = await db.chatReportVote.findMany({
          where: { caseId: report.id },
          orderBy: { id: 'asc' },
          take: budget,
          select: { id: true },
        });
        if (!dryRun && votes.length)
          await db.chatReportVote.deleteMany({
            where: { id: { in: votes.map((vote) => vote.id) } },
          });
        const actions =
          votes.length < budget
            ? await db.chatReportAction.findMany({
                where: { caseId: report.id },
                orderBy: { id: 'asc' },
                take: budget - votes.length,
                select: { id: true },
              })
            : [];
        if (!dryRun && actions.length)
          await db.chatReportAction.deleteMany({
            where: { id: { in: actions.map((action) => action.id) } },
          });
        if (
          !dryRun &&
          !(await db.chatReportVote.findFirst({
            where: { caseId: report.id },
            select: { id: true },
          })) &&
          !(await db.chatReportAction.findFirst({
            where: { caseId: report.id },
            select: { id: true },
          }))
        ) {
          await db.chatReportCase.update({
            where: { id: report.id },
            data: { detailsArchiveCompletedAt: now },
          });
        }
        return votes.length + actions.length;
      });
      if (archived) this.telemetry.record('detailArchived');
      if (!dryRun) this.archiveCursor = { expiresAt: candidate.expiresAt, id: candidate.id };
    }
    if (!dryRun && candidates.length < 5 && removed < DETAIL_BATCH_SIZE) this.archiveCursor = null;
    return removed;
  }
}
