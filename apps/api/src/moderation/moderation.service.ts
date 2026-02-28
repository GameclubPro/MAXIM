import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { MaxUpdate } from '@maxim/contracts';
import { EventType, Operator, SanctionAction, WebhookStatus } from '@prisma/client';
import type { Job } from 'bullmq';
import { MaxClientService } from '../max/max-client.service';
import { PrismaService } from '../prisma/prisma.service';
import type { DuplicateAction, DuplicateDecision, DuplicateHit } from './rule-engine.service';
import { RuleEngineService } from './rule-engine.service';
import { SanctionService } from './sanction.service';
import { maskText } from './text-mask.util';

type ProcessWebhookJob = {
  webhookEventId: string;
};

type ActiveBan = {
  eventId: string;
  issuedAt: Date;
  expiresAt: Date;
  durationHours: number;
};

const DEFAULT_BAN_DURATION_HOURS = 6;

@Injectable()
export class ModerationService {
  private readonly logger = new Logger(ModerationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ruleEngine: RuleEngineService,
    private readonly sanctionService: SanctionService,
    private readonly maxClient: MaxClientService,
  ) {}

  async processWebhookEvent(webhookEventId: string) {
    const webhookEvent = await this.prisma.webhookEvent.findUnique({
      where: { id: webhookEventId },
    });

    if (!webhookEvent) {
      return;
    }

    const update = webhookEvent.normalizedPayload as MaxUpdate;

    try {
      await this.handleUpdate(update);
      await this.prisma.webhookEvent.update({
        where: { id: webhookEvent.id },
        data: {
          status: WebhookStatus.PROCESSED,
          processedAt: new Date(),
          errorMessage: null,
        },
      });
    } catch (error: unknown) {
      await this.prisma.webhookEvent.update({
        where: { id: webhookEvent.id },
        data: {
          status: WebhookStatus.FAILED,
          errorMessage: error instanceof Error ? error.message : 'Unknown error',
        },
      });
      throw error;
    }
  }

