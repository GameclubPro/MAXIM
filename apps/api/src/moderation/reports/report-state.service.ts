import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MaxClientService } from '../../max/max-client.service';
import { MaxBotLinkService } from '../../max/max-bot-link.service';
import { Prisma, type ChatReportCase } from '../../prisma/prisma-client';
import { PrismaService } from '../../prisma/prisma.service';
import { WebhookParser } from '../../webhook/webhook.parser';
import {
  isEligibleReporter,
  record,
  REPORT_DAY_MS,
  ReportRejectedError,
  ReportStaleStateError,
  reportContentHash,
} from './report.util';

@Injectable()
export class ReportStateService {
  private readonly parser = new WebhookParser();
  constructor(
    readonly prisma: PrismaService,
    private readonly max: MaxClientService,
    private readonly bots: MaxBotLinkService,
    private readonly config: ConfigService,
  ) {}

  enabled(chatId: string): boolean {
    const mode = this.config.get<string>('PARTICIPANT_REPORTS_MODE') ?? 'off';
    return (
      mode === 'on' ||
      (mode === 'canary' &&
        (this.config.get<string>('PARTICIPANT_REPORTS_CANARY_CHAT_IDS') ?? '')
          .split(',')
          .map((s) => s.trim())
          .includes(chatId))
    );
  }

  async settings(chatId: string) {
    return this.prisma.chatSettings.findUnique({
      where: { chatId },
      include: { chat: { select: { entityType: true, admins: { select: { userId: true } } } } },
    });
  }

  botIdFromSender(userId: unknown): string | null {
    return typeof userId === 'string' || typeof userId === 'number'
      ? this.bots.resolveBotIdFromUserId(userId)
      : null;
  }

  async executionBotId(chatId: string): Promise<string> {
    const botId = await this.bots.resolveBotIdForMemberAccess({ chatId });
    if (!botId) throw new Error('No available bot can verify the report in this chat');
    return botId;
  }

  async source(chatId: string, messageId: string, botId: string) {
    const readStartedAt = new Date();
    const row = await this.max.getExactMessageRow(chatId, messageId, {
      botId,
      bypassCache: true,
      timeoutMs: 5000,
      trafficClass: 'critical',
    });
    if (!row) return null;
    const message = this.parser.parse({ update_type: 'message_created', message: row }).message;
    if (
      !message ||
      message.chatId !== chatId ||
      message.messageId !== messageId ||
      message.entityType === 'channel' ||
      record(row.sender).is_bot !== false
    )
      throw new ReportRejectedError('Не удалось подтвердить исходное сообщение.');
    const createdAt = new Date(message.createdAt);
    if (!Number.isFinite(createdAt.getTime()))
      throw new ReportRejectedError('Неизвестно время сообщения.');
    return { authorId: message.senderId, createdAt, hash: reportContentHash(row), readStartedAt };
  }

  async assertAuthor(chatId: string, userId: string, botId: string): Promise<void> {
    await this.assertLocalAuthor(chatId, userId);
    const member = await this.max.getChatMemberAccess(chatId, userId, {
      botId,
      bypassCache: true,
      timeoutMs: 5000,
      trafficClass: 'critical',
    });
    if (
      !member ||
      member.userId !== userId ||
      member.isBot !== false ||
      member.isAdmin ||
      member.isOwner
    )
      throw new ReportRejectedError('Не удалось подтвердить возможность модерации участника.');
    await this.assertLocalAuthor(chatId, userId);
  }

