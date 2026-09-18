import { Injectable } from '@nestjs/common';
import { REPORT_DEFAULT_TRIGGERS, type MaxUpdate, type ReportSettings } from '@maxim/contracts';
import { MaxClientService } from '../../max/max-client.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ModerationDeleteIntentService } from '../moderation-delete-intent.service';
import { RedisCounterService } from '../redis-counter.service';
import { extractRawMessageNode } from '../moderation-update-extractors';
import { ReportStateService } from './report-state.service';
import {
  isEligibleReporter,
  record,
  REPORT_COMMAND_RULE,
  REPORT_DAY_MS,
  ReportRejectedError,
  reportReplyTarget,
  reportContentHash,
} from './report.util';

@Injectable()
export class ReportSubmissionService {
  constructor(
    private readonly state: ReportStateService,
    private readonly prisma: PrismaService,
    private readonly max: MaxClientService,
    private readonly deletes: ModerationDeleteIntentService,
    private readonly redis: RedisCounterService,
  ) {}

  isCommand(
    update: MaxUpdate,
    settings: Pick<ReportSettings, 'reportsEnabled' | 'reportsAliases'>,
  ): boolean {
    return Boolean(
      update.message &&
      this.state.enabled(update.message.chatId) &&
      reportReplyTarget(update, settings),
    );
  }

  async handle(
    update: MaxUpdate,
    settings: Pick<ReportSettings, 'reportsEnabled' | 'reportsAliases'>,
  ): Promise<boolean> {
    const message = update.message;
    if (!message || message.entityType === 'channel') return false;
    if (update.type === 'message_edited') {
      return false;
    }
    if (
      !settings.reportsEnabled ||
      update.type !== 'message_created' ||
      ![...REPORT_DEFAULT_TRIGGERS, ...settings.reportsAliases].includes(
        message.text.trim().toLowerCase(),
      )
    )
      return false;
    const botId = update.botId;
    if (!botId) return false;
    try {
      if (!this.state.enabled(message.chatId))
        throw new ReportRejectedError('Модуль жалоб временно недоступен.');
      const targetId = reportReplyTarget(update, settings);
      if (!targetId) {
        await this.feedback(
          update,
          'Жалоба принимается только ответом без вложений на сообщение участника.',
        );
        return false;
      }
      const source = await this.state.source(message.chatId, targetId, botId);
      if (!source) throw new ReportRejectedError('Исходное сообщение уже удалено.');
      if (source.authorId === message.senderId)
        throw new ReportRejectedError('Нельзя пожаловаться на своё сообщение.');
      const now = new Date();
      if (
        source.createdAt.getTime() > now.getTime() ||
        source.createdAt.getTime() + REPORT_DAY_MS <= now.getTime()
      )
        throw new ReportRejectedError('Жалобы принимаются на сообщения не старше суток.');
      const member = await this.max.getChatMemberAccess(message.chatId, message.senderId, {
        botId,
        bypassCache: true,
        timeoutMs: 5000,
        trafficClass: 'interactive',
      });
      if (!isEligibleReporter(member, message.senderId, now.getTime()))
        throw new ReportRejectedError('Для жалобы нужно быть участником чата не менее суток.');
      if (await this.state.hasActiveSanction(message.chatId, message.senderId))
        throw new ReportRejectedError('Во время мута жалобы не учитываются.');
      await this.state.assertAuthor(message.chatId, source.authorId, botId);
      const report = await this.state.transaction(message.chatId, async (tx) => {
        const acceptedAt = new Date();
        const policy = await tx.chatSettings.findUniqueOrThrow({
          where: { chatId: message.chatId },
        });
        if (!policy.reportsEnabled || !this.state.enabled(message.chatId))
          throw new ReportRejectedError('Модуль жалоб выключен.');
        const where = { chatId_messageId: { chatId: message.chatId, messageId: targetId } };
        let current = await tx.chatReportCase.findUnique({ where });
        if (current && !['COLLECTING', 'PENDING'].includes(current.status))
          throw new ReportRejectedError('Сбор жалоб по этому сообщению уже закрыт.');
        if (current && current.policyRevision !== policy.reportsRevision) {
          await tx.chatReportCase.update({ where, data: { status: 'CANCELLED', dueAt: now } });
          return null;
        }
        if (current && current.contentHash !== source.hash)
          current = await tx.chatReportCase.update({
            where,
            data: {
              contentHash: source.hash,
              contentVersion: { increment: 1 },
              status: 'COLLECTING',
              decidedAt: null,
              dueAt: now,
            },
          });
        if (!current)
          current = await tx.chatReportCase.create({
            data: {
              chatId: message.chatId,
              messageId: targetId,
              authorId: source.authorId,
              originBotId: botId,
              contentHash: source.hash,
              policyRevision: policy.reportsRevision,
              messageCreatedAt: source.createdAt,
              expiresAt: new Date(source.createdAt.getTime() + REPORT_DAY_MS),
              threshold: policy.reportsThreshold,
              deleteMode: policy.reportsDeleteMode,
              muteHours: policy.reportsMuteEnabled ? policy.reportsMuteDurationHours : null,
            },
          });
        if (current.expiresAt <= acceptedAt)
          throw new ReportRejectedError('Срок сбора жалоб истёк.');
        const duplicate = await tx.chatReportVote.findFirst({
          where: {
            OR: [
              {
                caseId: current.id,
                contentVersion: current.contentVersion,
                reporterId: message.senderId,
              },
              { chatId: message.chatId, commandMessageId: message.messageId },
            ],
          },
        });
        if (!duplicate && current.status === 'COLLECTING') {
          const recent = await tx.chatReportVote.groupBy({
            by: ['caseId'],
            where: {
              chatId: message.chatId,
              reporterId: message.senderId,
              createdAt: { gt: new Date(now.getTime() - 3_600_000) },
            },
          });
          if (!recent.some((v) => v.caseId === current!.id) && recent.length >= 10)
            throw new ReportRejectedError('Лимит: десять жалоб на разные сообщения за час.');
          await tx.chatReportVote.create({
            data: {
              caseId: current.id,
              contentVersion: current.contentVersion,
              chatId: message.chatId,
              reporterId: message.senderId,
              commandMessageId: message.messageId,
            },
          });
          const count = await tx.chatReportVote.count({
            where: { caseId: current.id, contentVersion: current.contentVersion },
          });
          current = await tx.chatReportCase.update({
            where,
            data: {
              ...(count >= current.threshold ? { status: 'PENDING', decidedAt: acceptedAt } : {}),
              dueAt: acceptedAt,
            },
          });
        }
        return current;
      });
      if (!report) throw new ReportRejectedError('Настройки изменены; прежний сбор жалоб отменён.');
      await this.deletes.ensureIntent({
        chatId: message.chatId,
        messageId: message.messageId,
        reasonKey: `report-command:${report.id}:${message.messageId}`,
        ruleCode: REPORT_COMMAND_RULE,
        subjectUserId: message.senderId,
        originBotId: botId,
        messageAuthorKind: 'user',
        entityType: 'CHAT',
        routingPolicy: 'delete_capable',
        retryUntilAt: report.expiresAt,
        event: {
          userId: message.senderId,
          metadata: { reportCaseId: report.id, commandCleanup: true, commandText: message.text },
        },
      });
      return true;
    } catch (error) {
      if (error instanceof ReportRejectedError) {
        await this.feedback(update, error.message);
        return true;
      }
      // A transient lookup/storage failure leaves the webhook retryable and never records a vote optimistically.
      throw error;
    }
  }