  async handleUpdate(update: MaxUpdate) {
    if (!update.message) {
      return;
    }

    if (this.isBotAuthoredMessage(update)) {
      return;
    }

    const { chatId, chatTitle, senderId, senderName, text, createdAt, messageId } = update.message;
    const fallbackTitle = `Chat ${chatId}`;
    const resolvedTitle = chatTitle?.trim() || fallbackTitle;
    const userLabel = this.formatUserLabel(senderName);

    const chat = await this.prisma.chat.upsert({
      where: { id: chatId },
      create: {
        id: chatId,
        title: resolvedTitle,
        settings: {
          create: {},
        },
      },
      update: {
        ...(chatTitle?.trim()
          ? {
              title: chatTitle.trim(),
            }
          : {}),
      },
      include: {
        settings: true,
        domains: true,
      },
    });

    const settings = chat.settings;
    if (!settings) {
      this.logger.warn({ chatId }, 'Chat settings missing after upsert');
      return;
    }

    const activeBan = await this.getActiveBan(chatId, senderId, settings.banDurationHours);
    if (activeBan) {
      await this.handleActiveBanMessage({
        chatId,
        userId: senderId,
        messageId,
        text,
        createdAt,
        ban: activeBan,
      });
      return;
    }

    const detection = await this.ruleEngine.detect({
      chatId,
      userId: senderId,
      text,
      settings,
      domainAllowlist: chat.domains.map((item: { domain: string }) => item.domain),
    });

    const { violations } = detection;
    const hasLinkViolation = violations.some((item) => item.ruleCode === 'LINK_BLOCKED');
    if (!hasLinkViolation && detection.duplicateDecision) {
      await this.handleDuplicateDecision({
        chatId,
        userId: senderId,
        messageId,
        text,
        createdAt,
        decision: detection.duplicateDecision,
        userLabel,
        banDurationHours: settings.banDurationHours,
        duplicateBotMessageEnabled: settings.duplicateBotMessageEnabled,
      });
      return;
    }

    if (!hasLinkViolation && detection.duplicateHit) {
      await this.handleDuplicateHit({
        chatId,
        userId: senderId,
        messageId,
        text,
        createdAt,
        hit: detection.duplicateHit,
        userLabel,
        duplicateBotMessageEnabled: settings.duplicateBotMessageEnabled,
      });
      return;
    }

    if (violations.length === 0) {
      return;
    }

    const topViolation = violations.find((item) => item.ruleCode === 'LINK_BLOCKED') ?? violations[0];
    await this.prisma.violation.create({
      data: {
        chatId,
        userId: senderId,
        ruleCode: topViolation.ruleCode,
        score: topViolation.score,
      },
    });

    const messageAgeMs = Date.now() - new Date(createdAt).getTime();
    const canDeleteMessage = messageAgeMs <= 24 * 60 * 60 * 1000;

    if (canDeleteMessage) {
      await this.maxClient.deleteMessage(chatId, messageId);
      await this.prisma.moderationEvent.create({
        data: {
          chatId,
          userId: senderId,
          messageId,
          eventType: EventType.MESSAGE,
          ruleCode: `${topViolation.ruleCode}_DELETE`,
          action: SanctionAction.DELETE_MESSAGE,
          maskedExcerpt: maskText(text),
          score: topViolation.score,
          operator: Operator.BOT,
          metadata: {
            reason: topViolation.reason,
          },
        },
      });
    } else {
      await this.maxClient.notifyModerators(
        chatId,
        `Нарушение ${topViolation.ruleCode} от ${senderId}, но сообщение старше 24 часов и не может быть удалено`,
      );
    }

    if (topViolation.ruleCode === 'LINK_BLOCKED' && settings.linkBotMessageEnabled) {
      try {
        await this.maxClient.sendMessage(
          chatId,
          this.buildLinkExplanation(userLabel, canDeleteMessage),
        );
      } catch (error: unknown) {
        this.logger.warn(
          {
            chatId,
            userId: senderId,
            messageId,
            error: error instanceof Error ? error.message : 'Unknown error',
          },
          'Failed to send link explanation message',
        );
      }
    }

    let action: SanctionAction = SanctionAction.NONE;
    if (topViolation.ruleCode !== 'LINK_BLOCKED') {
      action = await this.sanctionService.resolveAction({
        chatId,
        userId: senderId,
        warnThreshold: settings.warnThreshold,
        repeatBanWindowDays: settings.repeatBanWindowDays,
      });
      await this.applySanctionAction({
        chatId,
        userId: senderId,
        action,
        userLabel,
        messageId,
        banDurationHours: settings.banDurationHours,
      });
    }

    await this.prisma.moderationEvent.create({
      data: {
        chatId,
        userId: senderId,
        messageId,
        eventType: EventType.MESSAGE,
        ruleCode: topViolation.ruleCode,
        action,
        maskedExcerpt: maskText(text),
        score: topViolation.score,
        operator: Operator.BOT,
        metadata: {
          reason: topViolation.reason,
          action,
          ...(action === SanctionAction.BAN ? { banDurationHours: settings.banDurationHours } : {}),
        },
      },
    });
  }