  async assertLocalAuthor(
    chatId: string,
    userId: string,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<void> {
    if (this.bots.isKnownBotUserId(userId))
      throw new ReportRejectedError('Жалобы на ботов не принимаются.');
    const settings = await db.chatSettings.findUnique({
      where: { chatId },
      select: { chat: { select: { entityType: true, admins: { select: { userId: true } } } } },
    });
    if (
      !settings ||
      settings.chat.entityType !== 'CHAT' ||
      settings.chat.admins.some((a) => a.userId === userId)
    )
      throw new ReportRejectedError('Участник защищён от жалоб.');
    const immunity = await db.chatParticipantModerationImmunity.findFirst({
      where: { chatId, userId, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
      select: { id: true },
    });
    if (immunity) throw new ReportRejectedError('Участник защищён от жалоб.');
  }

  async hasActiveSanction(
    chatId: string,
    userId: string,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<boolean> {
    const event = await db.moderationEvent.findFirst({
      where: {
        chatId,
        userId,
        OR: [
          { action: { in: ['MUTE', 'BAN'] } },
          { ruleCode: { in: ['MANUAL_UNMUTE', 'MANUAL_UNBAN'] } },
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { action: true, ruleCode: true, metadata: true, createdAt: true },
    });
    if (!event || ['MANUAL_UNMUTE', 'MANUAL_UNBAN'].includes(event.ruleCode)) return false;
    const metadata = record(event.metadata);
    if (metadata.sanctionApplied === false) return false;
    if (metadata.mutePermanent === true) return true;
    if (event.action === 'BAN' && typeof metadata.muteDurationHours !== 'number') return true;
    const duration =
      typeof metadata.muteDurationHours === 'number'
        ? metadata.muteDurationHours
        : ((
            await db.chatSettings.findUnique({
              where: { chatId },
              select: { muteDurationHours: true },
            })
          )?.muteDurationHours ?? 6);
    return event.createdAt.getTime() + duration * 3_600_000 > Date.now();
  }

  async assertCase(id: string, botId: string, checkSource = true): Promise<ChatReportCase> {
    const report = await this.prisma.chatReportCase.findUniqueOrThrow({ where: { id } });
    await this.assertPolicy(report);
    if (!['PENDING', 'RUNNING'].includes(report.status) || !report.decidedAt)
      throw new ReportRejectedError('Сбор жалоб закрыт.');
    await this.assertAuthor(report.chatId, report.authorId, botId);
    if (checkSource) {
      const source = await this.source(report.chatId, report.messageId, botId);
      if (!source || source.hash !== report.contentHash || source.authorId !== report.authorId)
        throw new ReportRejectedError('Исходное сообщение удалено или изменено.');
    }
    // FLAG: Remote checks cannot authorize a cancelled case or another content revision.
    const current = await this.assertCurrent(report, ['PENDING', 'RUNNING']);
    await this.assertPolicy(current);
    return current;
  }

  async assertCurrent(
    report: ChatReportCase,
    statuses: readonly string[] = [report.status],
  ): Promise<ChatReportCase> {
    const current = await this.prisma.chatReportCase.findUnique({ where: { id: report.id } });
    if (
      !current ||
      !statuses.includes(current.status) ||
      current.contentVersion !== report.contentVersion ||
      current.contentHash !== report.contentHash ||
      current.policyRevision !== report.policyRevision ||
      current.authorId !== report.authorId ||
      current.messageId !== report.messageId ||
      current.decidedAt?.getTime() !== report.decidedAt?.getTime()
    ) {
      throw new ReportStaleStateError('Состояние жалобы изменилось; требуется повторная проверка.');
    }
    return current;
  }

  async assertPolicy(report: ChatReportCase): Promise<void> {
    const settings = await this.prisma.chatSettings.findUnique({
      where: { chatId: report.chatId },
      select: {
        reportsEnabled: true,
        reportsRevision: true,
        chat: { select: { entityType: true } },
      },
    });
    if (
      !this.enabled(report.chatId) ||
      !settings?.reportsEnabled ||
      settings.chat.entityType !== 'CHAT' ||
      settings.reportsRevision !== report.policyRevision
    )
      throw new ReportRejectedError('Модуль выключен или настройки изменены.');
    if (report.decidedAt && Date.now() >= report.decidedAt.getTime() + REPORT_DAY_MS)
      throw new ReportRejectedError('Истёк срок исполнения жалобы.');
  }

  async assertVoters(report: ChatReportCase, botId: string): Promise<void> {
    const votes = await this.prisma.chatReportVote.findMany({
      where: { caseId: report.id, contentVersion: report.contentVersion },
      orderBy: { createdAt: 'asc' },
      take: 6,
    });
    const members = await this.max.getChatMembersAccess(
      report.chatId,
      votes.map((v) => v.reporterId),
      { botId, bypassCache: true, timeoutMs: 5000, trafficClass: 'critical' },
    );
    let count = 0;
    for (const vote of votes) {
      if (
        isEligibleReporter(
          members.get(vote.reporterId),
          vote.reporterId,
          vote.createdAt.getTime(),
        ) &&
        !(await this.hasActiveSanction(report.chatId, vote.reporterId))
      )
        count++;
    }
    if (count < report.threshold)
      throw new ReportRejectedError('Недостаточно действующих голосов.');
  }

  async transaction<T>(
    chatId: string,
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      // FLAG: One chat-wide transaction serializes both per-message votes and per-reporter limits.
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${`reports:${chatId}`}, 0))`;
      await tx.$queryRaw`SELECT id FROM chat_settings WHERE chat_id = ${chatId} FOR SHARE`;
      return operation(tx);
    });
  }
}
