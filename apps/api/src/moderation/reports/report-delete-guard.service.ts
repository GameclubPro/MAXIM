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
  static readonly BINDING_VERSION = 3;
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
    trafficClass?: 'critical' | 'background';
    isIndependentReasonExecutable?: (
      reasons: readonly { ruleCode: string; reasonKey?: string; metadata: unknown }[],
    ) => boolean;
  }): Promise<'allowed' | 'absent' | 'not_applicable'> {
    const reasons = await this.prisma.moderationDeleteIntentReason.findMany({
      where: { intentId: params.intentId },
      select: { ruleCode: true, reasonKey: true, metadata: true },
      orderBy: { reasonKey: 'asc' },
    });
    // FLAG: Exact counter ownership is protected even when a generic cleanup reason bypasses report authority.
    if (
      reasons.some(
        (reason) =>
          reason.ruleCode === REPORT_COUNTER_RULE || reason.ruleCode === 'BOT_MESSAGE_AUTO_DELETE',
      )
    ) {
      const owner = await this.prisma.chatReportCase.findFirst({
        where: { chatId: params.chatId, counterMessageId: params.messageId },
      });
      if (owner) {
        if (!REPORT_TERMINAL.includes(owner.status))
          throw new ReportStaleStateError('Активный счётчик жалоб защищён от очистки.');
        const settings = await this.state.settings(params.chatId);
        if (owner.originBotId !== params.botId || !settings?.deleteBotMessagesEnabled)
          throw new ReportStaleStateError('Очистка счётчика жалоб приостановлена.');
        await this.state.assertCurrent(owner);
      }
    }
    // FLAG: Only an independently executable reason may bypass report authority. A dormant
    // observation merged into a report does not inherit that report's execution admission.
    const reportReasons = reasons.filter((reason) => REPORT_GUARDED_RULES.has(reason.ruleCode));
    const independentReasons = reasons.filter(
      (reason) => !REPORT_GUARDED_RULES.has(reason.ruleCode),
    );
    if (
      !reportReasons.length ||
      (independentReasons.length > 0 && params.isIndependentReasonExecutable?.(independentReasons))
    )
      return 'not_applicable';
    let stale: ReportStaleStateError | undefined;
    let rejection: ReportRejectedError | undefined;
    for (const reason of reportReasons) {
      try {
        return await this.assertReason(params, reason);
      } catch (error) {
        if (error instanceof ReportStaleStateError) stale = error;
        else if (error instanceof ReportRejectedError) rejection = error;
        else throw error; // Unknown remote/storage state cannot authorize a delete.
      }
    }
    throw stale ?? rejection ?? new ReportRejectedError('Report binding missing');
  }

  private async assertReason(
    params: Parameters<ReportDeleteGuardService['assertIntentStillActionable']>[0],
    reason: { ruleCode: string; metadata: unknown },
  ): Promise<'allowed' | 'absent'> {
    const id = record(reason.metadata).reportCaseId;
    if (typeof id !== 'string') throw new ReportRejectedError('Report binding missing');
    if (reason.ruleCode === REPORT_COUNTER_RULE) {
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
    if (reason.ruleCode === REPORT_COMMAND_RULE) {
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
        body.text !== record(reason.metadata).commandText ||
        (Array.isArray(body.attachments) && body.attachments.length > 0) ||
        reportLinkedMessageId(command, params.chatId) !== report.messageId
      )
        throw new ReportRejectedError('Report command changed');
      await this.state.assertCurrent(report);
      await this.state.assertPolicy(report);
      return 'allowed';
    }
    const report = await this.state.assertCase(
      id,
      params.botId,
      false,
      params.trafficClass ?? 'critical',
    );
    if (report.muteProcessed === false)
      throw new ReportStaleStateError('Решение об ограничении участника ещё не сохранено.');
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
    if (record(reason.metadata).contentVersion !== report.contentVersion)
      throw new ReportRejectedError('Report action version changed');
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
        trafficClass: params.trafficClass ?? 'critical',
      });
      if (!row) return 'absent';
      const timestamp = row.timestamp;
      if (
        String(record(row.sender).user_id) !== report.authorId ||
        record(row.sender).is_bot !== false ||
        typeof timestamp !== 'number' ||
        !Number.isSafeInteger(timestamp) ||
        timestamp <= 0 ||
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