  private async handleDuplicateDecision(params: {
    chatId: string;
    userId: string;
    messageId: string;
    text: string;
    createdAt: string;
    decision: DuplicateDecision;
    userLabel: string;
    banDurationHours: number;
    duplicateBotMessageEnabled: boolean;
  }) {
    const {
      chatId,
      userId,
      messageId,
      text,
      createdAt,
      decision,
      userLabel,
      banDurationHours,
      duplicateBotMessageEnabled,
    } =
      params;
    const messageAgeMs = Date.now() - new Date(createdAt).getTime();
    const canDeleteMessage = messageAgeMs <= 24 * 60 * 60 * 1000;

    if (canDeleteMessage) {
      try {
        await this.maxClient.deleteMessage(chatId, messageId);
        await this.prisma.moderationEvent.create({
          data: {
            chatId,
            userId,
            messageId,
            eventType: EventType.MESSAGE,
            ruleCode: 'DUPLICATE_DELETE',
            action: SanctionAction.DELETE_MESSAGE,
            maskedExcerpt: maskText(text),
            score: 0.8,
            operator: Operator.BOT,
            metadata: {
              windowSec: decision.windowSec,
              count: decision.count,
              threshold: decision.threshold,
              reason: 'Duplicate message removed',
            },
          },
        });
      } catch (error: unknown) {
        this.logger.warn(
          {
            chatId,
            userId,
            messageId,
            error: error instanceof Error ? error.message : 'Unknown error',
          },
          'Failed to delete duplicate message',
        );
      }
    } else {
      await this.maxClient.notifyModerators(
        chatId,
        `Нарушение DUPLICATE от ${userId}, но сообщение старше 24 часов и не может быть удалено`,
      );
    }

    if (duplicateBotMessageEnabled && decision.action !== 'BAN') {
      try {
        await this.maxClient.sendMessage(
          chatId,
          this.buildDuplicateExplanation(userLabel, decision, banDurationHours),
        );
      } catch (error: unknown) {
        this.logger.warn(
          {
            chatId,
            userId,
            messageId,
            error: error instanceof Error ? error.message : 'Unknown error',
          },
          'Failed to send duplicate explanation message',
        );
      }
    }

    const action = this.toSanctionAction(decision.action);
    await this.applySanctionAction({
      chatId,
      userId,
      action,
      userLabel,
      messageId,
      banDurationHours,
    });

    await this.prisma.moderationEvent.create({
      data: {
        chatId,
        userId,
        messageId,
        eventType: EventType.MESSAGE,
        ruleCode: `DUPLICATE_${decision.action}`,
        action,
        maskedExcerpt: maskText(text),
        score: 0.8,
        operator: Operator.BOT,
        metadata: {
          windowSec: decision.windowSec,
          count: decision.count,
          threshold: decision.threshold,
          nextStep: decision.nextAction,
          ...(action === SanctionAction.BAN ? { banDurationHours } : {}),
        },
      },
    });
  }

  private async handleDuplicateHit(params: {
    chatId: string;
    userId: string;
    messageId: string;
    text: string;
    createdAt: string;
    hit: DuplicateHit;
    userLabel: string;
    duplicateBotMessageEnabled: boolean;
  }) {
    const { chatId, userId, messageId, text, createdAt, hit, userLabel, duplicateBotMessageEnabled } = params;
    const messageAgeMs = Date.now() - new Date(createdAt).getTime();
    const canDeleteMessage = messageAgeMs <= 24 * 60 * 60 * 1000;

    if (canDeleteMessage) {
      try {
        await this.maxClient.deleteMessage(chatId, messageId);
        await this.prisma.moderationEvent.create({
          data: {
            chatId,
            userId,
            messageId,
            eventType: EventType.MESSAGE,
            ruleCode: 'DUPLICATE_DELETE',
            action: SanctionAction.DELETE_MESSAGE,
            maskedExcerpt: maskText(text),
            score: 0.8,
            operator: Operator.BOT,
            metadata: {
              windowSec: hit.windowSec,
              count: hit.count,
              reason: 'Duplicate message removed',
            },
          },
        });
      } catch (error: unknown) {
        this.logger.warn(
          {
            chatId,
            userId,
            messageId,
            error: error instanceof Error ? error.message : 'Unknown error',
          },
          'Failed to delete duplicate message',
        );
      }
    } else {
      await this.maxClient.notifyModerators(
        chatId,
        `Нарушение DUPLICATE от ${userId}, но сообщение старше 24 часов и не может быть удалено`,
      );
    }

    if (duplicateBotMessageEnabled) {
      try {
        await this.maxClient.sendMessage(
          chatId,
          this.buildDuplicateHitExplanation(userLabel, canDeleteMessage),
        );
      } catch (error: unknown) {
        this.logger.warn(
          {
            chatId,
            userId,
            messageId,
            error: error instanceof Error ? error.message : 'Unknown error',
          },
          'Failed to send duplicate explanation message',
        );
      }
    }
  }

