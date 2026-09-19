import { Injectable } from '@nestjs/common';
import { MaxClientService } from '../../max/max-client.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ReportStateService } from './report-state.service';
import {
  record,
  REPORT_COMMAND_RULE,
  REPORT_COUNTER_RULE,
  REPORT_GUARDED_RULES,
  REPORT_TERMINAL,
  ReportRejectedError,
  ReportStaleStateError,
  reportLinkedMessageId,
} from './report.util';

@Injectable()
export class ReportDeleteGuardService {
  // FLAG: Persisted counter cleanup must remain guarded when a collection is reopened.
  static readonly BINDING_VERSION = 2;
  constructor(
    private readonly state: ReportStateService,
    private readonly prisma: PrismaService,
    private readonly max: MaxClientService,
  ) {}

  async assertIntentStillActionable(params: {
    intentId: string;
    chatId: string;
    messageId: string;
    subjectUserId: string | null;
    botId: string;
  }): Promise<'allowed' | 'absent' | 'not_applicable'> {
    const reasons = await this.prisma.moderationDeleteIntentReason.findMany({
      where: { intentId: params.intentId },
      select: { ruleCode: true, metadata: true },
    });
    // FLAG: An independent moderation reason keeps its own authorization and guards.
    if (!reasons.length || reasons.some((r) => !REPORT_GUARDED_RULES.has(r.ruleCode)))
      return 'not_applicable';
    const id = record(reasons[0].metadata).reportCaseId;
    if (typeof id !== 'string') throw new ReportRejectedError('Report binding missing');
    if (reasons.every((reason) => reason.ruleCode === REPORT_COUNTER_RULE)) {
      const report = await this.prisma.chatReportCase.findUniqueOrThrow({ where: { id } });
      const settings = await this.state.settings(params.chatId);
      if (
        report.chatId !== params.chatId ||
        report.counterMessageId !== params.messageId ||
        report.originBotId !== params.botId ||
        !settings?.deleteBotMessagesEnabled
      ) {
        throw new ReportRejectedError('Report counter cleanup no longer authorized');
      }
      if (!REPORT_TERMINAL.includes(report.status))
        throw new ReportStaleStateError('Активный счётчик жалоб защищён от очистки.');
      await this.state.assertCurrent(report);
      return 'allowed';
    }
    if (reasons.every((r) => r.ruleCode === REPORT_COMMAND_RULE)) {
      const report = await this.prisma.chatReportCase.findUniqueOrThrow({ where: { id } });
      if (
        report.chatId !== params.chatId ||
        !params.subjectUserId ||
        params.messageId === report.messageId
      )
        throw new ReportRejectedError('Report command binding mismatch');
      await this.state.assertPolicy(report);
      const command = await this.max.getExactMessageRow(params.chatId, params.messageId, {
        botId: params.botId,
        bypassCache: true,
        trafficClass: 'critical',
        timeoutMs: 5000,
      });
      if (!command) return 'absent';
      if (
        String(record(command.sender).user_id) !== params.subjectUserId ||
        record(command.sender).is_bot !== false
      )
        throw new ReportRejectedError('Report command author changed');
      const body = record(command.body);
      if (
        body.text !== record(reasons[0].metadata).commandText ||
        (Array.isArray(body.attachments) && body.attachments.length > 0) ||
        reportLinkedMessageId(command, params.chatId) !== report.messageId
      )
        throw new ReportRejectedError('Report command changed');
      await this.state.assertPolicy(report);
      return 'allowed';
    }
    const report = await this.state.assertCase(id, params.botId, false);
    if (report.chatId !== params.chatId || report.authorId !== params.subjectUserId)
      throw new ReportRejectedError('Report subject mismatch');
    const action = await this.prisma.chatReportAction.findUnique({
      where: {
        caseId_messageId: {
          caseId: report.id,
          messageId: params.messageId,
        },
      },
    });
    if (!action) throw new ReportRejectedError('Report action missing');
    if (
      reasons.some(
        (reason) =>
          record(reason.metadata).reportCaseId === report.id &&
          record(reason.metadata).contentVersion !== report.contentVersion,
      )
    ) {
      throw new ReportRejectedError('Report action version changed');
    }
    if (params.messageId === report.messageId) {
      const source = await this.state.source(params.chatId, params.messageId, params.botId);
      if (!source) return 'absent';
      if (source.hash !== report.contentHash || source.authorId !== report.authorId)
        throw new ReportRejectedError('Report content changed');
      await this.state.assertVoters(report, params.botId);
    } else {
      const target = await this.prisma.chatReportAction.findUnique({
        where: {
          caseId_messageId: {
            caseId: report.id,
            messageId: report.messageId,
          },
        },
      });
      const receipt = target?.intentId
        ? await this.prisma.moderationDeleteIntent.findUnique({
            where: { id: target.intentId },
            select: { status: true, remoteDeleteSucceededAt: true },
          })
        : null;
      if (report.deleteMode !== 'HISTORY_24H' || !receipt?.remoteDeleteSucceededAt)
        throw new ReportRejectedError('Report target deletion not confirmed');
      const row = await this.max.getExactMessageRow(params.chatId, params.messageId, {
        botId: params.botId,
        bypassCache: true,
        timeoutMs: 5000,
        trafficClass: 'critical',
      });
      if (!row) return 'absent';
      const timestamp = row.timestamp;
      if (
        String(record(row.sender).user_id) !== report.authorId ||
        record(row.sender).is_bot !== false ||
        typeof timestamp !== 'number' ||
        !report.decidedAt ||
        timestamp < report.decidedAt.getTime() - 86_400_000 ||
        timestamp > report.decidedAt.getTime()
      )
        throw new ReportRejectedError('Report history binding mismatch');
    }
    await this.state.assertLocalAuthor(report.chatId, report.authorId);
    const current = await this.state.assertCurrent(report, ['PENDING', 'RUNNING']);
    await this.state.assertPolicy(current);
    return 'allowed';
  }
}
