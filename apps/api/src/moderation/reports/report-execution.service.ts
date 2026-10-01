import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
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
import { ReportTelemetryService } from './report-telemetry.service';
import { ReportRetentionService } from './report-retention.service';
import {
  REPORT_DAY_MS,
  REPORT_DELETE_RULE,
  REPORT_RULE,
  REPORT_TERMINAL,
  ReportRejectedError,
  ReportStaleStateError,
} from './report.util';

const TICK_BUDGET_MS = 8000;
const HISTORY_PAGE_SIZE = 25;
const HISTORY_GLOBAL_PENDING_LIMIT = 1000;
const HISTORY_CHAT_PENDING_LIMIT = 200;
const HISTORY_BOT_PENDING_LIMIT = 400;

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
    @Optional() private readonly telemetry?: ReportTelemetryService,
    @Optional() private readonly retention?: ReportRetentionService,
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
    const deadline = performance.now() + TICK_BUDGET_MS;
    const due = {
      dueAt: { lte: new Date() },
      OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: new Date() } }],
    };
    // FLAG: Reserve discovery slots for decisions, running work and expiry/render maintenance.
    const groups = await Promise.all([
      this.prisma.chatReportCase.findMany({
        where: { ...due, status: 'PENDING' },
        orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
        take: 4,
      }),
      this.prisma.chatReportCase.findMany({
        where: { ...due, status: 'RUNNING' },
        orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
        take: 4,
      }),
      // Each equality branch uses the status/due index; the final merge contains at most fourteen rows.
      Promise.all(
        ['COLLECTING', ...REPORT_TERMINAL].map((status) =>
          this.prisma.chatReportCase.findMany({
            where: { ...due, status },
            orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
            take: 2,
          }),
        ),
      ).then((buckets) =>
        buckets
          .flat()
          .sort(
            (left, right) =>
              left.dueAt.getTime() - right.dueAt.getTime() ||
              (left.id < right.id ? -1 : left.id === right.id ? 0 : 1),
          )
          .slice(0, 2),
      ),
    ]);
    const reports = [...new Map(groups.flat().map((report) => [report.id, report])).values()];
    let next = 0;
    const workers = await Promise.allSettled(
      Array.from({ length: 2 }, async () => {
        while (!this.stopped && performance.now() < deadline) {
          const report = reports[next++];
          if (!report) return;
          await this.processDue(report, deadline);
        }
      }),
    );
    for (const worker of workers) {
      if (worker.status === 'rejected') this.logger.error(worker.reason, 'Report batch failed');
    }
    // FLAG: Retention owns its default-off switch and initial delay; no startup cleanup scan.
    if (!this.stopped && performance.now() < deadline) await this.retention?.purgeDue();
  }

  private async processDue(report: ChatReportCase, deadline: number): Promise<void> {
    const token = randomUUID();
    const claimed = await this.prisma.chatReportCase.updateMany({
      where: {
        id: report.id,
        dueAt: { lte: new Date() },
        OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: new Date() } }],
      },
      data: { leaseToken: token, leaseExpiresAt: new Date(Date.now() + 60_000) },
    });
    if (!claimed.count) return;
    try {
      await this.process(report.id, token, false);
    } catch (error) {
      if (error instanceof ReportRejectedError) {
        const cancelled = await this.prisma.chatReportCase.updateMany({
          where: { id: report.id, leaseToken: token, status: { notIn: REPORT_TERMINAL } },
          data: { status: 'CANCELLED', lastError: error.message },
        });
        if (cancelled.count) this.telemetry?.record('cancelled');
      } else if (!(error instanceof ReportStaleStateError)) {
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
      if (current.leaseToken === token) {
        let rendered = false;
        // FLAG: Counter delivery is bounded maintenance; durable sanctions do not wait for it.
        if (performance.now() < deadline) {
          try {
            rendered = await this.render(current, token);
          } catch {
            this.logger.warn({ reportId: report.id }, 'Report counter update deferred');
          }
        }
        const terminal = REPORT_TERMINAL.includes(current.status);
        const nextDueAt =
          terminal && rendered
            ? FINISHED_DUE_AT
            : current.status === 'COLLECTING' && rendered
              ? current.expiresAt
              : new Date(Date.now() + (terminal ? 60_000 : 5000));
        // FLAG: A vote, dismissal or recovered receipt owns its newer wakeup, including while rendering.
        await this.prisma.$executeRaw`
          UPDATE chat_report_cases SET lease_token = NULL, lease_expires_at = NULL,
            due_at = CASE WHEN due_at = ${report.dueAt} THEN ${nextDueAt} ELSE due_at END,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ${report.id} AND lease_token = ${token}
        `;
      }
    }
  }

  async process(id: string, token: string, renderCounter = true): Promise<void> {
    let report = await this.prisma.chatReportCase.findUniqueOrThrow({ where: { id } });
    if (REPORT_TERMINAL.includes(report.status)) return;
    await this.assertLease(id, token);
    await this.state.assertPolicy(report);
    await this.state.assertCurrent(report);
    if (renderCounter && !report.counterMessageId && !report.counterSendStartedAt) {
      try {
        await this.render(report, token);
      } catch (error) {
        if (error instanceof ReportStaleStateError || error instanceof ReportRejectedError)
          throw error;
        this.logger.warn(
          { reportId: id },
          'Report counter unavailable; durable execution continues',
        );
      }
    }
    if (report.status === 'COLLECTING') {
      if (report.expiresAt <= new Date())
        await this.updateOwned(report, token, { status: 'EXPIRED' });
      return;
    }
    const executionBotId = await this.state.executionBotId(report.chatId);
    const targetAction = await this.prisma.chatReportAction.findUnique({
      where: { caseId_messageId: { caseId: id, messageId: report.messageId } },
    });
    const receipt = targetAction?.intentId
      ? await this.prisma.moderationDeleteIntent.findUnique({
          where: { id: targetAction.intentId },
        })
      : null;
    const targetConfirmed = Boolean(receipt?.remoteDeleteSucceededAt);
    report = await this.state.assertCase(id, executionBotId, !targetConfirmed);
    if (report.status === 'PENDING') {
      await this.state.assertVoters(report, executionBotId);
      report = await this.state.transaction(report.chatId, async (tx) => {
        const current = await tx.chatReportCase.findUniqueOrThrow({ where: { id } });
        if (
          current.status !== 'PENDING' ||
          current.contentVersion !== report.contentVersion ||
          current.leaseToken !== token
        )
          throw new ReportStaleStateError('Состояние жалобы изменилось.');
        return tx.chatReportCase.update({ where: { id }, data: { status: 'RUNNING' } });
      });
      this.telemetry?.record('executionDelay', Date.now() - report.decidedAt!.getTime());
    }
    // FLAG: Durable target admission must succeed before any sanction; dispatch waits for muteProcessed.
    await this.materialize(report, report.messageId, token, false);
    if (!report.muteProcessed) await this.applyMute(report, token, executionBotId);
    report = await this.state.assertCurrent(report, ['RUNNING']);
    await this.materialize(report, report.messageId, token);
    if (!targetConfirmed) {
      if (receipt && ['FAILED_TERMINAL', 'EXPIRED', 'ALREADY_ABSENT'].includes(receipt.status)) {
        await this.updateOwned(report, token, {
          status: report.muteEventId ? 'PARTIAL' : 'FAILED',
          lastError: 'Удаление исходного сообщения не подтверждено; очистка истории отменена.',
        });
        if (receipt.status === 'FAILED_TERMINAL') this.telemetry?.record('permanentRefusal');
      }
      return;
    }
    if (report.deleteMode === 'HISTORY_24H') {
      // FLAG: Recover the action -> intent gap before the pending-page gate can block the scan.
      const unlinked = await this.prisma.chatReportAction.findMany({
        where: { caseId: report.id, intentId: null, receiptStatus: null },
        orderBy: { id: 'asc' },
        take: 200,
      });
      for (const action of unlinked) await this.materialize(report, action.messageId, token);
      // Drain a page before admitting another; recover final-page reservations after crashes too.
      if (!report.scanComplete) {
        if ((await this.views.summary(report)).pending > 0) return;
        await this.scanHistory(report, token);
      }
    } else if (report.deleteMode === 'MESSAGE' && !report.scanComplete)
      await this.updateOwned(report, token, { scanComplete: true });
    report = await this.prisma.chatReportCase.findUniqueOrThrow({ where: { id } });
    const summary = await this.views.summary(report);
    if (report.scanComplete && summary.pending === 0) {
      await this.updateOwned(report, token, {
        status:
          summary.failed > 0
            ? summary.deleted > 0 || summary.muteApplied
              ? 'PARTIAL'
              : 'FAILED'
            : 'COMPLETED',
        lastError: summary.failed > 0 ? 'Не все сообщения удалось удалить.' : null,
      });
      if (summary.deleted) this.telemetry?.record('delete');
      if (summary.absent) this.telemetry?.record('deleteAbsent');
      if (summary.failed) this.telemetry?.record('deleteFailed');
    }
  }

  private async applyMute(report: ChatReportCase, token: string, botId: string): Promise<void> {
    await this.locks.runExclusive(
      { chatId: report.chatId, userId: report.authorId },
      async (guard) => {
        await guard.assertOwned();
        const current = await this.state.assertCase(report.id, botId);
        if (current.muteProcessed) return;
        if (
          !current.muteHours ||
          (await this.state.hasActiveSanction(current.chatId, current.authorId))
        ) {
          await this.updateOwned(current, token, { muteProcessed: true });
          this.telemetry?.record('muteSkipped');
          return;
        }
        await this.state.assertVoters(current, botId);
        await this.state.assertCurrent(current, ['RUNNING']);
        await this.state.assertPolicy(current);
        const fence = await this.fences.prepare({
          chatId: current.chatId,
          userId: current.authorId,
          intendedAction: 'MUTE',
          operator: 'BOT',
          source: 'participant_report',
        });
        let persisted = false;
        let muteCreated = false;
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
              latest.contentVersion !== current.contentVersion ||
              latest.contentHash !== current.contentHash ||
              latest.decidedAt?.getTime() !== current.decidedAt?.getTime() ||
              !latest.leaseExpiresAt ||
              latest.leaseExpiresAt <= new Date() ||
              !this.state.enabled(current.chatId)
            )
              throw new ReportRejectedError('Жалоба больше не разрешает мут.');
            if (latest.muteProcessed) return;
            await this.state.assertLocalAuthor(current.chatId, current.authorId, tx);
            if (await this.state.hasActiveSanction(current.chatId, current.authorId, tx)) {
              await tx.chatReportCase.update({
                where: { id: current.id },
                data: { muteProcessed: true },
              });
              return;
            }
            await tx.moderationEvent.create({
              data: {
                id: eventId,
                chatId: current.chatId,
                userId: current.authorId,
                botId,
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
            muteCreated = true;
          });
          persisted = true;
          this.telemetry?.record(muteCreated ? 'mute' : 'muteSkipped');
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
    wakeTarget = true,
  ): Promise<void> {
    await this.assertLease(report.id, token);
    await this.state.assertCurrent(report, ['RUNNING']);
    await this.state.assertPolicy(report);
    const action = await this.prisma.chatReportAction.upsert({
      where: { caseId_messageId: { caseId: report.id, messageId } },
      create: { caseId: report.id, messageId },
      update: {},
    });
    if (action.intentId) {
      if (messageId === report.messageId && wakeTarget)
        await this.deletes.enqueueCurrentIntentWakeupStrict(action.intentId);
      return;
    }
    if (action.receiptStatus) return;
    const input = {
      chatId: report.chatId,
      messageId,
      reasonKey: `PARTICIPANT_REPORT:${report.id}:${messageId}`,
      ruleCode: REPORT_DELETE_RULE,
      subjectUserId: report.authorId,
      originBotId: report.originBotId,
      routingPolicy: 'delete_capable' as const,
      entityType: 'CHAT' as const,
      messageAuthorKind: 'user' as const,
      retryUntilAt: new Date(report.decidedAt!.getTime() + REPORT_DAY_MS),
      event: {
        userId: report.authorId,
        metadata: {
          reportCaseId: report.id,
          source: 'participant_report',
          contentVersion: report.contentVersion,
          reportTargetMessageId: report.messageId,
        },
      },
    };
    const intent =
      messageId === report.messageId
        ? await this.deletes.prepareReportTargetIntent(input)
        : await this.deletes.ensureReportHistoryIntent(input);

    if (intent.rollout !== 'execute' || !intent.intentId)
      throw new Error('Durable report deletion unavailable');
    await this.prisma.chatReportAction.update({
      where: { id: action.id },
      data: { intentId: intent.intentId },
    });
    if (messageId === report.messageId && wakeTarget)
      await this.deletes.enqueueCurrentIntentWakeupStrict(intent.intentId);
  }

  private async scanHistory(report: ChatReportCase, token: string): Promise<void> {
    const pageStartedAt = performance.now();
    const end = report.decidedAt!;
    const start = new Date(end.getTime() - REPORT_DAY_MS);
    const cursor =
      report.scanCursorCreatedAt && report.scanCursorId
        ? Prisma.sql`AND (created_at, id) > (${report.scanCursorCreatedAt}, ${report.scanCursorId})`
        : Prisma.empty;
    // FLAG: All action workers reserve finite history capacity under one brief database-only lock.
    // Durable unlinked actions count toward pressure and recover before the next page after a crash.
    const messages = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended('reports-history-admission:v1', 0))`;
      const latest = await tx.chatReportCase.findUniqueOrThrow({ where: { id: report.id } });
      if (
        latest.status !== 'RUNNING' ||
        latest.leaseToken !== token ||
        !latest.leaseExpiresAt ||
        latest.leaseExpiresAt <= new Date() ||
        latest.contentVersion !== report.contentVersion ||
        latest.policyRevision !== report.policyRevision ||
        latest.scanCursorId !== report.scanCursorId ||
        latest.scanCursorCreatedAt?.getTime() !== report.scanCursorCreatedAt?.getTime()
      )
        throw new ReportStaleStateError('Состояние сканирования жалобы изменилось.');
      const [pressure] = await tx.$queryRaw<
        Array<{ total: bigint; chat: bigint; bot: bigint }>
      >(Prisma.sql`
        WITH pending AS (
          SELECT report.chat_id, report.origin_bot_id
          FROM chat_report_actions action
          JOIN chat_report_cases report ON report.id = action.case_id
          LEFT JOIN moderation_delete_intents intent ON intent.id = action.intent_id
          WHERE report.status = 'RUNNING' AND action.message_id <> report.message_id
            AND action.receipt_status IS NULL
            AND (intent.id IS NULL OR intent.status NOT IN ('SUCCEEDED', 'ALREADY_ABSENT', 'EXPIRED', 'FAILED_TERMINAL'))
          LIMIT ${HISTORY_GLOBAL_PENDING_LIMIT}
        )
        SELECT COUNT(*) AS total,
          COUNT(*) FILTER (WHERE pending.chat_id = ${report.chatId}) AS chat,
          COUNT(*) FILTER (WHERE pending.origin_bot_id = ${report.originBotId}) AS bot
        FROM pending
    `);
      const pageSize = Math.min(
        HISTORY_PAGE_SIZE,
        HISTORY_GLOBAL_PENDING_LIMIT - Number(pressure?.total ?? 0),
        HISTORY_CHAT_PENDING_LIMIT - Number(pressure?.chat ?? 0),
        HISTORY_BOT_PENDING_LIMIT - Number(pressure?.bot ?? 0),
      );
      if (pageSize <= 0) return [];
      const rows = await tx.$queryRaw<
        Array<{ id: string; created_at: Date; normalized_payload: unknown }>
      >(Prisma.sql`
      SELECT id, created_at, normalized_payload FROM webhook_events
      WHERE normalized_payload->>'type' = 'message_created'
        AND normalized_payload->'message'->>'chatId' = ${report.chatId}
        AND normalized_payload->'message'->>'senderId' = ${report.authorId}
        AND created_at >= ${start} AND created_at <= ${end}
        ${cursor} ORDER BY created_at, id LIMIT ${pageSize}
    `);
      const messageIds = new Set<string>();
      for (const row of rows) {
        const parsed = row.normalized_payload as {
          message?: { messageId?: string; createdAt?: string };
        };
        const message = parsed.message;
        const at = Date.parse(message?.createdAt ?? '');
        if (message?.messageId && at >= start.getTime() && at <= end.getTime())
          messageIds.add(message.messageId);
      }
      if (messageIds.size)
        await tx.chatReportAction.createMany({
          data: [...messageIds].map((messageId) => ({ caseId: report.id, messageId })),
          skipDuplicates: true,
        });
      const last = rows.at(-1);
      await this.updateOwned(
        report,
        token,
        {
          scanComplete: rows.length < pageSize,
          ...(last ? { scanCursorCreatedAt: last.created_at, scanCursorId: last.id } : {}),
        },
        tx,
      );
      return [...messageIds];
    });
    for (const messageId of messages) await this.materialize(report, messageId, token);
    this.telemetry?.record('historyPage', performance.now() - pageStartedAt);
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
    const cancelledResult =
      ['CANCELLED', 'EXPIRED', 'DISMISSED'].includes(summary.status) && summary.deleted > 0
        ? ` Удалено сообщений: ${summary.deleted}.`
        : '';
    const text = `${labels[summary.status]}${cancelledResult}${summary.absent > 0 ? ` Уже отсутствуют: ${summary.absent}.` : ''}${summary.muteApplied ? ` Мут: ${summary.muteHours} ч.` : ''}`;
    if (report.counterMessageId) {
      if (report.counterText !== text) {
        try {
          await this.max.replaceOwnMessage(
            report.chatId,
            report.counterMessageId,
            text,
            undefined,
            { botId: report.originBotId, trafficClass: 'background', timeoutMs: 5000 },
            async () => {
              await this.assertLease(report.id, token);
              await this.state.assertCurrent(report);
            },
          );
        } catch (error) {
          const existing = await this.max.getExactMessageRow(
            report.chatId,
            report.counterMessageId,
            { botId: report.originBotId, timeoutMs: 5000, trafficClass: 'background' },
          );
          if (existing) throw error;
          await this.prisma.chatReportCase.updateMany({
            where: {
              id: report.id,
              leaseToken: token,
              counterMessageId: report.counterMessageId,
              status: report.status,
              contentVersion: report.contentVersion,
              leaseExpiresAt: { gt: new Date() },
            },
            data: {
              counterMessageId: null,
              lastError: 'Счётчик удалён; результат доступен в журнале.',
            },
          });
          return true;
        }
        await this.updateOwned(report, token, { counterText: text });
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
            event: { userId: report.authorId, metadata: { reportCaseId: report.id } },
            executeAt: new Date(Date.now() + settings.deleteBotMessagesDelayMinutes * 60_000),
          });
      }
      return true;
    }
    // FLAG: An attempted send without a receipt is ambiguous. An exact webhook can recover it; never resend.
    if (report.counterSendStartedAt) return true;
    if (REPORT_TERMINAL.includes(report.status)) return true;
    let dispatchStarted = false;
    let sent: { messageId: string };
    try {
      sent = await this.max.sendMessageImmediateWithId(
        report.chatId,
        text,
        {
          messageLink: { type: 'reply', mid: report.messageId },
          beforeSend: async () => {
            await this.assertLease(report.id, token);
            await this.state.assertCurrent(report);
            await this.state.assertPolicy(report);
            const started = await this.prisma.chatReportCase.updateMany({
              where: {
                id: report.id,
                leaseToken: token,
                counterSendStartedAt: null,
                counterMessageId: null,
              },
              data: {
                counterSendStartedAt: new Date(),
                counterText: text,
              },
            });
            if (!started.count)
              throw new ReportStaleStateError(
                'Счётчик жалобы уже создан или состояние изменилось.',
              );
            dispatchStarted = true;
          },
        },
        { botId: report.originBotId, trafficClass: 'background', timeoutMs: 5000 },
      );
    } catch (error) {
      if (dispatchStarted) this.telemetry?.record('counterAmbiguous');
      throw error;
    }
    // FLAG: A confirmed remote receipt may outlive its lease; recover only this exact open send slot.
    await this.prisma.chatReportCase.updateMany({
      where: {
        id: report.id,
        counterMessageId: null,
        counterSendStartedAt: { not: null },
        counterText: text,
      },
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

  private async updateOwned(
    report: ChatReportCase,
    token: string,
    data: Prisma.ChatReportCaseUpdateManyMutationInput,
    db: Pick<Prisma.TransactionClient, 'chatReportCase'> = this.prisma,
  ): Promise<void> {
    const updated = await db.chatReportCase.updateMany({
      where: {
        id: report.id,
        leaseToken: token,
        leaseExpiresAt: { gt: new Date() },
        status: report.status,
        contentVersion: report.contentVersion,
        policyRevision: report.policyRevision,
      },
      data,
    });
    if (!updated.count) throw new ReportStaleStateError('Состояние жалобы изменилось.');
  }
}