  private toSanctionAction(action: DuplicateAction): SanctionAction {
    if (action === 'WARN') {
      return SanctionAction.WARN;
    }
    if (action === 'KICK') {
      return SanctionAction.KICK;
    }
    return SanctionAction.BAN;
  }

  private buildLinkExplanation(userLabel: string, canDeleteMessage: boolean): string {
    if (canDeleteMessage) {
      return `Сообщение пользователя ${userLabel} удалено: ссылки в этом чате запрещены.`;
    }

    return `Сообщение пользователя ${userLabel} нарушает правила: ссылки в этом чате запрещены.`;
  }

  private buildDuplicateExplanation(
    userLabel: string,
    decision: DuplicateDecision,
    banDurationHours: number,
  ): string {
    if (decision.action === 'WARN') {
      return `Сообщение пользователя ${userLabel} удалено за дубли сообщений. Пользователю вынесено предупреждение.`;
    }

    if (decision.action === 'KICK') {
      return `Сообщение пользователя ${userLabel} удалено за дубли сообщений. Пользователь удален из чата.`;
    }

    return `Сообщение пользователя ${userLabel} удалено за дубли сообщений. Пользователю выдан бан на ${this.formatBanDurationLabel(banDurationHours)}.`;
  }

  private buildDuplicateHitExplanation(userLabel: string, canDeleteMessage: boolean): string {
    if (canDeleteMessage) {
      return `Сообщение пользователя ${userLabel} удалено: дубли сообщений в этом чате запрещены.`;
    }

    return `Сообщение пользователя ${userLabel} нарушает правила: дубли сообщений в этом чате запрещены.`;
  }

  private formatUserLabel(senderName?: string): string {
    const normalized = typeof senderName === 'string' ? senderName.trim() : '';
    const safe = normalized.length > 0 ? normalized.replace(/"/g, "'") : 'Пользователь';
    return `"${safe}"`;
  }

  private async applySanctionAction(params: {
    chatId: string;
    userId: string;
    action: SanctionAction;
    userLabel: string;
    messageId: string;
    banDurationHours: number;
  }) {
    const { chatId, userId, action, userLabel, messageId, banDurationHours } = params;
    if (action === SanctionAction.KICK) {
      try {
        await this.maxClient.kickMember(chatId, userId);
      } catch (error: unknown) {
        this.logger.warn(
          {
            chatId,
            userId,
            messageId,
            error: error instanceof Error ? error.message : 'Unknown error',
          },
          'Failed to kick member',
        );
      }
      return;
    }

    if (action !== SanctionAction.BAN) {
      return;
    }

    // Soft-ban mode: do not remove member from chat, enforce ban via active-ban auto-delete window.
    await this.sendBanNotice({
      chatId,
      userId,
      messageId,
      userLabel,
      banDurationHours,
    });
  }

  private async sendBanNotice(params: {
    chatId: string;
    userId: string;
    messageId: string;
    userLabel: string;
    banDurationHours: number;
  }) {
    const { chatId, userId, messageId, userLabel, banDurationHours } = params;
    try {
      await this.maxClient.sendMessage(chatId, this.buildBanNotice(userLabel, banDurationHours));
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          userId,
          messageId,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to send ban notice message',
      );
    }
  }

  private buildBanNotice(userLabel: string, banDurationHours: number): string {
    return `Пользователю ${userLabel} выдан бан на ${this.formatBanDurationLabel(banDurationHours)}.`;
  }