  async observeEdit(update: MaxUpdate): Promise<void> {
    if (!update.message) return;
    const node = extractRawMessageNode(record(update.raw));
    if (!node) return;
    const hash = reportContentHash(node);
    await this.state.transaction(update.message.chatId, async (tx) => {
      const report = await tx.chatReportCase.findUnique({
        where: {
          chatId_messageId: {
            chatId: update.message!.chatId,
            messageId: update.message!.messageId,
          },
        },
      });
      if (
        !report ||
        report.contentHash === hash ||
        !['COLLECTING', 'PENDING'].includes(report.status)
      )
        return;
      await tx.chatReportCase.update({
        where: { id: report.id },
        data: {
          contentHash: hash,
          contentVersion: { increment: 1 },
          status: 'COLLECTING',
          decidedAt: null,
          dueAt: new Date(),
        },
      });
    });
  }

  async ownsCounter(
    chatId: string,
    messageId: string,
    text: string,
    botId: string,
  ): Promise<boolean> {
    return Boolean(
      await this.prisma.chatReportCase.findFirst({
        where: {
          chatId,
          originBotId: botId,
          OR: [
            { counterMessageId: messageId },
            { counterMessageId: null, counterSendStartedAt: { not: null }, counterText: text },
          ],
        },
        select: { id: true },
      }),
    );
  }

  private async feedback(update: MaxUpdate, text: string): Promise<void> {
    const message = update.message;
    if (!message || !update.botId) return;
    const admitted = await this.redis.setStringIfAbsentWithTtl(
      `reports:feedback:${message.chatId}:${message.senderId}`,
      '1',
      60,
    );
    if (!admitted) return;
    await this.max.sendMessage(
      message.chatId,
      text,
      { messageLink: { type: 'reply', mid: message.messageId } },
      { botId: update.botId, trafficClass: 'interactive' },
    );
  }
}
