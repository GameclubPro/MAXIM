import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { MaxClientService } from '../../max/max-client.service';
import { Prisma, type ChatReportCase } from '../../prisma/prisma-client';
import { PrismaService } from '../../prisma/prisma.service';
import { getAppRole, roleRunsAction } from '../../runtime/app-role';
import { ModerationDeleteIntentService } from '../moderation-delete-intent.service';
import { ModerationSanctionStateLockService } from '../moderation-sanction-state-lock.service';
import { ModerationSanctionStateFenceService } from '../moderation-sanction-state-fence.service';
import { RedisCounterService } from '../redis-counter.service';
import { buildActiveMuteStateKey } from '../moderation-state.util';
import { ReportStateService } from './report-state.service';
import { ReportViewService } from './report-view.service';
import {
  REPORT_DAY_MS,
  REPORT_DELETE_RULE,
  REPORT_RULE,
  REPORT_TERMINAL,
  ReportRejectedError,
} from './report.util';

const FINISHED_DUE_AT = new Date('9999-01-01T00:00:00Z');

@Injectable()
export class ReportExecutionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReportExecutionService.name);
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private stopped = false;
  constructor(
    private readonly prisma: PrismaService,
    private readonly state: ReportStateService,
    private readonly deletes: ModerationDeleteIntentService,
    private readonly max: MaxClientService,
    private readonly views: ReportViewService,
    private readonly locks: ModerationSanctionStateLockService,
    private readonly fences: ModerationSanctionStateFenceService,
    private readonly redis: RedisCounterService,
  ) {}

  onModuleInit(): void {
    if (!roleRunsAction(getAppRole())) return;
    this.timer = setInterval(() => {
      if (this.running || this.stopped) return;
      this.running = this.tick()
        .catch((error) => this.logger.error(error, 'Report recovery failed'))
        .finally(() => {
          this.running = undefined;
        });
    }, 2000);
    this.timer.unref();
  }
  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }

  async tick(): Promise<void> {
    const reports = await this.prisma.chatReportCase.findMany({
      where: { dueAt: { lte: new Date() } },
      orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
      take: 10,
    });
    for (const report of reports) {
      if (this.stopped) break;
      const token = randomUUID();
      const claimed = await this.prisma.chatReportCase.updateMany({
        where: {
          id: report.id,
          OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: new Date() } }],
        },
        data: { leaseToken: token, leaseExpiresAt: new Date(Date.now() + 60_000) },
      });
      if (!claimed.count) continue;
      try {
        await this.process(report.id, token);
      } catch (error) {
        if (error instanceof ReportRejectedError) {
          await this.prisma.chatReportCase.updateMany({
            where: { id: report.id, leaseToken: token, status: { notIn: REPORT_TERMINAL } },
            data: { status: 'CANCELLED', lastError: error.message },
          });
        } else {
          this.logger.warn(
            { reportId: report.id, error: error instanceof Error ? error.message : 'Unknown' },
            'Report execution deferred',
          );
          await this.prisma.chatReportCase.updateMany({
            where: { id: report.id, leaseToken: token },
            data: { lastError: 'Временная ошибка исполнения; ожидается повторная попытка.' },
          });
        }
      } finally {
        const current = await this.prisma.chatReportCase.findUniqueOrThrow({
          where: { id: report.id },
        });
        let rendered = false;
        try {
          rendered = await this.render(current, token);
        } catch {
          this.logger.warn({ reportId: report.id }, 'Report counter update deferred');
        }
        await this.prisma.chatReportCase.updateMany({
          where: { id: report.id, leaseToken: token },
          data: {
            leaseToken: null,
            leaseExpiresAt: null,
            dueAt:
              REPORT_TERMINAL.includes(current.status) && rendered
                ? FINISHED_DUE_AT
                : new Date(Date.now() + (current.status === 'COLLECTING' ? 30_000 : 5000)),
          },
        });
      }
    }
  }

  async process(id: string, token: string): Promise<void> {
    let report = await this.prisma.chatReportCase.findUniqueOrThrow({ where: { id } });
    if (REPORT_TERMINAL.includes(report.status)) return;
    await this.assertLease(id, token);
    await this.state.assertPolicy(report);
    if (!report.counterMessageId && !report.counterSendStartedAt) await this.render(report, token);
    if (report.status === 'COLLECTING') {
      if (report.expiresAt <= new Date())
        await this.prisma.chatReportCase.update({ where: { id }, data: { status: 'EXPIRED' } });
      return;
    }
    const targetAction = await this.prisma.chatReportAction.findUnique({
      where: { caseId_messageId: { caseId: id, messageId: report.messageId } },
    });
    const receipt = targetAction?.intentId
      ? await this.prisma.moderationDeleteIntent.findUnique({
          where: { id: targetAction.intentId },
        })
      : null;
    const targetConfirmed = Boolean(receipt?.remoteDeleteSucceededAt);
    await this.state.assertCase(id, report.originBotId, !targetConfirmed);
    if (report.status === 'PENDING') {
      await this.state.assertVoters(report, report.originBotId);
      report = await this.state.transaction(report.chatId, async (tx) => {
        const current = await tx.chatReportCase.findUniqueOrThrow({ where: { id } });
        if (
          current.status !== 'PENDING' ||
          current.contentVersion !== report.contentVersion ||
          current.leaseToken !== token
        )
          throw new ReportRejectedError('Состояние жалобы изменилось.');
        return tx.chatReportCase.update({ where: { id }, data: { status: 'RUNNING' } });
      });
    }
    if (!report.muteProcessed) await this.applyMute(report, token);
    await this.materialize(report, report.messageId, token);
    if (!targetConfirmed) {
      if (receipt && ['FAILED_TERMINAL', 'EXPIRED', 'ALREADY_ABSENT'].includes(receipt.status)) {
        await this.prisma.chatReportCase.update({
          where: { id },
          data: {
            status: report.muteEventId ? 'PARTIAL' : 'FAILED',
            lastError: 'Удаление исходного сообщения не подтверждено; очистка истории отменена.',
          },
        });
      }
      return;
    }
    if (report.deleteMode === 'HISTORY_24H' && !report.scanComplete) {
      // Drain a page before admitting another; a large history cannot flood the shared queue.
      if ((await this.views.summary(report)).pending > 0) return;
      await this.scanHistory(report, token);
    } else if (report.deleteMode === 'MESSAGE' && !report.scanComplete)
      await this.prisma.chatReportCase.update({ where: { id }, data: { scanComplete: true } });
    report = await this.prisma.chatReportCase.findUniqueOrThrow({ where: { id } });
    const summary = await this.views.summary(report);
    if (report.scanComplete && summary.pending === 0)
      await this.prisma.chatReportCase.update({
        where: { id },
        data: {
          status:
            summary.failed > 0
              ? summary.deleted > 0 || summary.muteApplied
                ? 'PARTIAL'
                : 'FAILED'
              : 'COMPLETED',
          lastError: summary.failed > 0 ? 'Не все сообщения удалось удалить.' : null,
        },
      });
  }

  private async applyMute(report: ChatReportCase, token: string): Promise<void> {
    await this.locks.runExclusive(
      { chatId: report.chatId, userId: report.authorId },
      async (guard) => {
        await guard.assertOwned();
        const current = await this.state.assertCase(report.id, report.originBotId);
        if (current.muteProcessed) return;
        if (
          !current.muteHours ||
          (await this.state.hasActiveSanction(current.chatId, current.authorId))
        ) {
          await this.prisma.chatReportCase.update({
            where: { id: current.id },
            data: { muteProcessed: true },
          });
          return;
        }
        await this.state.assertVoters(current, current.originBotId);
        const fence = await this.fences.prepare({
          chatId: current.chatId,
          userId: current.authorId,
          intendedAction: 'MUTE',
          operator: 'BOT',
          source: 'participant_report',
        });
        let persisted = false;
        try {
          await guard.assertOwned();
          await this.assertLease(current.id, token);
          const eventId = `report-mute:${current.id}`;
          const issuedAt = new Date();
          await this.state.transaction(current.chatId, async (tx) => {
            const policy = await tx.chatSettings.findUniqueOrThrow({
              where: { chatId: current.chatId },
            });
            const latest = await tx.chatReportCase.findUniqueOrThrow({ where: { id: current.id } });
            if (
              !policy.reportsEnabled ||
              policy.reportsRevision !== current.policyRevision ||
              latest.status !== 'RUNNING' ||
              latest.leaseToken !== token ||
              !this.state.enabled(current.chatId)
            )
              throw new ReportRejectedError('Жалоба больше не разрешает мут.');
            if (latest.muteProcessed) return;
            await tx.moderationEvent.create({
              data: {
                id: eventId,
                chatId: current.chatId,
                userId: current.authorId,
                botId: current.originBotId,
                messageId: current.messageId,
                eventType: 'MEMBER_ACTION',
                ruleCode: REPORT_RULE,
                action: 'MUTE',
                operator: 'BOT',
                createdAt: issuedAt,
                metadata: {
                  reportCaseId: current.id,
                  sanctionApplied: true,
                  mutePermanent: false,
                  muteDurationHours: current.muteHours,
                  muteExpiresAt: new Date(
                    issuedAt.getTime() + current.muteHours! * 3_600_000,
                  ).toISOString(),
                },
              },
            });
            await tx.chatReportCase.update({
              where: { id: current.id },
              data: { muteProcessed: true, muteEventId: eventId },
            });
          });
          persisted = true;
          await this.fences.commit(fence, eventId);
          await guard.assertOwned();
          await this.redis.deleteKey(buildActiveMuteStateKey(current.chatId, current.authorId));
        } catch (error) {
          if (!persisted) await this.fences.abort(fence);
          throw error;
        }
      },
    );
  }

  private async materialize(
    report: ChatReportCase,
    messageId: string,
    token: string,
  ): Promise<void> {
    await this.assertLease(report.id, token);
    const action = await this.prisma.chatReportAction.upsert({
      where: { caseId_messageId: { caseId: report.id, messageId } },
      create: { caseId: report.id, messageId },
      update: {},
    });
    if (action.intentId) {
      if (messageId === report.messageId)
        await this.deletes.enqueueCurrentIntentWakeupStrict(action.intentId);
      return;
    }
    const intent = await this.deletes.ensureIntent({
      chatId: report.chatId,
      messageId,
      reasonKey: `PARTICIPANT_REPORT:${report.id}:${messageId}`,
      ruleCode: REPORT_DELETE_RULE,
      subjectUserId: report.authorId,
      originBotId: report.originBotId,
      routingPolicy: 'delete_capable',
      entityType: 'CHAT',
      messageAuthorKind: 'user',
      retryUntilAt: new Date(report.decidedAt!.getTime() + REPORT_DAY_MS),
      event: {
        userId: report.authorId,
        metadata: {
          reportCaseId: report.id,
          source: 'participant_report',
          contentVersion: report.contentVersion,
        },
      },
    });
    if (intent.rollout !== 'execute' || !intent.intentId)
      throw new Error('Durable report deletion unavailable');
    await this.prisma.chatReportAction.update({
      where: { id: action.id },
      data: { intentId: intent.intentId },
    });
    if (messageId === report.messageId)
      await this.deletes.enqueueCurrentIntentWakeupStrict(intent.intentId);
  }

  private async scanHistory(report: ChatReportCase, token: string): Promise<void> {
    const end = report.decidedAt!;
    const start = new Date(end.getTime() - REPORT_DAY_MS);
    const cursor =
      report.scanCursorCreatedAt && report.scanCursorId
        ? Prisma.sql`AND (created_at, id) > (${report.scanCursorCreatedAt}, ${report.scanCursorId})`
        : Prisma.empty;
    const rows = await this.prisma.$queryRaw<
      Array<{ id: string; created_at: Date; normalized_payload: unknown }>
    >(Prisma.sql`
      SELECT id, created_at, normalized_payload FROM webhook_events
      WHERE normalized_payload->>'type' = 'message_created'
        AND normalized_payload->'message'->>'chatId' = ${report.chatId}
        AND normalized_payload->'message'->>'senderId' = ${report.authorId}
        AND created_at >= ${start} AND created_at <= ${end}
        ${cursor} ORDER BY created_at, id LIMIT 200
    `);
    for (const row of rows) {
      const parsed = row.normalized_payload as {
        message?: { messageId?: string; createdAt?: string };
      };
      const message = parsed.message;
      const at = Date.parse(message?.createdAt ?? '');
      if (message?.messageId && at >= start.getTime() && at <= end.getTime())
        await this.materialize(report, message.messageId, token);
    }
    await this.assertLease(report.id, token);
    const last = rows.at(-1);
    await this.prisma.chatReportCase.update({
      where: { id: report.id },
      data: {
        scanComplete: rows.length < 200,
        ...(last ? { scanCursorCreatedAt: last.created_at, scanCursorId: last.id } : {}),
      },
    });
  }

  private async render(report: ChatReportCase, token: string): Promise<boolean> {
    if (
      REPORT_TERMINAL.includes(report.status) &&
      Date.now() > report.expiresAt.getTime() + REPORT_DAY_MS
    )
      return true;
    const summary = await this.views.summary(report);
    const labels: Record<string, string> = {
      COLLECTING: `Жалобы: ${summary.votes} из ${summary.threshold}`,
      PENDING: 'Порог жалоб достигнут. Ожидается обработка.',
      RUNNING: `Жалобы: обработка. Удалено ${summary.deleted}, в очереди ${summary.pending}.`,
      COMPLETED: `По жалобам удалено сообщений: ${summary.deleted}.`,
      PARTIAL: `Жалобы: выполнено частично. Удалено ${summary.deleted}, ошибок ${summary.failed}.`,
      FAILED: 'Не удалось выполнить меры по жалобам.',
      DISMISSED: 'Жалобы отклонены администратором.',
      EXPIRED: 'Срок сбора жалоб истёк.',
      CANCELLED: 'Сбор жалоб отменён.',
    };
    const text = `${labels[summary.status]}${summary.muteApplied ? ` Мут: ${summary.muteHours} ч.` : ''}`;
    if (report.counterMessageId) {
      if (report.counterText !== text) {
        try {
          await this.max.replaceOwnMessage(
            report.chatId,
            report.counterMessageId,
            text,
            undefined,
            { botId: report.originBotId, trafficClass: 'background', timeoutMs: 5000 },
            () => this.assertLease(report.id, token),
          );
        } catch (error) {
          const existing = await this.max.getExactMessageRow(
            report.chatId,
            report.counterMessageId,
            { botId: report.originBotId, timeoutMs: 5000, trafficClass: 'background' },
          );
          if (existing) throw error;
          await this.prisma.chatReportCase.update({
            where: { id: report.id },
            data: {
              counterMessageId: null,
              lastError: 'Счётчик удалён; результат доступен в журнале.',
            },
          });
          return true;
        }
        await this.prisma.chatReportCase.update({
          where: { id: report.id },
          data: { counterText: text },
        });
      }
      if (REPORT_TERMINAL.includes(report.status)) {
        const settings = await this.state.settings(report.chatId);
        if (settings?.deleteBotMessagesEnabled)
          await this.deletes.ensureIntent({
            chatId: report.chatId,
            messageId: report.counterMessageId,
            originBotId: report.originBotId,
            messageAuthorKind: 'bot',
            routingPolicy: 'origin_only',
            reasonKey: `report-counter:${report.id}`,
            ruleCode: 'PARTICIPANT_REPORT_COUNTER_CLEANUP',
            executeAt: new Date(Date.now() + settings.deleteBotMessagesDelayMinutes * 60_000),
          });
      }
      return true;
    }
    // FLAG: An attempted send without a receipt is ambiguous. Never create a second counter on retry.
    if (report.counterSendStartedAt) return true;
    if (REPORT_TERMINAL.includes(report.status)) return true;
    const sent = await this.max.sendMessageImmediateWithId(
      report.chatId,
      text,
      {
        messageLink: { type: 'reply', mid: report.messageId },
        beforeSend: async () => {
          await this.assertLease(report.id, token);
          await this.prisma.chatReportCase.update({
            where: { id: report.id },
            data: {
              counterSendStartedAt: new Date(),
              counterText: text,
            },
          });
        },
      },
      { botId: report.originBotId, trafficClass: 'background', timeoutMs: 5000 },
    );
    await this.prisma.chatReportCase.update({
      where: { id: report.id },
      data: { counterMessageId: sent.messageId, counterText: text },
    });
    return true;
  }

  private async assertLease(id: string, token: string): Promise<void> {
    const updated = await this.prisma.chatReportCase.updateMany({
      where: { id, leaseToken: token, leaseExpiresAt: { gt: new Date() } },
      data: { leaseExpiresAt: new Date(Date.now() + 60_000) },
    });
    if (!updated.count) throw new Error('Report execution lease lost');
  }
}