  private async getActiveBan(
    chatId: string,
    userId: string,
    fallbackBanDurationHours: number,
  ): Promise<ActiveBan | null> {
    const latestBan = await this.prisma.moderationEvent.findFirst({
      where: {
        chatId,
        userId,
        action: SanctionAction.BAN,
      },
      orderBy: {
        createdAt: 'desc',
      },
      select: {
        id: true,
        createdAt: true,
        metadata: true,
      },
    });

    if (!latestBan) {
      return null;
    }

    const durationHours = this.readBanDurationHoursFromMetadata(
      latestBan.metadata,
      fallbackBanDurationHours,
    );
    const expiresAt = new Date(latestBan.createdAt.getTime() + durationHours * 60 * 60 * 1000);
    if (expiresAt.getTime() <= Date.now()) {
      return null;
    }

    return {
      eventId: latestBan.id,
      issuedAt: latestBan.createdAt,
      expiresAt,
      durationHours,
    };
  }

  private async handleActiveBanMessage(params: {
    chatId: string;
    userId: string;
    messageId: string;
    text: string;
    createdAt: string;
    ban: ActiveBan;
  }) {
    const { chatId, userId, messageId, text, createdAt, ban } = params;
    const messageAgeMs = Date.now() - new Date(createdAt).getTime();
    const canDeleteMessage = messageAgeMs <= 24 * 60 * 60 * 1000;

    if (!canDeleteMessage) {
      await this.maxClient.notifyModerators(
        chatId,
        `Сообщение от ${userId} попало под активный бан, но старше 24 часов и не может быть удалено`,
      );
      return;
    }

    try {
      await this.maxClient.deleteMessage(chatId, messageId);
      await this.prisma.moderationEvent.create({
        data: {
          chatId,
          userId,
          messageId,
          eventType: EventType.MESSAGE,
          ruleCode: 'BAN_ACTIVE_DELETE',
          action: SanctionAction.DELETE_MESSAGE,
          maskedExcerpt: maskText(text),
          score: 1,
          operator: Operator.BOT,
          metadata: {
            reason: 'Message removed during active ban window',
            banEventId: ban.eventId,
            banIssuedAt: ban.issuedAt.toISOString(),
            banExpiresAt: ban.expiresAt.toISOString(),
            banDurationHours: ban.durationHours,
          },
        },
      });
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          userId,
          messageId,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to delete message during active ban',
      );
    }
  }

  private isBotAuthoredMessage(update: MaxUpdate): boolean {
    const raw = this.asRecord(update.raw);
    const message = this.asRecord(raw?.message);
    const candidates = [
      this.asRecord(message?.sender),
      this.asRecord(message?.from),
      this.asRecord(raw?.sender),
      this.asRecord(raw?.from),
    ].filter((item): item is Record<string, unknown> => item !== null);

    for (const sender of candidates) {
      const type = this.readLowerString(sender.type) ?? this.readLowerString(sender.kind);
      if (type === 'bot' || type === 'service') {
        return true;
      }

      if (
        sender.is_bot === true ||
        sender.isBot === true ||
        sender.bot === true ||
        sender.is_service === true ||
        sender.isService === true
      ) {
        return true;
      }
    }

    return false;
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }

  private readLowerString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim().toLowerCase() : null;
  }

  private readBanDurationHoursFromMetadata(metadata: unknown, fallback: number): number {
    if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
      const value = (metadata as Record<string, unknown>).banDurationHours;
      if (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 36) {
        return value;
      }
    }

    if (Number.isInteger(fallback) && fallback >= 1 && fallback <= 36) {
      return fallback;
    }

    return DEFAULT_BAN_DURATION_HOURS;
  }

  private formatBanDurationLabel(hours: number): string {
    const safeHours =
      Number.isInteger(hours) && hours >= 1 && hours <= 36 ? hours : DEFAULT_BAN_DURATION_HOURS;
    return `${safeHours}ч`;
  }
}

@Processor('moderation', {
  concurrency: 10,
})
export class ModerationProcessor extends WorkerHost {
  constructor(private readonly moderationService: ModerationService) {
    super();
  }

  async process(job: Job<ProcessWebhookJob>) {
    await this.moderationService.processWebhookEvent(job.data.webhookEventId);
  }
}
